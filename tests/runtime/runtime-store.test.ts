import { describeRuntime } from "../../src/adapters/node/runtime/runtime-descriptor.ts";
import { createDirectoryLink } from "../../src/shared/node/filesystem.ts";
import { spawnSync } from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { npmPackumentUrl, npmRegistry } from "../../src/adapters/node/products/package-source.ts";
import { RuntimeStore, type RegistryFetcher, type RunProcessFn } from "../../src/adapters/node/runtime/runtime-store.ts";
import { isExactRuntimeVersion, preferredTaggedVersion } from "../../src/shared/runtime.ts";
import type { PackageSource } from "../../src/shared/types.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeFakeCli(prefix: string, version: string): string {
  const pkg = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "console.log('dsh')\n", "utf8");
  writeFileSync(
    join(pkg, "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh", version }, null, 2)}\n`,
    "utf8",
  );
  return bin;
}

function leftoverStaging(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith(".tmp-dsh-"));
}

function mockRun(options: {
  failInstall?: boolean;
  leavePackageOnInstallFail?: boolean;
  versionCode?: number;
  reportedVersion?: string | ((requested: string) => string);
  delayInstallMs?: number;
  installs?: string[];
  commands?: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }>;
} = {}): RunProcessFn {
  return async (command, args, runOptions) => {
    options.commands?.push({ command, args, env: runOptions?.env });
    assert.equal(runOptions?.shell ?? false, false);
    if (args.includes("install")) {
      const spec = args.find((item) => item.startsWith("@deepseek-ai/dsh@"));
      assert.ok(spec, "install must pass an exact package spec");
      const version = spec.slice("@deepseek-ai/dsh@".length);
      options.installs?.push(version);
      if (options.delayInstallMs) await delay(options.delayInstallMs);
      const prefix = args[args.indexOf("--prefix") + 1];
      if (options.failInstall) {
        if (options.leavePackageOnInstallFail) writeFakeCli(prefix, version);
        return { code: 1, stdout: "", stderr: "npm failed" };
      }
      writeFakeCli(prefix, version);
      return { code: 0, stdout: "added 1 package", stderr: "" };
    }
    if (args.includes("--version")) {
      const bin = args.find((item) => item.endsWith("bin.js")) ?? args[0];
      const pkg = join(bin, "..", "..", "package.json");
      let requested = "0.0.0";
      if (existsSync(pkg)) {
        requested = (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
      }
      const reported =
        typeof options.reportedVersion === "function"
          ? options.reportedVersion(requested)
          : (options.reportedVersion ?? requested);
      return { code: options.versionCode ?? 0, stdout: `dsh ${reported}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
  };
}

function store(options: {
  root?: string;
  source?: PackageSource;
  run?: RunProcessFn;
  fetch?: RegistryFetcher;
} = {}): { runtime: RuntimeStore; root: string } {
  const root = options.root ?? tempDir("dsh-runtime-");
  return {
    root,
    runtime: new RuntimeStore({
      root,
      source: () => options.source ?? "official",
      run: options.run ?? mockRun(),
      fetch: options.fetch,
    }),
  };
}

test("runtime publication reports the first rename failure without retry or publishing a result", async (t) => {
  const failure = Object.assign(new Error("runtime destination busy"), { code: "EBUSY" });
  let attempts = 0;
  const installs: string[] = [];
  const { runtime, root } = store({ run: mockRun({ installs }) });
  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // Exercise the platform on which the retired retry loop used to run.
  Object.defineProperty(process, "platform", { ...previousPlatform, value: "win32" });
  const renameMock = t.mock.method(fsPromises, "rename", async () => {
    attempts += 1;
    throw failure;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => runtime.install("1.2.3"), error => error === failure);
    assert.equal(attempts, 1);
    assert.deepEqual(installs, ["1.2.3"]);
    assert.equal(runtime.inventory().installed.length, 0);
    assert.equal(existsSync(join(root, "versions", "1.2.3", "meta.json")), false);
    assert.deepEqual(leftoverStaging(root), []);
  } finally {
    renameMock.mock.restore();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", previousPlatform);
  }
});

test("rejects tags, paths, and shell fragments as install versions", () => {
  assert.equal(isExactRuntimeVersion("0.1.1-rc.2"), true);
  assert.equal(isExactRuntimeVersion("0.1.5-rc.1"), true);
  assert.equal(isExactRuntimeVersion("1.2.3"), true);
  assert.equal(isExactRuntimeVersion("latest"), false);
  assert.equal(isExactRuntimeVersion("next"), false);
  assert.equal(isExactRuntimeVersion("../1.0.0"), false);
  assert.equal(isExactRuntimeVersion("1.0.0/foo"), false);
  assert.equal(isExactRuntimeVersion("1.0.0;rm"), false);
  assert.equal(isExactRuntimeVersion("1.0.0 && echo"), false);
  assert.equal(isExactRuntimeVersion("1.0.0|id"), false);
});

test("install verifies the exact version", async () => {
  const commands: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const { runtime } = store({ source: "china", run: mockRun({ commands }) });
  const installed = await runtime.install("0.1.1-rc.2");
  assert.equal(installed.version, "0.1.1-rc.2");
  assert.ok(existsSync(installed.bin));
  const npm = commands.find((item) => item.args.includes("install"));
  assert.ok(npm);
  assert.ok(Array.isArray(npm.args));
  assert.ok(npm.args.includes("--no-audit"));
  assert.ok(npm.args.includes("--no-fund"));
  assert.ok(npm.args.includes("@deepseek-ai/dsh@0.1.1-rc.2"));
  assert.ok(!npm.args.includes("@deepseek-ai/dsh@latest"));
  assert.equal(npm.env?.npm_config_registry, npmRegistry("china"));
  assert.equal(runtime.installedBin("0.1.1-rc.2"), installed.bin);
  assert.equal(runtime.installedBin("0.2.0"), undefined);
  assert.equal(runtime.installedBin("latest"), undefined);
});

test("install failure keeps the previous selection", async () => {
  const { runtime, root } = store();
  const installed = await runtime.install("0.1.1-rc.2");
  const failing = store({ root, run: mockRun({ failInstall: true }) }).runtime;
  await assert.rejects(() => failing.install("0.2.0"), /npm failed|exited/);
  assert.equal(runtime.inventory().installed.length, 1);
  assert.equal(runtime.inventory().installed[0].version, "0.1.1-rc.2");
  assert.ok(!existsSync(join(root, "versions", "0.2.0")));
});

test("rejects an install whose --version does not match the requested version", async () => {
  const { runtime } = store({
    run: mockRun({ reportedVersion: () => "0.0.1-rc.1" }),
  });
  await assert.rejects(() => runtime.install("0.1.1-rc.2"), /--version reported 0\.0\.1-rc\.1/);
  assert.deepEqual(runtime.inventory().installed, []);
});

test("forged versions never reach npm", async () => {
  const installs: string[] = [];
  const { runtime } = store({ run: mockRun({ installs }) });
  await assert.rejects(() => runtime.install("latest"), /invalid runtime version/);
  await assert.rejects(() => runtime.install("1.0.0; rm -rf /"), /invalid runtime version/);
  await assert.rejects(() => runtime.install("..\\0.1.0"), /invalid runtime version/);
  assert.deepEqual(installs, []);
});

test("concurrent installs of the same version share one write", async () => {
  const installs: string[] = [];
  const { runtime } = store({ run: mockRun({ installs, delayInstallMs: 40 }) });
  const [a, b] = await Promise.all([runtime.install("0.1.1-rc.2"), runtime.install("0.1.1-rc.2")]);
  assert.equal(a.version, "0.1.1-rc.2");
  assert.equal(b.bin, a.bin);
  assert.equal(installs.length, 1);
  assert.equal(runtime.inventory().installed.length, 1);
});

test("catalog fetches the user-selected official or china registry", async () => {
  const packument = {
    "dist-tags": { latest: "0.0.1-rc.1", next: "0.1.1-rc.2" },
    versions: {
      "0.0.1-rc.1": {},
      "0.1.1-rc.2": {},
    },
    time: {
      "0.0.1-rc.1": "2025-01-01T00:00:00.000Z",
      "0.1.1-rc.2": "2026-01-01T00:00:00.000Z",
    },
  };
  const seen: string[] = [];
  const headers: Array<Record<string, string> | undefined> = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(url);
    headers.push(init?.headers);
    return { ok: true, status: 200, json: async () => packument };
  };
  const china = new RuntimeStore({
    root: tempDir("dsh-runtime-"),
    source: () => "china",
    run: mockRun(),
    fetch: fetchImpl,
  });
  const official = new RuntimeStore({
    root: tempDir("dsh-runtime-"),
    source: () => "official",
    run: mockRun(),
    fetch: fetchImpl,
  });
  const catalog = await china.catalog();
  assert.equal(seen[0], npmPackumentUrl("china", "@deepseek-ai/dsh"));
  assert.equal(headers[0]?.["user-agent"], "dsh-spaces");
  assert.equal(catalog.distTags.latest, "0.0.1-rc.1");
  assert.ok(catalog.versions.some((row) => row.version === "0.1.1-rc.2"));
  assert.equal(preferredTaggedVersion(catalog), "0.0.1-rc.1");
  await official.catalog();
  assert.equal(seen[1], npmPackumentUrl("official", "@deepseek-ai/dsh"));
});

test("catalog makes exactly one fetch attempt and surfaces the failure", async () => {
  let attempts = 0;
  await assert.rejects(
    store({
      fetch: async () => {
        attempts += 1;
        throw new TypeError("fetch failed", { cause: new Error("other side closed") });
      },
    }).runtime.catalog(),
    /other side closed/,
  );
  assert.equal(attempts, 1);

  let notFound = 0;
  await assert.rejects(
    store({
      fetch: async () => {
        notFound += 1;
        return { ok: false, status: 404, json: async () => ({}) };
      },
    }).runtime.catalog(),
    /HTTP 404/,
  );
  assert.equal(notFound, 1);
});

test("npm non-zero exit is rejected even when a complete package is left behind", async () => {
  const { runtime, root } = store();
  const installed = await runtime.install("0.1.1-rc.2");
  const failing = store({
    root,
    run: mockRun({ failInstall: true, leavePackageOnInstallFail: true }),
  }).runtime;
  await assert.rejects(() => failing.install("0.2.0"), /npm failed|exited/);
  assert.ok(!existsSync(join(root, "versions", "0.2.0")));
  assert.deepEqual(leftoverStaging(root), []);
});

test("probe non-zero exit is rejected even when stdout contains the version", async () => {
  const { runtime, root } = store({ run: mockRun({ versionCode: 1 }) });
  await assert.rejects(() => runtime.install("0.1.1-rc.2"), /Could not parse|无法解析/);
  assert.deepEqual(runtime.inventory().installed, []);
  assert.deepEqual(leftoverStaging(root), []);
});

test("remove deletes an installed runtime directory and refuses invalid or linked paths", () => {
  const { runtime, root } = store();
  writeFakeCli(join(root, "versions", "0.9.9"), "0.9.9");
  assert.ok(runtime.installedBin("0.9.9"));
  runtime.remove("0.9.9");
  assert.equal(runtime.installedBin("0.9.9"), undefined);
  assert.equal(existsSync(join(root, "versions", "0.9.9")), false);
  assert.throws(() => runtime.remove("../1.0.0"), /invalid runtime version/);
  assert.throws(() => runtime.remove("0.9.9"));

  const outside = tempDir("dsh-runtime-outside-");
  mkdirSync(join(root, "versions"), { recursive: true });
  symlinkSync(outside, join(root, "versions", "0.8.8"), "junction");
  assert.throws(() => runtime.remove("0.8.8"), /not a real installed directory/);
  assert.equal(existsSync(outside), true);
});

test("system snapshot scope includes only the self-contained DSH package", () => {
 const prefix=tempDir("dsh-runtime-system-scope-"); const bin=writeFakeCli(prefix,"0.2.0-rc.2");
 mkdirSync(join(prefix,"unrelated-global-tool")); writeFileSync(join(prefix,"unrelated-global-tool","config"),"unrelated");
 const descriptor=describeRuntime({bin,version:"0.2.0-rc.2"});
 assert.equal(descriptor.root,join(prefix,"node_modules","@deepseek-ai","dsh"));
 assert.equal(descriptor.binRelative,"lib/bin.js");
});
test("managed snapshot preserves its dependency prefix, system snapshot rejects external dependencies", () => {
 const prefix=tempDir("dsh-runtime-prefix-scope-"); const bin=writeFakeCli(prefix,"0.2.0-rc.2"); const pkg=join(prefix,"node_modules","@deepseek-ai","dsh");
 writeFileSync(join(pkg,"package.json"),JSON.stringify({name:"@deepseek-ai/dsh",version:"0.2.0-rc.2",dependencies:{dependency:"1.0.0"}}));
 mkdirSync(join(prefix,"node_modules","dependency")); writeFileSync(join(prefix,"node_modules","dependency","package.json"),JSON.stringify({name:"dependency",version:"1.0.0"}));
 assert.throws(()=>describeRuntime({bin,version:"0.2.0-rc.2"}),/outside.*scope|escape.*scope|missing/);
 writeFileSync(join(prefix,"package.json"),JSON.stringify({name:"dsh-spaces-runtime",private:true}));
 assert.throws(()=>describeRuntime({bin,version:"0.2.0-rc.2"}),/outside.*scope|escape.*scope|missing/);
 assert.equal(describeRuntime({bin,version:"0.2.0-rc.2"},prefix).root,prefix);
});

test("snapshot dependency closure follows a linked package's actual Node resolution", () => {
  const prefix = tempDir("dsh-runtime-linked-");
  const bin = writeFakeCli(prefix, "0.2.0-rc.2");
  const modules = join(prefix, "node_modules");
  const dsh = join(modules, "@deepseek-ai", "dsh");
  const physicalModules = join(modules, ".pnpm", "a@1.0.0", "node_modules");
  const actualA = join(physicalModules, "a"), actualB = join(physicalModules, "b");
  for (const dir of [actualA, actualB]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dsh, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.0-rc.2", dependencies: { a: "1.0.0" } }));
  writeFileSync(join(actualA, "package.json"), JSON.stringify({ name: "a", version: "1.0.0", main: "index.cjs", dependencies: { b: "1.0.0" } }));
  writeFileSync(join(actualA, "index.cjs"), "module.exports = require('b');");
  writeFileSync(join(actualB, "package.json"), JSON.stringify({ name: "b", version: "1.0.0", main: "index.cjs" }));
  writeFileSync(join(actualB, "index.cjs"), "module.exports = 'internal-b';");
  writeFileSync(bin, "console.log(require('a'));");
  createDirectoryLink(actualA, join(modules, "a"));
  const run = spawnSync(process.execPath, [bin], { encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "internal-b");
  assert.equal(describeRuntime({ bin, version: "0.2.0-rc.2" }, prefix).root, prefix);

  const outside = tempDir("dsh-runtime-outside-dependency-");
  writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "b", version: "1.0.0", main: "index.cjs" }));
  writeFileSync(join(outside, "index.cjs"), "module.exports = 'outside-b';");
  // A valid hoisted package must not hide the different package that Node uses.
  mkdirSync(join(modules, "b"));
  writeFileSync(join(modules, "b", "package.json"), JSON.stringify({ name: "b", version: "1.0.0" }));
  rmSync(actualB, { recursive: true });
  createDirectoryLink(outside, actualB);
  const external = spawnSync(process.execPath, [bin], { encoding: "utf8", windowsHide: true });
  assert.equal(external.status, 0, external.stderr);
  assert.equal(external.stdout.trim(), "outside-b");
  assert.throws(() => describeRuntime({ bin, version: "0.2.0-rc.2" }, prefix), /dependencies escape/);
});

test("a phantom node_modules ancestor cannot hide a dependency outside the snapshot", () => {
  const root = tempDir("dsh-runtime-ghost-");
  const prefix = join(root, "managed");
  const bin = writeFakeCli(prefix, "0.2.0-rc.2");
  const dsh = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  const a = join(prefix, "node_modules", "a");
  const phantom = join(prefix, "node_modules", "node_modules", "b");
  const actual = join(root, "node_modules", "b");
  for (const dir of [a, phantom, actual]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dsh, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.0-rc.2", dependencies: { a: "1.0.0" } }));
  writeFileSync(join(a, "package.json"), JSON.stringify({ name: "a", version: "1.0.0", main: "index.cjs", dependencies: { b: "1.0.0" } }));
  writeFileSync(join(a, "index.cjs"), "module.exports = require('b');");
  for (const dir of [phantom, actual]) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "b", version: "1.0.0", main: "index.cjs" }));
    writeFileSync(join(dir, "index.cjs"), `module.exports = ${JSON.stringify(dir === actual ? "actual-outside-b" : "phantom-b")};`);
  }
  writeFileSync(bin, "console.log(require('a'));");
  const run = spawnSync(process.execPath, [bin], { encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "actual-outside-b");
  assert.throws(() => describeRuntime({ bin, version: "0.2.0-rc.2" }, prefix), /dependencies escape/);
});

for (const shadow of ["entryless-package", "sibling-file"]) {
  test(`snapshot closure rejects Node's ${shadow} resolution outside the declared package`, () => {
    const root = tempDir("dsh-runtime-entry-resolution-");
    const prefix = join(root, "managed");
    const bin = writeFakeCli(prefix, "0.2.0-rc.2");
    const dsh = join(prefix, "node_modules", "@deepseek-ai", "dsh");
    const b = join(prefix, "node_modules", "b");
    const external = join(root, "node_modules", "b");
    for (const dir of [b, external]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dsh, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", dependencies: { b: "1.0.0" } }));
    writeFileSync(join(b, "package.json"), JSON.stringify({ name: "b", version: "1.0.0" }));
    writeFileSync(join(b, "index.js"), "module.exports = 'internal-b';");
    writeFileSync(bin, "console.log(require('b'));");
    writeFileSync(join(external, "package.json"), JSON.stringify({ name: "b", main: "index.js" }));
    writeFileSync(join(external, "index.js"), "module.exports = 'external-b';");
    if (shadow === "entryless-package") rmSync(join(b, "index.js"));
    else writeFileSync(join(prefix, "node_modules", "b.js"), `module.exports = require(${JSON.stringify(external)});`);
    const live = spawnSync(process.execPath, [bin], { encoding: "utf8", windowsHide: true });
    assert.equal(live.status, 0, live.stderr);
    assert.equal(live.stdout.trim(), "external-b");
    assert.throws(() => describeRuntime({ bin, version: "0.2.0-rc.2" }, prefix), /dependencies escape|entry is outside/);
  });
}

test("snapshot closure accepts import-only and subpath-only packages", () => {
  const prefix = tempDir("dsh-runtime-export-forms-");
  const bin = writeFakeCli(prefix, "0.2.0-rc.2");
  const dsh = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  writeFileSync(join(dsh, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", dependencies: { imported: "1", subpath: "1" } }));
  for (const [name, exports] of [["imported", { import: "./index.mjs" }], ["subpath", { "./data": "./index.mjs" }]] as const) {
    const dir = join(prefix, "node_modules", name);
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, exports }));
    writeFileSync(join(dir, "index.mjs"), "export default 1;");
  }
  assert.equal(describeRuntime({ bin, version: "0.2.0-rc.2" }, prefix).root, prefix);
});

test("snapshot closure rereads changed package entries without executing them or preload hooks", () => {
  const root = tempDir("dsh-runtime-entry-cache-");
  const prefix = join(root, "managed");
  const bin = writeFakeCli(prefix, "0.2.0-rc.2");
  const dsh = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  const b = join(prefix, "node_modules", "b");
  const external = join(root, "node_modules", "b");
  for (const dir of [b, external]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dsh, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", dependencies: { b: "1" } }));
  writeFileSync(join(b, "package.json"), JSON.stringify({ name: "b", main: "index.cjs" }));
  writeFileSync(join(b, "index.cjs"), "throw new Error('dependency must not execute');");
  writeFileSync(join(b, "changed.cjs"), "throw new Error('changed dependency must not execute');");
  const preload = join(root, "preload.cjs");
  writeFileSync(preload, "throw new Error('preload must not execute');");
  const previousOptions = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
    assert.equal(describeRuntime({ bin, version: "0.2.0-rc.2" }, prefix).root, prefix);
    writeFileSync(join(b, "package.json"), JSON.stringify({ name: "b", main: "changed.cjs" }));
    assert.equal(describeRuntime({ bin, version: "0.2.0-rc.2" }, prefix).root, prefix);
    writeFileSync(join(b, "package.json"), JSON.stringify({ name: "b" }));
    writeFileSync(join(external, "package.json"), JSON.stringify({ name: "b", main: "index.cjs" }));
    writeFileSync(join(external, "index.cjs"), "module.exports = 'external-b';");
    assert.throws(() => describeRuntime({ bin, version: "0.2.0-rc.2" }, prefix), /dependencies escape/);
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
  }
  writeFileSync(bin, "console.log(require('b'));");
  const live = spawnSync(process.execPath, [bin], { encoding: "utf8", windowsHide: true });
  assert.equal(live.status, 0, live.stderr);
  assert.equal(live.stdout.trim(), "external-b");
});
