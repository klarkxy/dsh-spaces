import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { test } from "node:test";
import {
  AlignmentArchiveError,
  alignmentArchiveId,
  cliLoadError,
  dshPeerRangesFromPayload,
  isAlignmentArchiveId,
  unmetDshPeers,
  unmetInstalledThirdPartyDshPeers,
} from "../src/adapters/node/component-cli.ts";

test("component peers reject an older CLI and accept the alpha release", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-cli-peers-"));
  const lib = join(root, "lib");
  mkdirSync(join(lib, "view-bridge"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@dsh-spaces/plugin",
    peerDependencies: { "@deepseek-ai/dsh-client-connection": "^0.1.7-alpha.1", zod: "^4.4.3" },
  }));
  writeFileSync(join(lib, "view-bridge", "package.json"), JSON.stringify({
    name: "@dsh-spaces/view-bridge",
    peerDependencies: { "@deepseek-ai/dsh-settings": "^0.1.7-alpha.1" },
  }));
  try {
    const ranges = dshPeerRangesFromPayload(lib);
    assert.equal(ranges.zod, undefined);
    const unmet = unmetDshPeers("0.1.5-rc.2", ranges);
    assert.ok(unmet.some(row => row.includes("dsh-settings")));
    assert.equal(unmetDshPeers("0.1.7-alpha.1", ranges).length, 0);
    assert.match(cliLoadError("0.1.5-rc.2", unmet), /0\.1\.5-rc\.2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed third-party peers follow declared and enabled manifests", () => {
  const profile = mkdtempSync(join(tmpdir(), "dsh-third-party-peers-"));
  const place = (name: string, options: { declared?: boolean; enabled?: boolean; peers?: Record<string, unknown>; omit?: boolean; raw?: string }) => {
    rmSync(join(profile, "node_modules"), { recursive: true, force: true });
    const manifest: { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } } = {
      dependencies: { "@deepseek-ai/dsh-base": "1.0.0", "@dsh-spaces/view-bridge": "0.4.0" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@dsh-spaces/view-bridge"] } },
    };
    if (options.declared !== false) manifest.dependencies[name] = "1.0.0";
    if (options.enabled) manifest.dsh.profile.bundles.push(name);
    writeFileSync(join(profile, "package.json"), JSON.stringify(manifest));
    if (options.omit) return;
    const dir = join(profile, "node_modules", ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), options.raw ?? JSON.stringify({
      name,
      version: "1.0.0",
      peerDependencies: options.peers ?? { "@deepseek-ai/dsh": "<0.1.0" },
    }));
  };
  try {
    place("acceptance-peer-fixture", { peers: { "@deepseek-ai/dsh": "<0.1.0" } });
    assert.deepEqual(unmetInstalledThirdPartyDshPeers(profile, "0.2.1-alpha.2"), [
      "acceptance-peer-fixture (@deepseek-ai/dsh@<0.1.0)",
    ]);
    place("acceptance-peer-fixture", { enabled: true, peers: { "@deepseek-ai/dsh": "workspace:*" } });
    assert.deepEqual(unmetInstalledThirdPartyDshPeers(profile, "0.2.1-alpha.2"), []);
    place("acceptance-peer-fixture", {
      enabled: true,
      peers: { "@deepseek-ai/dsh": ">=0.2.1-alpha.2", react: "^19.0.0" },
    });
    assert.deepEqual(unmetInstalledThirdPartyDshPeers(profile, "0.2.1-alpha.2"), []);
    place("enabled-only-peer", {
      declared: false,
      enabled: true,
      peers: { "@deepseek-ai/dsh-client-connection": "<0.1.0" },
    });
    assert.deepEqual(unmetInstalledThirdPartyDshPeers(profile, "0.2.1-alpha.2"), [
      "enabled-only-peer (@deepseek-ai/dsh-client-connection@<0.1.0)",
    ]);
    place("acceptance-peer-fixture", { omit: true });
    const official = join(profile, "node_modules", "@deepseek-ai", "dsh-base");
    mkdirSync(official, { recursive: true });
    writeFileSync(join(official, "package.json"), JSON.stringify({
      peerDependencies: { "@deepseek-ai/dsh": "<0.1.0" },
    }));
    assert.deepEqual(unmetInstalledThirdPartyDshPeers(profile, "0.2.1-alpha.2"), []);
    place("acceptance-peer-fixture", { raw: "{" });
    assert.throws(() => unmetInstalledThirdPartyDshPeers(profile, "0.2.1-alpha.2"), /could not be read/);
    place("acceptance-peer-fixture", { raw: JSON.stringify({ peerDependencies: [] }) });
    assert.throws(() => unmetInstalledThirdPartyDshPeers(profile, "0.2.1-alpha.2"), /invalid DSH peerDependencies/);
    writeFileSync(join(profile, "package.json"), JSON.stringify({ dependencies: { "../outside": "1.0.0" } }));
    assert.throws(() => unmetInstalledThirdPartyDshPeers(profile, "0.2.1-alpha.2"), /not a package name/);
    assert.equal(existsSync(join(profile, "outside")), false);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test("alignment archive id toggles only a same-file coordinate and rejects a bad manifest", () => {
  const profile = mkdtempSync(join(tmpdir(), "dsh-align-id-"));
  const canonicalId = "dsh-spaces-plugin-" + "a".repeat(20);
  const revisionId = `${canonicalId}-r1`;
  const canonical = join(profile, "hub", `${canonicalId}.tgz`);
  const declared = `file:${canonical.replaceAll("\\", "/")}`;
  const installed = join(profile, "node_modules", "@dsh-spaces", "plugin", "package.json");
  try {
    assert.equal(alignmentArchiveId(profile, canonicalId, canonical), canonicalId);
    assert.equal(isAlignmentArchiveId(canonicalId), true);
    assert.equal(isAlignmentArchiveId(revisionId), true);
    assert.throws(() => alignmentArchiveId(profile, "dsh-spaces-plugin-short", canonical), AlignmentArchiveError);
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "package.json"), "{");
    assert.throws(() => alignmentArchiveId(profile, canonicalId, canonical), /could not be read/);
    writeFileSync(join(profile, "package.json"), JSON.stringify({ dependencies: null }));
    assert.throws(() => alignmentArchiveId(profile, canonicalId, canonical), /could not be read/);
    writeFileSync(join(profile, "package.json"), JSON.stringify({ dependencies: { "@dsh-spaces/plugin": 1 } }));
    assert.throws(() => alignmentArchiveId(profile, canonicalId, canonical), /could not be read/);
    writeFileSync(join(profile, "package.json"), JSON.stringify({ dependencies: {} }));
    assert.equal(alignmentArchiveId(profile, canonicalId, canonical), canonicalId);
    writeFileSync(join(profile, "package.json"), JSON.stringify({
      dependencies: { "@dsh-spaces/plugin": "0.2.0" },
    }));
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, JSON.stringify({ name: "@dsh-spaces/plugin", version: "0.2.0" }));
    assert.equal(alignmentArchiveId(profile, canonicalId, canonical), canonicalId);
    writeFileSync(join(profile, "package.json"), JSON.stringify({
      name: "dsh-profile",
      dependencies: { "@dsh-spaces/plugin": declared },
    }));
    assert.equal(alignmentArchiveId(profile, canonicalId, canonical), revisionId);
    writeFileSync(join(profile, "package.json"), JSON.stringify({
      dependencies: { "@dsh-spaces/plugin": `file:${canonical}` },
    }));
    assert.equal(alignmentArchiveId(profile, canonicalId, canonical), revisionId);
    const revision = join(profile, "hub", `${revisionId}.tgz`);
    writeFileSync(join(profile, "package.json"), JSON.stringify({
      dependencies: { "@dsh-spaces/plugin": `file:${revision.replaceAll("\\", "/")}` },
    }));
    assert.equal(alignmentArchiveId(profile, canonicalId, canonical), canonicalId);
    rmSync(installed);
    writeFileSync(join(profile, "package.json"), JSON.stringify({
      dependencies: { "@dsh-spaces/plugin": declared },
    }));
    assert.equal(alignmentArchiveId(profile, canonicalId, canonical), revisionId);
    const relativeSpec = "file:" + relative(profile, canonical).replaceAll("\\", "/");
    writeFileSync(join(profile, "package.json"), JSON.stringify({
      dependencies: { "@dsh-spaces/plugin": relativeSpec },
    }));
    assert.equal(alignmentArchiveId(profile, canonicalId, canonical), revisionId);
    writeFileSync(join(profile, "package.json"), JSON.stringify({
      dependencies: { "@dsh-spaces/plugin": "file:./" + relative(profile, canonical).replaceAll("\\", "/") },
    }));
    assert.equal(alignmentArchiveId(profile, canonicalId, canonical), revisionId);
    const spelled = ["..", basename(profile), relative(profile, canonical).replaceAll("\\", "/")].join("/");
    writeFileSync(join(profile, "package.json"), JSON.stringify({
      dependencies: { "@dsh-spaces/plugin": "file:" + spelled },
    }));
    assert.equal(alignmentArchiveId(profile, canonicalId, canonical), revisionId);
    writeFileSync(join(profile, "package.json"), JSON.stringify({
      dependencies: { "@dsh-spaces/plugin": "file:../outside.tgz" },
    }));
    assert.equal(alignmentArchiveId(profile, canonicalId, canonical), canonicalId);
    assert.equal(existsSync(join(profile, "outside.tgz")), false);
    assert.equal(existsSync(join(dirname(profile), "outside.tgz")), false);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
