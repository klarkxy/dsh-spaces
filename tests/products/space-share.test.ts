import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  buildSpaceShare,
  canonicalNpmInstallSpec,
  exportSpaceArchive,
  parseSpaceShare,
  pluginToShare,
  previewSpaceShare,
} from "../../src/adapters/node/products/space-share.ts";
import { PLUGIN_LIBRARY_FILE } from "../../src/adapters/node/products/plugin-library.ts";
import { packZip, unpackZip } from "../../src/adapters/node/products/space-share-zip.ts";
import type { InstalledPlugin } from "../../src/shared/types.ts";
import { COMPONENT_PAYLOAD_PACKAGES } from "../../src/adapters/node/payload/component-payload.ts";
import { workbenchProductResultSchema } from "../../src/shared/workbench-product-schemas.ts";

const temps: string[] = [];

test("ZIP rejects repeated payload references and malformed ranges before copying data", () => {
  const original = Buffer.from;
  for (const name of ["payload.bin", "directory/"]) {
    const zip = packZip([{name, data: Buffer.alloc(512 * 1024)}]);
    const end = zip.length - 22, centralStart = zip.readUInt32LE(end + 16);
    const central = zip.subarray(centralStart, end), count = 32;
    const footer = Buffer.from(zip.subarray(end));
    footer.writeUInt16LE(count, 8); footer.writeUInt16LE(count, 10);
    footer.writeUInt32LE(central.length * count, 12);
    const repeated = Buffer.concat([zip.subarray(0, centralStart), ...Array(count).fill(central), footer]);
    let copies = 0;
    Buffer.from = ((...args: Parameters<typeof Buffer.from>) => {
      if (Buffer.isBuffer(args[0])) copies++;
      return (original as any)(...args);
    }) as typeof Buffer.from;
    try {
      assert.throws(() => unpackZip(repeated), /too large|overlapping/);
      assert.equal(copies, 0, "untrusted payloads were copied before validation");
    } finally { Buffer.from = original; }
  }
  const zip = packZip([{name: "safe.txt", data: Buffer.from("valid")}]);
  assert.equal(unpackZip(zip, zip.length)[0]?.data.toString(), "valid");
  assert.throws(() => unpackZip(zip, zip.length - 1), /too large/);
  const broken = Buffer.from(zip), central = broken.readUInt32LE(broken.length - 6);
  broken.writeUInt32LE(0xffffffff, central + 20);
  assert.throws(() => unpackZip(broken), /not a zip/);
  const duplicate = packZip([{name: "a", data: Buffer.from("ok")}, {name: "b", data: Buffer.from("ok")}]);
  const start = duplicate.readUInt32LE(duplicate.length - 6);
  duplicate.writeUInt32LE(0, start + 47 + 42);
  duplicate[start + 47 + 46] = "a".charCodeAt(0);
  assert.throws(() => unpackZip(duplicate), /overlapping/);
});

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-space-share-"));
  temps.push(dir);
  return dir;
}

function writeProfile(
  dshHome: string,
  name: string,
  bundles: string[],
  dependencies: Record<string, string>,
  resolved: Record<string, string> = {},
): void {
  const dir = join(dshHome, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      dependencies,
      dsh: { profile: { bundles } },
    }),
  );
  for (const [pkg, version] of Object.entries(resolved)) {
    const pkgDir = join(dir, "node_modules", ...pkg.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version }));
  }
}

const samplePlugins: InstalledPlugin[] = [
  { name: "@deepseek-ai/dsh-base", version: "0.1.5-rc.2", protected: true },
  { name: "@deepseek-ai/dsh-web-app", version: "0.1.5-rc.2", protected: true },
  {
    name: "dsh-outline",
    requestedSpec: "1.2.3",
    resolvedVersion: "1.2.3",
    version: "1.2.3",
    protected: false,
  },
  {
    name: "custom-git",
    requestedSpec: "github:example/custom-git",
    resolvedVersion: null,
    version: null,
    protected: false,
  },
];

test("export records plugin composition and omits host packages", () => {
  const share = buildSpaceShare({
    displayName: "Coding",
    plugins: samplePlugins,
    dshVersion: "0.1.5-rc.2",
  });
  assert.equal(share.manifest.kind, "dsh-space");
  assert.deepEqual(
    share.plugins.map((row) => row.packageName),
    ["dsh-outline", "custom-git"],
  );
  assert.equal(share.plugins[0].source, "npm");
  assert.equal(share.plugins[0].resolvedVersion, "1.2.3");
  assert.equal(share.plugins[1].source, "git");
  assert.equal(share.patch, undefined);
});

test("export omits bundled components even when they are not marked protected", () => {
  assert.equal(pluginToShare({ name: "@dsh-spaces/plugin", requestedSpec: "0.5.0", resolvedVersion: "0.5.0", protected: false }), null);
  for (const name of new Set(Object.entries(COMPONENT_PAYLOAD_PACKAGES).filter(([component])=>component!=="browser").map(([,name])=>name))) {
    assert.equal(pluginToShare({
      name,
      requestedSpec: "file:H:/private-home/hub/components/component.tgz",
      resolvedVersion: "0.4.0",
      protected: false,
    }), null, name);
  }
});

test("export strips nonportable sources without turning local packages into npm installs", async () => {
  const sources = [
    "file:../../private/plugin.tgz",
    "H:\\private-home\\plugin.tgz",
    "H:/private-home/plugin.tgz",
    "/opt/private/plugin.tgz",
    "../private/plugin",
    "https://test-user:test-secret@example.test/plugin.tgz",
    "git+https://test-user:test-secret@example.test/repo.git",
    "git://example.test/repo.git",
    "ssh://test-user@example.test/repo.git",
    "github:example/repo#../../private",
  ];
  const share = buildSpaceShare({
    displayName: "Portable",
    plugins: sources.map((requestedSpec, index) => ({
      name: `local-plugin-${index}`,
      requestedSpec,
      resolvedVersion: "1.2.3",
      version: "1.2.3",
      protected: false,
    })),
  });
  for (const row of share.plugins) {
    assert.equal(row.requestedSpec, undefined);
    assert.equal(row.installSpec, undefined);
    assert.equal(canonicalNpmInstallSpec(row), null);
  }
  const archive = packZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(share.manifest)) },
    { name: "plugins.json", data: Buffer.from(JSON.stringify(share.plugins)) },
  ]);
  const preview = previewSpaceShare(archive);
  assert.deepEqual(preview.unknownSources, share.plugins.map((row) => row.packageName));
  assert.equal(workbenchProductResultSchema.safeParse({
    method: "share.export",
    fileName: "portable.dsh-space.zip",
    archiveBase64: archive.toString("base64"),
    preview,
    observation: { serviceEpoch: "a".repeat(64), expectedRevision: "b".repeat(64) },
  }).success, true);
});

test("public GitHub coordinates remain visible and require manual installation", () => {
  const spec = "github:example/custom-git#release/v1";
  const row = pluginToShare({ name: "custom-git", requestedSpec: spec, resolvedVersion: "1.0.0", protected: false });
  assert.equal(row?.source, "git");
  assert.equal(row?.requestedSpec, spec);
  assert.equal(row?.installSpec, spec);
  assert.equal(canonicalNpmInstallSpec(row!), null);
});

test("export includes optional config only when requested", () => {
  const withConfig = buildSpaceShare({
    displayName: "Coding",
    plugins: samplePlugins,
    patch: "isolation: keep\nuser: setting\n",
    includeConfig: true,
  });
  assert.match(withConfig.patch ?? "", /user: setting/);
  const without = buildSpaceShare({
    displayName: "Coding",
    plugins: samplePlugins,
    patch: "isolation: keep\n",
    includeConfig: false,
  });
  assert.equal(without.patch, undefined);
});

test("exportSpaceArchive round-trips plugin order from a real profile", () => {
  const dir = home();
  writeProfile(
    dir,
    "coding",
    ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-outline"],
    {
      "@deepseek-ai/dsh-base": "0.1.5-rc.2",
      "@deepseek-ai/dsh-web-app": "0.1.5-rc.2",
      "dsh-outline": "1.2.3",
    },
    { "dsh-outline": "1.2.3" },
  );
  const archive = exportSpaceArchive(dir, "coding", { displayName: "Coding" });
  const parsed = parseSpaceShare(archive);
  assert.equal(parsed.manifest.space.displayName, "Coding");
  assert.deepEqual(
    parsed.plugins.map((row) => row.packageName),
    ["dsh-outline"],
  );
  assert.equal(parsed.plugins[0].resolvedVersion, "1.2.3");
});

test("preview lists unknown sources without treating the share as whole-Home recovery", () => {
  const share = buildSpaceShare({ displayName: "Lab", plugins: samplePlugins });
  const preview = previewSpaceShare(packZip([
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(share.manifest)}\n`) },
    { name: "plugins.json", data: Buffer.from(`${JSON.stringify(share.plugins)}\n`) },
  ]));
  assert.deepEqual(preview.unknownSources, ["custom-git"]);
  assert.equal(preview.hasConfig, false);
});






test("npm range requested specs round-trip as exact packageName@version", () => {
  const caret = pluginToShare({
    name: "dsh-outline",
    requestedSpec: "^1.2.3",
    resolvedVersion: "1.2.3",
    version: "1.2.3",
    protected: false,
  });
  assert.equal(caret?.source, "npm");
  assert.equal(caret?.installSpec, "dsh-outline@1.2.3");
  assert.equal(canonicalNpmInstallSpec(caret!), "dsh-outline@1.2.3");
  const tilde = pluginToShare({
    name: "dsh-outline",
    requestedSpec: "~1.2.3",
    resolvedVersion: "1.2.3",
    version: "1.2.3",
    protected: false,
  });
  assert.equal(tilde?.installSpec, "dsh-outline@1.2.3");
});

test("hub file cache specs round-trip only when the library proves an exact npm spec", () => {
  const dir = home();
  mkdirSync(join(dir, "profiles", "coding"), { recursive: true });
  mkdirSync(join(dir, "hub", "plugins"), { recursive: true });
  const tarball = "hub/plugins/dsh-outline@1.2.3.tgz";
  writeFileSync(join(dir, tarball), "fixture");
  const fileSpec = "file:../../hub/plugins/dsh-outline@1.2.3.tgz";
  const proved = pluginToShare(
    {
      name: "dsh-outline",
      requestedSpec: fileSpec,
      resolvedVersion: "1.2.3",
      version: "1.2.3",
      protected: false,
    },
    {
      library: [
        {
          id: "dsh-outline@1.2.3",
          spec: "dsh-outline@1.2.3",
          packageName: "dsh-outline",
          title: "outline",
          source: "catalog",
          tarball,
          downloadedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
      dshHome: dir,
      spaceId: "coding",
    },
  );
  assert.equal(proved?.source, "npm");
  assert.equal(proved?.installSpec, "dsh-outline@1.2.3");
  assert.equal(proved?.requestedSpec, undefined);
  const unproved = pluginToShare({
    name: "dsh-outline",
    requestedSpec: fileSpec,
    resolvedVersion: "1.2.3",
    version: "1.2.3",
    protected: false,
  });
  assert.equal(unproved?.source, "manual");
  assert.equal(unproved?.requestedSpec, undefined);
  assert.equal(unproved?.installSpec, undefined);
  assert.equal(canonicalNpmInstallSpec(unproved!), null);
});

test("exportSpaceArchive keeps bundle order for range and hub-cache plugins", () => {
  const dir = home();
  writeProfile(
    dir,
    "coding",
    ["@deepseek-ai/dsh-base", "alpha-plugin", "beta-plugin"],
    {
      "@deepseek-ai/dsh-base": "0.1.5-rc.2",
      "alpha-plugin": "^1.2.3",
      "beta-plugin": "~2.0.0",
    },
    { "alpha-plugin": "1.2.3", "beta-plugin": "2.0.1" },
  );
  mkdirSync(join(dir, "hub"), { recursive: true });
  writeFileSync(
    join(dir, "hub", PLUGIN_LIBRARY_FILE),
    `${JSON.stringify({
      plugins: [
        {
          id: "alpha-plugin@1.2.3",
          spec: "alpha-plugin@1.2.3",
          packageName: "alpha-plugin",
          title: "alpha",
          source: "catalog",
          downloadedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
    })}\n`,
  );
  const parsed = parseSpaceShare(exportSpaceArchive(dir, "coding", { displayName: "Coding" }));
  assert.deepEqual(
    parsed.plugins.map((row) => row.packageName),
    ["alpha-plugin", "beta-plugin"],
  );
  assert.equal(parsed.plugins[0]?.installSpec, "alpha-plugin@1.2.3");
  assert.equal(parsed.plugins[1]?.installSpec, "beta-plugin@2.0.1");
});






test("Browser shares identify the base release instead of a manual installation of the base package", () => {
  const plugin = { name: COMPONENT_PAYLOAD_PACKAGES.browser, requestedSpec: "file:H:/private/browser.tgz", resolvedVersion: "0.4.0", protected: false };
  assert.equal(pluginToShare(plugin), null);
  const share = buildSpaceShare({ displayName: 'Browser', plugins: [plugin], base: 'browser', baseVersion: '0.4.0', dshVersion: '0.2.1-rc.2' });
  assert.deepEqual(share.manifest.source, { base: 'browser', baseVersion: '0.4.0', dshVersion: '0.2.1-rc.2' });
  assert.deepEqual(share.plugins, []);
});
