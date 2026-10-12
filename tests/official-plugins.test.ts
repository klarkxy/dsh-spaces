import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  OFFICIAL_BASE_PACKAGE,
  OFFICIAL_WEB_PACKAGE,
  packageVersionAt,
  resolveOfficialVersions,
  usedOfficial,
} from "../src/adapters/node/official-plugins.ts";

const BASE = OFFICIAL_BASE_PACKAGE;
const WEB = OFFICIAL_WEB_PACKAGE;

test("resolveOfficialVersions uses realpath and createRequire, and refuses range-only manifests", (t) => {
  const root = fakeDir(t, "dsh-cli-");
  const bin = writeCandidate(root, "0.9.9", "0.2.0", "0.2.1");
  const linked = join(root, "alias-bin.js");
  try {
    symlinkSync(resolve(bin), linked, "file");
    const official = resolveOfficialVersions(linked);
    assert.equal(official.base, "0.2.0");
    assert.equal(official.web, "0.2.1");
  } catch (err) {
    if (process.platform !== "win32") throw err;
    const official = resolveOfficialVersions(bin);
    assert.equal(official.base, "0.2.0");
    assert.equal(official.web, "0.2.1");
  }

  const rangeOnly = fakeDir(t, "dsh-cli-range-");
  const pkg = join(rangeOnly, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  const rangeBin = join(pkg, "lib", "bin.js");
  writeFileSync(rangeBin, "console.log('dsh')\n");
  writeFileSync(
    join(pkg, "package.json"),
    `${JSON.stringify({
      name: "@deepseek-ai/dsh",
      version: "0.9.9",
      dependencies: { [BASE]: "^0.2.0", [WEB]: "^0.2.1" },
    }, null, 2)}\n`,
  );
  assert.throws(() => resolveOfficialVersions(rangeBin), /does not resolve installed/);
});

test("usedOfficial reads declared deps and bundles only", (t) => {
  const home = fakeDir(t, "dsh-home-");
  const both = writeProfile(home, "both", { [BASE]: "0.2.0" }, [WEB]);
  assert.deepEqual(usedOfficial(both), { base: true, web: true });
  const baseOnly = writeProfile(home, "base-only", { [BASE]: "0.2.0" }, []);
  assert.deepEqual(usedOfficial(baseOnly), { base: true, web: false });
  const neither = writeProfile(home, "neither", { "dsh-outline": "1.2.3" }, []);
  assert.deepEqual(usedOfficial(neither), { base: false, web: false });
});

test("packageVersionAt returns the installed exact version or undefined", (t) => {
  const home = fakeDir(t, "dsh-home-");
  const profile = writeProfile(home, "coding", { [BASE]: "0.2.0" }, []);
  const installed = join(profile, "node_modules", "@deepseek-ai", "dsh-base");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "package.json"), `${JSON.stringify({ name: BASE, version: "0.2.0" })}\n`);
  assert.equal(packageVersionAt(profile, BASE), "0.2.0");
  assert.equal(packageVersionAt(profile, WEB), undefined);
  const stale = join(profile, "node_modules", "stale");
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, "package.json"), `${JSON.stringify({ name: "other", version: "0.2.0" })}\n`);
  assert.equal(packageVersionAt(profile, "stale"), undefined);
});

function writeProfile(
  home: string,
  name: string,
  dependencies: Record<string, string>,
  bundles: string[],
): string {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ dependencies, dsh: { profile: { bundles } } }, null, 2)}\n`,
  );
  return dir;
}

function writeCandidate(prefix: string, cli: string, base: string, web: string): string {
  const pkg = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "console.log('dsh')\n");
  writeFileSync(
    join(pkg, "package.json"),
    `${JSON.stringify(
      {
        name: "@deepseek-ai/dsh",
        version: cli,
        dependencies: { [BASE]: `^${base}`, [WEB]: `^${web}` },
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(prefix, "node_modules", "@deepseek-ai", "dsh-base"), { recursive: true });
  writeFileSync(
    join(prefix, "node_modules", "@deepseek-ai", "dsh-base", "package.json"),
    `${JSON.stringify({ name: BASE, version: base }, null, 2)}\n`,
  );
  mkdirSync(join(prefix, "node_modules", "@deepseek-ai", "dsh-web-app"), { recursive: true });
  writeFileSync(
    join(prefix, "node_modules", "@deepseek-ai", "dsh-web-app", "package.json"),
    `${JSON.stringify({ name: WEB, version: web }, null, 2)}\n`,
  );
  return bin;
}

function fakeDir(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    if (!existsSync(dir)) return;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
