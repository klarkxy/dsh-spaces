import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { create as createTar } from "tar";
import {
  BlueprintPackageError,
  prepareBlueprintPackage,
  type BlueprintPackage,
} from "../src/adapters/node/blueprint-package.ts";
import { archiveAbsPath, upsertLibraryEntry } from "../src/adapters/node/plugin-library.ts";
import type { PluginFetcher } from "../src/adapters/node/plugin-ops.ts";

const temps: string[] = [];
const realHome = join(homedir(), ".dsh");

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("fresh npm download verifies the archive and does not use latest", async () => {
  const home = tempHome();
  const tarball = packFixture({
    name: "dsh-blueprint-lib",
    version: "1.2.3",
    scripts: { test: "echo should-not-list" },
  });
  const seen: string[] = [];
  const prepared = await prepareBlueprintPackage(
    home,
    npmPkg("dsh-blueprint-lib", "1.2.3"),
    { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.2.3", tarball, seen) },
  );
  assert.equal(prepared.name, "dsh-blueprint-lib");
  assert.equal(prepared.version, "1.2.3");
  assert.equal(prepared.hasBundle, false);
  assert.equal(prepared.bundlePatch, undefined);
  assert.deepEqual(prepared.lifecycleScripts, []);
  assert.equal(prepared.integrity, sri(tarball));
  assert.equal(
    realpathSync(prepared.archivePath).toLowerCase(),
    realpathSync(archiveAbsPath(home, "dsh-blueprint-lib@1.2.3")).toLowerCase(),
  );
  assert.equal(lstatSync(prepared.archivePath).isFile(), true);
  assert.equal(lstatSync(prepared.archivePath).isSymbolicLink(), false);
  assert.ok(seen.some((url) => url.includes("dsh-blueprint-lib-1.2.3.tgz")));
  assert.equal(seen.some((url) => url.includes("9.9.9")), false);
  assertNoSacredWrites(home);
});

test("cached library hits still re-verify actual bytes and ignore library identity", async () => {
  const home = tempHome();
  const tarball = packFixture({
    name: "dsh-blueprint-lib",
    version: "1.2.3",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  }, { "cordis.patch.yml": "id: demo\n" });
  const first = await prepareBlueprintPackage(
    home,
    npmPkg("dsh-blueprint-lib", "1.2.3"),
    { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.2.3", tarball) },
  );
  assert.equal(first.hasBundle, true);
  assert.equal(first.bundlePatch, "cordis.patch.yml");

  upsertLibraryEntry(home, {
    id: "dsh-blueprint-lib@1.2.3",
    spec: "dsh-blueprint-lib@1.2.3",
    packageName: "imposter-from-library",
    title: "imposter-from-library",
    tarball: relative(home, first.archivePath).replaceAll("\\", "/"),
    source: "manual",
    downloadedAt: new Date(0).toISOString(),
  });

  const second = await prepareBlueprintPackage(
    home,
    npmPkg("dsh-blueprint-lib", "1.2.3"),
    {
      fetchImpl: async () => {
        throw new Error("should use cached tarball");
      },
    },
  );
  assert.equal(second.name, "dsh-blueprint-lib");
  assert.equal(second.version, "1.2.3");
  assert.equal(second.integrity, first.integrity);
  assert.equal(second.archivePath, first.archivePath);
  assert.equal(second.hasBundle, true);
  assert.equal(second.bundlePatch, "cordis.patch.yml");
  assertNoSacredWrites(home);
});

test("declared sha512 matches actual tarball bytes", async () => {
  const home = tempHome();
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  const prepared = await prepareBlueprintPackage(
    home,
    npmPkg("dsh-blueprint-lib", "1.0.0", sri(tarball)),
    { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball) },
  );
  assert.equal(prepared.integrity, sri(tarball));
});

test("declared sha512 mismatch fails immediately without trusting the library", async () => {
  const home = tempHome();
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  const other = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0", description: "other" });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0", sri(other)),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball) },
    ),
    "integrity-mismatch",
  );
});

test("omitted integrity still returns the computed digest and does not mutate the input", async () => {
  const home = tempHome();
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  const pkg = npmPkg("dsh-blueprint-lib", "1.0.0");
  const prepared = await prepareBlueprintPackage(
    home,
    pkg,
    { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball) },
  );
  assert.equal("integrity" in pkg, false);
  assert.equal(prepared.integrity, sri(tarball));
});

test("invalid integrity is rejected before download", async () => {
  const home = tempHome();
  let fetched = false;
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0", "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
      {
        fetchImpl: async () => {
          fetched = true;
          throw new Error("must not fetch");
        },
      },
    ),
    "invalid-integrity",
  );
  assert.equal(fetched, false);
  assert.equal(existsSync(join(home, "hub")), false);
});

test("manifest package name impersonation is rejected without leaking the raw name", async () => {
  const home = tempHome();
  const secretName = join(realHome, "credentials.yaml");
  const tarball = packFixture({ name: secretName, version: "1.0.0" });
  const error = await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball) },
    ),
    "identity-mismatch",
  );
  assertNoLeak(error, secretName, realHome);
});

test("manifest version impersonation is rejected without leaking the raw version", async () => {
  const home = tempHome();
  const secretVersion = "1.0.0; cat ~/.dsh/credentials.yaml";
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: secretVersion });
  const error = await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball) },
    ),
    "identity-mismatch",
  );
  assertNoLeak(error, secretVersion, ".dsh");
});

test("ordinary library without bundle declaration is valid", async () => {
  const home = tempHome();
  const tarball = packFixture({
    name: "left-pad-demo",
    version: "2.0.0",
    dependencies: { leftpad: "1.0.0" },
  });
  const prepared = await prepareBlueprintPackage(
    home,
    npmPkg("left-pad-demo", "2.0.0"),
    { fetchImpl: fixtureFetch("left-pad-demo", "2.0.0", tarball) },
  );
  assert.equal(prepared.hasBundle, false);
  assert.equal(prepared.bundlePatch, undefined);
});

test("declared bundle patch missing from the archive is a real error", async () => {
  const home = tempHome();
  const tarball = packFixture({
    name: "dsh-blueprint-theme",
    version: "1.0.0",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-theme", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-theme", "1.0.0", tarball) },
    ),
    "bundle-patch-missing",
  );
});

test("declared bundle object without patch is a real error", async () => {
  const home = tempHome();
  const tarball = packFixture({
    name: "dsh-blueprint-theme",
    version: "1.0.0",
    dsh: { bundle: {} },
  });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-theme", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-theme", "1.0.0", tarball) },
    ),
    "bundle-patch-missing",
  );
});

test("bundle patch that escapes the package is rejected", async () => {
  const home = tempHome();
  const tarball = packFixture({
    name: "dsh-blueprint-theme",
    version: "1.0.0",
    dsh: { bundle: { patch: "../secret.yml" } },
  }, { "secret.yml": "nope" });
  const error = await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-theme", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-theme", "1.0.0", tarball) },
    ),
    "bundle-patch-invalid",
  );
  assertNoLeak(error, "secret.yml");
});

test("absolute bundle patch is rejected", async () => {
  const home = tempHome();
  const tarball = packFixture({
    name: "dsh-blueprint-theme",
    version: "1.0.0",
    dsh: { bundle: { patch: "/tmp/cordis.patch.yml" } },
  });
  const error = await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-theme", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-theme", "1.0.0", tarball) },
    ),
    "bundle-patch-invalid",
  );
  assertNoLeak(error, "/tmp/");
});

test("lifecycle scripts are identified and not executed", async () => {
  const home = tempHome();
  const probe = join(home, "script-was-executed");
  const tarball = packFixture({
    name: "dsh-blueprint-scripts",
    version: "1.0.0",
    scripts: {
      preinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(probe)}, 'ran')"`,
      install: `node -e "require('fs').writeFileSync(${JSON.stringify(probe)}, 'ran')"`,
      postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(probe)}, 'ran')"`,
      prepare: `node -e "require('fs').writeFileSync(${JSON.stringify(probe)}, 'ran')"`,
      test: "echo ignored",
      prepublishOnly: "echo ignored",
    },
  });
  const prepared = await prepareBlueprintPackage(
    home,
    npmPkg("dsh-blueprint-scripts", "1.0.0"),
    { fetchImpl: fixtureFetch("dsh-blueprint-scripts", "1.0.0", tarball) },
  );
  assert.deepEqual(prepared.lifecycleScripts, ["preinstall", "install", "postinstall", "prepare"]);
  assert.equal(existsSync(probe), false);
  assert.equal(JSON.stringify(prepared.lifecycleScripts).includes("writeFileSync"), false);
});

test("GitHub sources are rejected before any download or Home write", async () => {
  const home = tempHome();
  let fetched = false;
  const error = await assertRejects(
    prepareBlueprintPackage(
      home,
      {
        name: "dsh-blueprint-lib",
        version: "1.0.0",
        source: { type: "github", repository: "example/dsh-blueprint-lib", commit: "a".repeat(40) },
      },
      {
        fetchImpl: async () => {
          fetched = true;
          throw new Error("must not fetch");
        },
      },
    ),
    "github-unsupported",
  );
  assert.equal(fetched, false);
  assert.equal(existsSync(join(home, "hub")), false);
  assert.equal(existsSync(join(home, "profiles")), false);
  assertNoLeak(error, realHome);
});

test("latest and ranges are rejected without fetching", async () => {
  const home = tempHome();
  let fetched = false;
  const fetchImpl: PluginFetcher = async () => {
    fetched = true;
    throw new Error("must not fetch");
  };
  await assertRejects(
    prepareBlueprintPackage(home, npmPkg("dsh-blueprint-lib", "latest"), { fetchImpl }),
    "invalid-version",
  );
  await assertRejects(
    prepareBlueprintPackage(home, npmPkg("dsh-blueprint-lib", "^1.2.3"), { fetchImpl }),
    "invalid-version",
  );
  assert.equal(fetched, false);
});

test("cached tarball path outside hub/plugins is rejected", async () => {
  const home = tempHome();
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  const outsideDir = mkdtempSync(join(tmpdir(), "dsh-spaces-blueprint-escape-"));
  temps.push(outsideDir);
  const outside = join(outsideDir, "escaped.tgz");
  writeFileSync(outside, tarball);
  mkdirSync(join(home, "hub", "plugins"), { recursive: true });
  upsertLibraryEntry(home, {
    id: "dsh-blueprint-lib@1.0.0",
    spec: "dsh-blueprint-lib@1.0.0",
    packageName: "dsh-blueprint-lib",
    title: "dsh-blueprint-lib",
    tarball: relative(home, outside).replaceAll("\\", "/"),
    source: "manual",
    downloadedAt: new Date(0).toISOString(),
  });
  const error = await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      {
        fetchImpl: async () => {
          throw new Error("must not fetch after cache hit");
        },
      },
    ),
    "archive-escape",
  );
  assertNoLeak(error, outside, outsideDir, realHome);
});

test("symlink tarball that escapes the Home plugin cache is rejected", async (t) => {
  const home = tempHome();
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  const outsideDir = mkdtempSync(join(tmpdir(), "dsh-spaces-blueprint-link-"));
  temps.push(outsideDir);
  const outside = join(outsideDir, "escaped.tgz");
  writeFileSync(outside, tarball);
  const dest = archiveAbsPath(home, "dsh-blueprint-lib@1.0.0");
  mkdirSync(dirname(dest), { recursive: true });
  try {
    symlinkSync(outside, dest);
  } catch (error) {
    t.skip(`external file symlink is not testable on this Windows account: ${String(error)}`);
    return;
  }
  upsertLibraryEntry(home, {
    id: "dsh-blueprint-lib@1.0.0",
    spec: "dsh-blueprint-lib@1.0.0",
    packageName: "dsh-blueprint-lib",
    title: "dsh-blueprint-lib",
    tarball: relative(home, dest).replaceAll("\\", "/"),
    source: "manual",
    downloadedAt: new Date(0).toISOString(),
  });
  const error = await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      {
        fetchImpl: async () => {
          throw new Error("must not fetch after cache hit");
        },
      },
    ),
    "archive-escape",
  );
  assertNoLeak(error, outside, realHome);
});

test("concatenated package.json is rejected", async () => {
  const home = tempHome();
  const tarball = packRawManifest(
    '{"name":"dsh-blueprint-lib","version":"1.0.0"}{"name":"other","version":"9.9.9"}',
  );
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball) },
    ),
    "manifest-invalid",
  );
});

test("archive without package/package.json is rejected", async () => {
  const home = tempHome();
  const tarball = packFiles({ "package/README.md": "no manifest" });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball) },
    ),
    "manifest-missing",
  );
});

test("corrupt archive bytes are rejected", async () => {
  const home = tempHome();
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", Buffer.from("not-a-tarball")) },
    ),
    "archive-corrupt",
  );
});

test("exact spec is forwarded and latest tarball is never requested", async () => {
  const home = tempHome();
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.2.3" });
  const seen: string[] = [];
  await prepareBlueprintPackage(
    home,
    npmPkg("dsh-blueprint-lib", "1.2.3"),
    { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.2.3", tarball, seen) },
  );
  assert.ok(seen.some((url) => !url.endsWith(".tgz") && url.includes("dsh-blueprint-lib")));
  assert.equal(seen.filter((url) => url.includes(".tgz")).length, 1);
  assert.equal(seen.some((url) => /latest/i.test(url)), false);
});

test("manifest name or version whitespace is identity mismatch, not a match after trim", async () => {
  const namePad = packRawManifest('{"name":"dsh-blueprint-lib ","version":"1.0.0"}');
  const versionPad = packRawManifest('{"name":"dsh-blueprint-lib","version":"1.0.0 "}');
  await assertRejects(
    prepareBlueprintPackage(
      tempHome(),
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", namePad) },
    ),
    "identity-mismatch",
  );
  await assertRejects(
    prepareBlueprintPackage(
      tempHome(),
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", versionPad) },
    ),
    "identity-mismatch",
  );
});

test("symlink bundle patch is not treated as a regular archive file", async () => {
  const home = tempHome();
  const tarball = packLinkArchive("symlink")
    ?? packTypedMembers([
      { name: "package/package.json", typeflag: "0", content: bundleManifest() },
      { name: "package/cordis.patch.yml", typeflag: "2", linkname: "package.json" },
    ]);
  const error = await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball) },
    ),
    "bundle-patch-invalid",
  );
  assert.equal(error.message.includes("hasBundle"), false);
});

test("hardlink bundle patch is not treated as a regular archive file", async () => {
  const home = tempHome();
  const tarball = packLinkArchive("hardlink")
    ?? packTypedMembers([
      { name: "package/package.json", typeflag: "0", content: bundleManifest() },
      { name: "package/real.patch.yml", typeflag: "0", content: Buffer.from("id: demo\n") },
      { name: "package/cordis.patch.yml", typeflag: "1", linkname: "package/real.patch.yml" },
    ]);
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball) },
    ),
    "bundle-patch-invalid",
  );
});

test("directory or duplicate aliased names for the manifest and patch are rejected", async () => {
  const asDir = packTypedMembers([
    { name: "package/package.json", typeflag: "5" },
  ]);
  await assertRejects(
    prepareBlueprintPackage(
      tempHome(),
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", asDir) },
    ),
    "manifest-invalid",
  );
  const aliased = packTypedMembers([
    { name: "package/package.json", typeflag: "0", content: bundleManifest() },
    { name: "package/cordis.patch.yml", typeflag: "0", content: Buffer.from("id: demo\n") },
    { name: "package/cordis.patch.yml", typeflag: "1", linkname: "package/package.json" },
  ]);
  await assertRejects(
    prepareBlueprintPackage(
      tempHome(),
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", aliased) },
    ),
    "bundle-patch-invalid",
  );
});

test("node-tar PAX extended header with a regular long patch name is accepted", async () => {
  const staging = mkdtempSync(join(tmpdir(), "dsh-spaces-blueprint-pax-"));
  temps.push(staging);
  const pack = join(staging, "pack");
  mkdirSync(join(pack, "package"), { recursive: true });
  const patch = `${"a".repeat(115)}.yml`;
  writeFileSync(join(pack, "package", patch), "[]\n");
  writeFileSync(
    join(pack, "package", "package.json"),
    JSON.stringify({
      name: "dsh-blueprint-lib",
      version: "1.0.0",
      dsh: { bundle: { patch } },
    }),
  );
  const file = join(staging, "package.tgz");
  await createTar({ file, gzip: true, cwd: pack }, ["package"]);
  const tarball = readFileSync(file);
  const prepared = await prepareBlueprintPackage(
    tempHome(),
    npmPkg("dsh-blueprint-lib", "1.0.0"),
    { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball) },
  );
  assert.equal(prepared.hasBundle, true);
  assert.equal(prepared.bundlePatch, patch);
  assert.equal(prepared.name, "dsh-blueprint-lib");
  assert.equal(prepared.version, "1.0.0");
});

test("already aborted signal fails without fetch", async () => {
  const home = tempHome();
  const abort = new AbortController();
  abort.abort();
  let fetched = false;
  await assert.rejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      {
        signal: abort.signal,
        fetchImpl: async () => {
          fetched = true;
          throw new Error("must not fetch");
        },
      },
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(fetched, false);
  assert.equal(existsSync(join(home, "hub")), false);
});

test("hub junction is rejected before fetch and leaves the outside tree unchanged", async () => {
  const { home, outside } = tempBound();
  writeFileSync(join(outside, "keep.bin"), "outside-sentinel");
  makeDirLink(outside, join(home, "hub"));
  const before = snapshotTree(outside);
  const seen: string[] = [];
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  const error = await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball, seen) },
    ),
    "archive-escape",
  );
  assert.deepEqual(seen, []);
  assertUnchangedTree(outside, before);
  assert.equal(lstatSync(join(home, "hub")).isSymbolicLink(), true);
  assertNoLeak(error, outside, realHome);
});

test("hub junction with an existing outside plugins suffix is rejected before fetch", async () => {
  const { home, outside } = tempBound();
  mkdirSync(join(outside, "plugins"));
  writeFileSync(join(outside, "plugins", "preexisting.tgz"), "do-not-touch");
  makeDirLink(outside, join(home, "hub"));
  const before = snapshotTree(outside);
  const seen: string[] = [];
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball, seen) },
    ),
    "archive-escape",
  );
  assert.deepEqual(seen, []);
  assertUnchangedTree(outside, before);
  assert.equal(lstatSync(join(home, "hub")).isSymbolicLink(), true);
});

test("plugins junction is rejected before fetch and leaves the outside tree unchanged", async () => {
  const { home, outside } = tempBound();
  mkdirSync(join(home, "hub"));
  writeFileSync(join(outside, "keep.bin"), "outside-sentinel");
  makeDirLink(outside, join(home, "hub", "plugins"));
  const before = snapshotTree(outside);
  const seen: string[] = [];
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball, seen) },
    ),
    "archive-escape",
  );
  assert.deepEqual(seen, []);
  assertUnchangedTree(outside, before);
  assert.equal(lstatSync(join(home, "hub")).isSymbolicLink(), false);
  assert.equal(lstatSync(join(home, "hub")).isDirectory(), true);
  assert.equal(lstatSync(join(home, "hub", "plugins")).isSymbolicLink(), true);
  assert.equal(existsSync(join(home, "hub", "plugin-library.json")), false);
});

test("plugin-library.json file symlink is rejected before fetch when the platform allows it", async (t) => {
  const { home, outside } = tempBound();
  mkdirSync(join(home, "hub"));
  const target = join(outside, "library.json");
  writeFileSync(target, JSON.stringify({ plugins: [{ id: "outside-sentinel" }] }));
  const dest = join(home, "hub", "plugin-library.json");
  try {
    symlinkSync(target, dest, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    t.skip(`external file symlink is not testable on this Windows account: ${String(error)}`);
    return;
  }
  const before = snapshotTree(outside);
  const seen: string[] = [];
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball, seen) },
    ),
    "archive-escape",
  );
  assert.deepEqual(seen, []);
  assertUnchangedTree(outside, before);
  assert.equal(lstatSync(dest).isSymbolicLink(), true);
  assert.equal(readFileSync(target, "utf8").includes("outside-sentinel"), true);
});

test("target archive file symlink is rejected before fetch when the platform allows it", async (t) => {
  const { home, outside } = tempBound();
  mkdirSync(join(home, "hub", "plugins"), { recursive: true });
  const target = join(outside, "escaped.tgz");
  writeFileSync(target, "do-not-read");
  const dest = archiveAbsPath(home, "dsh-blueprint-lib@1.0.0");
  try {
    symlinkSync(target, dest, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    t.skip(`external file symlink is not testable on this Windows account: ${String(error)}`);
    return;
  }
  const before = snapshotTree(outside);
  const seen: string[] = [];
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball, seen) },
    ),
    "archive-escape",
  );
  assert.deepEqual(seen, []);
  assertUnchangedTree(outside, before);
  assert.equal(lstatSync(dest).isSymbolicLink(), true);
  assert.equal(existsSync(join(home, "hub", "plugin-library.json")), false);
});

test("hub as a non-directory parent is rejected before fetch", async () => {
  const { home, outside } = tempBound();
  writeFileSync(join(home, "hub"), "not-a-directory");
  writeFileSync(join(outside, "keep.bin"), "outside-sentinel");
  const before = snapshotTree(outside);
  const seen: string[] = [];
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball, seen) },
    ),
    "archive-escape",
  );
  assert.deepEqual(seen, []);
  assertUnchangedTree(outside, before);
  assert.equal(lstatSync(join(home, "hub")).isFile(), true);
  assert.equal(lstatSync(join(home, "hub")).isSymbolicLink(), false);
  assert.equal(readFileSync(join(home, "hub"), "utf8"), "not-a-directory");
});

test("selected library tarball ../outside.tgz is rejected before fetch without probing outside", async () => {
  const { root, home, outside } = tempBound();
  mkdirSync(join(home, "hub", "plugins"), { recursive: true });
  const escaped = join(root, "outside.tgz");
  writeFileSync(escaped, "outside-archive");
  writeFileSync(join(outside, "keep.bin"), "outside-sentinel");
  writeLibrary(home, "../outside.tgz");
  const beforeFile = readFileSync(escaped);
  const beforeOutside = snapshotTree(outside);
  const seen: string[] = [];
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball, seen) },
    ),
    "archive-escape",
  );
  assert.deepEqual(seen, []);
  assert.equal(Buffer.compare(readFileSync(escaped), beforeFile), 0);
  assertUnchangedTree(outside, beforeOutside);
});

test("alternate cache filename link is rejected before fetch when the platform allows it", async (t) => {
  const { home, outside } = tempBound();
  mkdirSync(join(home, "hub", "plugins"), { recursive: true });
  const target = join(outside, "escaped.tgz");
  writeFileSync(target, "do-not-read");
  writeFileSync(join(outside, "keep.bin"), "outside-sentinel");
  const alias = join(home, "hub", "plugins", "alias.tgz");
  try {
    symlinkSync(target, alias, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    t.skip(`external file symlink is not testable on this Windows account: ${String(error)}`);
    return;
  }
  writeLibrary(home, relative(home, alias).replaceAll("\\", "/"));
  const before = snapshotTree(outside);
  const seen: string[] = [];
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball, seen) },
    ),
    "archive-escape",
  );
  assert.deepEqual(seen, []);
  assertUnchangedTree(outside, before);
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
});

test("corrupted plugin-library.json rejects before fetch and keeps original bytes", async () => {
  const home = tempHome();
  mkdirSync(join(home, "hub", "plugins"), { recursive: true });
  const library = join(home, "hub", "plugin-library.json");
  const original = Buffer.from("{not-json");
  writeFileSync(library, original);
  const seen: string[] = [];
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  await assertRejects(
    prepareBlueprintPackage(
      home,
      npmPkg("dsh-blueprint-lib", "1.0.0"),
      { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball, seen) },
    ),
    "download-failed",
  );
  assert.deepEqual(seen, []);
  assert.equal(Buffer.compare(readFileSync(library), original), 0);
});

test("missing recorded archive in the legal cache still downloads without repair", async () => {
  const home = tempHome();
  mkdirSync(join(home, "hub", "plugins"), { recursive: true });
  const dest = archiveAbsPath(home, "dsh-blueprint-lib@1.0.0");
  writeLibrary(home, relative(home, dest).replaceAll("\\", "/"));
  assert.equal(existsSync(dest), false);
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  const seen: string[] = [];
  const prepared = await prepareBlueprintPackage(
    home,
    npmPkg("dsh-blueprint-lib", "1.0.0"),
    { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball, seen) },
  );
  assert.ok(seen.some((url) => url.includes("dsh-blueprint-lib-1.0.0.tgz")));
  assert.equal(prepared.name, "dsh-blueprint-lib");
  assert.equal(prepared.version, "1.0.0");
  assert.equal(prepared.integrity, sri(tarball));
  assert.equal(lstatSync(dest).isFile(), true);
  assertNoSacredWrites(home);
});

test("cached archive alias inside hub/plugins is accepted without fetch", async () => {
  const home = tempHome();
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  const alias = join(home, "hub", "plugins", "alias.tgz");
  mkdirSync(dirname(alias), { recursive: true });
  writeFileSync(alias, tarball);
  writeLibrary(home, relative(home, alias).replaceAll("\\", "/"));
  const prepared = await prepareBlueprintPackage(
    home,
    npmPkg("dsh-blueprint-lib", "1.0.0"),
    {
      fetchImpl: async () => {
        throw new Error("should use cached tarball");
      },
    },
  );
  assert.equal(prepared.name, "dsh-blueprint-lib");
  assert.equal(prepared.version, "1.0.0");
  assert.equal(prepared.integrity, sri(tarball));
  assert.equal(
    realpathSync(prepared.archivePath).toLowerCase(),
    realpathSync(alias).toLowerCase(),
  );
  assertNoSacredWrites(home);
});

test("missing hub and plugins under a real home still first-download and cache-hit", async () => {
  const { home } = tempBound();
  const tarball = packFixture({ name: "dsh-blueprint-lib", version: "1.0.0" });
  const firstSeen: string[] = [];
  const first = await prepareBlueprintPackage(
    home,
    npmPkg("dsh-blueprint-lib", "1.0.0"),
    { fetchImpl: fixtureFetch("dsh-blueprint-lib", "1.0.0", tarball, firstSeen) },
  );
  assert.ok(firstSeen.some((url) => url.includes("dsh-blueprint-lib-1.0.0.tgz")));
  assert.equal(lstatSync(join(home, "hub")).isDirectory(), true);
  assert.equal(lstatSync(join(home, "hub")).isSymbolicLink(), false);
  assert.equal(lstatSync(join(home, "hub", "plugins")).isDirectory(), true);
  assert.equal(lstatSync(join(home, "hub", "plugins")).isSymbolicLink(), false);
  assert.equal(lstatSync(join(home, "hub", "plugin-library.json")).isFile(), true);
  assert.equal(lstatSync(join(home, "hub", "plugin-library.json")).isSymbolicLink(), false);
  assert.equal(lstatSync(first.archivePath).isFile(), true);
  assert.equal(lstatSync(first.archivePath).isSymbolicLink(), false);
  const secondSeen: string[] = [];
  const second = await prepareBlueprintPackage(
    home,
    npmPkg("dsh-blueprint-lib", "1.0.0"),
    {
      fetchImpl: async (url) => {
        secondSeen.push(url);
        throw new Error("should use cached tarball");
      },
    },
  );
  assert.deepEqual(secondSeen, []);
  assert.equal(second.archivePath, first.archivePath);
  assert.equal(second.integrity, first.integrity);
  assertNoSacredWrites(home);
});

function npmPkg(name: string, version: string, integrity?: string): BlueprintPackage {
  const pkg: BlueprintPackage = { name, version, source: { type: "npm" } };
  if (integrity !== undefined) pkg.integrity = integrity;
  return pkg;
}

function fixtureFetch(name: string, version: string, tarball: Buffer, seen: string[] = []): PluginFetcher {
  return async (url) => {
    seen.push(url);
    if (url.includes(".tgz") || url.includes("/-/")) {
      if (!url.includes(`${name}-${version}.tgz`)) {
        throw new Error("must request the exact tarball version");
      }
      const copy = Uint8Array.from(tarball);
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => copy.buffer,
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        name,
        "dist-tags": { latest: "9.9.9" },
        versions: {
          [version]: { dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` } },
          "9.9.9": { dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-9.9.9.tgz` } },
        },
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

function packFixture(manifest: Record<string, unknown>, files: Record<string, string> = {}): Buffer {
  return packFiles({
    "package/package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    ...Object.fromEntries(Object.entries(files).map(([rel, content]) => [`package/${rel}`, content])),
  });
}

function packRawManifest(source: string): Buffer {
  return packFiles({ "package/package.json": source });
}

function packFiles(files: Record<string, string>): Buffer {
  const staging = mkdtempSync(join(tmpdir(), "dsh-spaces-blueprint-pack-"));
  temps.push(staging);
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(staging, ...rel.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  const tgz = join(staging, "package.tgz");
  const packed = spawnSync(tarExecutable(), ["-czf", tgz, "-C", staging, "package"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (packed.status !== 0 || !existsSync(tgz)) {
    throw new Error(packed.stderr || packed.stdout || "tar pack failed");
  }
  return readFileSync(tgz);
}

function bundleManifest(): Buffer {
  return Buffer.from(`${JSON.stringify({
    name: "dsh-blueprint-lib",
    version: "1.0.0",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  })}\n`);
}

function packLinkArchive(kind: "symlink" | "hardlink"): Buffer | undefined {
  const staging = mkdtempSync(join(tmpdir(), "dsh-spaces-blueprint-linkpack-"));
  temps.push(staging);
  const inner = join(staging, "package");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, "package.json"), bundleManifest());
  const target = join(inner, "real.patch.yml");
  const dest = join(inner, "cordis.patch.yml");
  writeFileSync(target, "id: demo\n");
  try {
    if (kind === "symlink") symlinkSync("real.patch.yml", dest);
    else linkSync(target, dest);
  } catch {
    return undefined;
  }
  const tgz = join(staging, "package.tgz");
  const packed = spawnSync(tarExecutable(), ["-czf", tgz, "-C", staging, "package"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (packed.status !== 0 || !existsSync(tgz)) return undefined;
  const listed = spawnSync(tarExecutable(), ["-tvf", tgz], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (listed.status !== 0) return undefined;
  const line = listed.stdout.split(/\r?\n/).find((row) => row.includes("package/cordis.patch.yml"));
  if (!line) return undefined;
  const isLink = line.startsWith("h") || line.startsWith("l") || line.includes(" link to ") || line.includes(" -> ");
  return isLink ? readFileSync(tgz) : undefined;
}

function packTypedMembers(
  members: Array<{ name: string; typeflag: string; content?: Buffer; linkname?: string }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const content = member.content ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(member.name, 0, Math.min(member.name.length, 99), "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = member.typeflag.charCodeAt(0);
    if (member.linkname) header.write(member.linkname, 157, Math.min(member.linkname.length, 99), "utf8");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(header);
    if (member.typeflag === "0" && content.length > 0) {
      blocks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function tarExecutable(): string {
  if (process.platform === "win32") {
    return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  }
  return "tar";
}

function sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-blueprint-home-"));
  temps.push(dir);
  assert.notEqual(resolve(dir).toLowerCase(), resolve(realHome).toLowerCase());
  return dir;
}

function tempBound(): { root: string; home: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "dsh-spaces-blueprint-bound-"));
  temps.push(root);
  const home = join(root, "home");
  const outside = join(root, "outside");
  mkdirSync(home);
  mkdirSync(outside);
  assert.notEqual(resolve(home).toLowerCase(), resolve(realHome).toLowerCase());
  return { root, home, outside };
}

function makeDirLink(target: string, dest: string): void {
  symlinkSync(target, dest, process.platform === "win32" ? "junction" : "dir");
}

function writeLibrary(home: string, tarball: string): void {
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(
    join(home, "hub", "plugin-library.json"),
    `${JSON.stringify({
      plugins: [{
        id: "dsh-blueprint-lib@1.0.0",
        spec: "dsh-blueprint-lib@1.0.0",
        packageName: "dsh-blueprint-lib",
        title: "dsh-blueprint-lib",
        tarball,
        source: "manual",
        downloadedAt: new Date(0).toISOString(),
      }],
    }, null, 2)}\n`,
  );
}

function snapshotTree(dir: string): { tree: string[]; hashes: Record<string, string> } {
  const tree = listTree(dir);
  const hashes: Record<string, string> = {};
  for (const rel of tree) {
    if (rel.endsWith("/")) continue;
    hashes[rel] = createHash("sha256").update(readFileSync(join(dir, ...rel.split("/")))).digest("hex");
  }
  return { tree, hashes };
}

function listTree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      out.push(entry.name);
      continue;
    }
    if (st.isDirectory()) {
      out.push(`${entry.name}/`);
      for (const child of listTree(full)) out.push(`${entry.name}/${child}`);
      continue;
    }
    out.push(entry.name);
  }
  return out;
}

function assertUnchangedTree(dir: string, before: { tree: string[]; hashes: Record<string, string> }): void {
  const after = snapshotTree(dir);
  assert.deepEqual(after.tree, before.tree);
  assert.deepEqual(after.hashes, before.hashes);
}

function assertNoSacredWrites(home: string): void {
  assert.equal(existsSync(join(home, "profiles")), false);
  assert.equal(existsSync(join(home, "sessions")), false);
  assert.equal(existsSync(join(home, "storages")), false);
  if (existsSync(join(home, "hub"))) {
    assert.deepEqual(
      readdirSync(join(home, "hub")).sort(),
      ["plugin-library.json", "plugins"].sort(),
    );
  }
}

async function assertRejects(work: Promise<unknown>, code: string): Promise<BlueprintPackageError> {
  let failed: BlueprintPackageError | undefined;
  await assert.rejects(work, (error: unknown) => {
    assert.equal(error instanceof BlueprintPackageError, true);
    failed = error as BlueprintPackageError;
    assert.equal(failed.code, code);
    assert.match(failed.message, /^Blueprint /);
    assertNoLeak(failed, realHome);
    return true;
  });
  assert.ok(failed);
  return failed;
}

function assertNoLeak(error: Error, ...needles: string[]): void {
  const text = error.message;
  for (const needle of needles) {
    if (!needle) continue;
    assert.equal(text.includes(needle), false, `error leaked ${needle}`);
  }
  assert.equal(/[A-Za-z]:\\/.test(text), false);
  assert.equal(/\btoken\b/i.test(text), false);
}
