import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { npmPackumentUrl, npmRegistry } from "../src/main/package-source.ts";
import { RuntimeStore, type RegistryFetcher, type RunProcessFn } from "../src/main/runtime-store.ts";
import { isExactRuntimeVersion, preferredTaggedVersion } from "../src/shared/runtime.ts";
import type { PackageSource } from "../src/shared/types.ts";

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
  legacy?: { bin: string; version: string };
  run?: RunProcessFn;
  fetch?: RegistryFetcher;
} = {}): { runtime: RuntimeStore; root: string } {
  const root = options.root ?? tempDir("dsh-runtime-");
  return {
    root,
    runtime: new RuntimeStore({
      root,
      source: () => options.source ?? "official",
      legacy: () => options.legacy,
      run: options.run ?? mockRun(),
      fetch: options.fetch,
    }),
  };
}

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

test("restored runtime reports snapshot origin, including older system-labelled pointers", async () => {
  const base = tempDir("dsh-snapshot-origin-");
  const root = join(base, "runtimes");
  const snapshotRoot = join(base, "snapshots");
  const bin = writeFakeCli(join(snapshotRoot, "backup", "runtime"), "1.2.3");
  const runtime = new RuntimeStore({ root, snapshotRoot, source: () => "official", legacy: () => undefined, run: mockRun() });
  assert.equal((await runtime.selectExisting({ bin, version: "1.2.3" })).origin, "snapshot");
  writeFileSync(join(root, "current.json"), JSON.stringify({ bin, version: "1.2.3", origin: "system" }));
  assert.equal(runtime.current()?.origin, "snapshot");
  const outside = writeFakeCli(join(base, "snapshots-other"), "1.2.3");
  assert.equal((await runtime.selectExisting({ bin: outside, version: "1.2.3" })).origin, "system");
});

test("current uses legacy when the store has no selection", () => {
  const prefix = tempDir("dsh-legacy-");
  const bin = writeFakeCli(prefix, "0.1.1-rc.2");
  const { runtime } = store({ legacy: { bin, version: "0.1.1-rc.2" } });
  const current = runtime.current();
  assert.ok(current);
  assert.equal(current.bin, bin);
  assert.equal(current.version, "0.1.1-rc.2");
  assert.equal(current.origin, "system");
  assert.deepEqual(runtime.inventory().installed, []);
});

test("install verifies the exact version and does not change current", async () => {
  const commands: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const { runtime } = store({ source: "china", run: mockRun({ commands }) });
  const installed = await runtime.install("0.1.1-rc.2");
  assert.equal(installed.version, "0.1.1-rc.2");
  assert.ok(existsSync(installed.bin));
  assert.equal(runtime.current(), undefined);
  const npm = commands.find((item) => item.args.includes("install"));
  assert.ok(npm);
  assert.ok(Array.isArray(npm.args));
  assert.ok(npm.args.includes("--no-audit"));
  assert.ok(npm.args.includes("--no-fund"));
  assert.ok(npm.args.includes("@deepseek-ai/dsh@0.1.1-rc.2"));
  assert.ok(!npm.args.includes("@deepseek-ai/dsh@latest"));
  assert.equal(npm.env?.npm_config_registry, npmRegistry("china"));
  runtime.select("0.1.1-rc.2");
  const current = runtime.current();
  assert.ok(current);
  assert.equal(current.origin, "store");
  assert.equal(current.version, "0.1.1-rc.2");
  assert.equal(current.bin, installed.bin);
});

test("install failure keeps the previous selection", async () => {
  const { runtime, root } = store();
  await runtime.install("0.1.1-rc.2");
  runtime.select("0.1.1-rc.2");
  const before = runtime.current();
  const failing = store({ root, run: mockRun({ failInstall: true }) }).runtime;
  await assert.rejects(() => failing.install("0.2.0"), /npm failed|exited/);
  const after = runtime.current();
  assert.deepEqual(after, before);
  assert.equal(runtime.inventory().installed.length, 1);
  assert.equal(runtime.inventory().installed[0].version, "0.1.1-rc.2");
  assert.ok(!existsSync(join(root, "versions", "0.2.0")));
});

test("rejects an install whose --version does not match the requested version", async () => {
  const { runtime } = store({
    run: mockRun({ reportedVersion: () => "0.0.1-rc.1" }),
  });
  await assert.rejects(() => runtime.install("0.1.1-rc.2"), /--version reported 0\.0\.1-rc\.1/);
  assert.equal(runtime.current(), undefined);
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

test("a damaged stored selection fails instead of falling back", async () => {
  const prefix = tempDir("dsh-legacy-");
  const legacyBin = writeFakeCli(prefix, "0.1.0");
  const { runtime, root } = store({
    legacy: { bin: legacyBin, version: "0.1.0" },
    run: mockRun(),
  });
  await runtime.install("0.1.1-rc.2");
  await runtime.install("0.2.0");
  runtime.select("0.2.0");
  const recorded = runtime.recordedRef();
  assert.equal(recorded?.version, "0.2.0");
  rmSync(join(root, "versions", "0.2.0"), { recursive: true, force: true });
  assert.throws(() => runtime.current(), /selected runtime is missing/);
  assert.throws(() => runtime.inventory(), /selected runtime is missing/);
  assert.equal(runtime.recordedRef()?.version, "0.2.0");
  assert.equal(runtime.recordedRef()?.bin, recorded?.bin);
});

test("recordedRef ignores a damaged pointer file", () => {
  const { runtime, root } = store();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "current.json"), "{not-json");
  assert.equal(runtime.recordedRef(), undefined);
  assert.throws(() => runtime.current(), /unreadable|damaged/);
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
    legacy: () => undefined,
    run: mockRun(),
    fetch: fetchImpl,
  });
  const official = new RuntimeStore({
    root: tempDir("dsh-runtime-"),
    source: () => "official",
    legacy: () => undefined,
    run: mockRun(),
    fetch: fetchImpl,
  });
  const catalog = await china.catalog();
  assert.equal(seen[0], npmPackumentUrl("china", "@deepseek-ai/dsh"));
  assert.equal(headers[0]?.["user-agent"], "dsh-spaces");
  assert.equal(catalog.distTags.latest, "0.0.1-rc.1");
  assert.ok(catalog.versions.some((row) => row.version === "0.1.1-rc.2"));
  assert.equal(preferredTaggedVersion(catalog), "0.1.1-rc.2");
  assert.equal(china.current(), undefined);
  await official.catalog();
  assert.equal(seen[1], npmPackumentUrl("official", "@deepseek-ai/dsh"));
});

test("catalog retries a dropped registry connection and surfaces the socket cause", async () => {
  const packument = {
    "dist-tags": { latest: "0.1.5-rc.1", next: "0.1.5-rc.2" },
    versions: { "0.1.5-rc.1": {}, "0.1.5-rc.2": {} },
    time: {
      "0.1.5-rc.1": "2026-09-10T03:12:53.293Z",
      "0.1.5-rc.2": "2026-09-10T14:57:10.790Z",
    },
  };
  let attempts = 0;
  const { runtime } = store({
    fetch: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new TypeError("fetch failed", { cause: new Error("other side closed") });
      }
      return { ok: true, status: 200, json: async () => packument };
    },
  });
  const catalog = await runtime.catalog();
  assert.equal(attempts, 3);
  assert.equal(preferredTaggedVersion(catalog), "0.1.5-rc.2");

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

  await assert.rejects(
    store({
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: new Error("other side closed") });
      },
    }).runtime.catalog(),
    /other side closed/,
  );
});

test("npm non-zero exit is rejected even when a complete package is left behind", async () => {
  const { runtime, root } = store();
  await runtime.install("0.1.1-rc.2");
  runtime.select("0.1.1-rc.2");
  const before = runtime.current();
  const failing = store({
    root,
    run: mockRun({ failInstall: true, leavePackageOnInstallFail: true }),
  }).runtime;
  await assert.rejects(() => failing.install("0.2.0"), /npm failed|exited/);
  assert.deepEqual(runtime.current(), before);
  assert.ok(!existsSync(join(root, "versions", "0.2.0")));
  assert.deepEqual(leftoverStaging(root), []);
});

test("probe non-zero exit is rejected even when stdout contains the version", async () => {
  const { runtime, root } = store({ run: mockRun({ versionCode: 1 }) });
  await assert.rejects(() => runtime.install("0.1.1-rc.2"), /Could not parse|无法解析/);
  assert.equal(runtime.current(), undefined);
  assert.deepEqual(runtime.inventory().installed, []);
  assert.deepEqual(leftoverStaging(root), []);

  const prefix = tempDir("dsh-existing-");
  const bin = writeFakeCli(prefix, "0.1.1-rc.2");
  await assert.rejects(
    () => runtime.selectExisting({ bin, version: "0.1.1-rc.2" }),
    /Could not parse|无法解析/,
  );
  assert.equal(runtime.current(), undefined);
});

test("explicit managed or system current is invalid if package.json is gone", async () => {
  const home = tempDir("dsh-managed-");
  const prefix = join(home, "dsh-spaces", "dsh-cli");
  const bin = writeFakeCli(prefix, "0.1.1-rc.2");
  const { runtime } = store({
    legacy: { bin: writeFakeCli(tempDir("dsh-legacy-"), "0.1.0"), version: "0.1.0" },
  });
  const selected = await runtime.selectExisting({ bin, version: "0.1.1-rc.2" });
  assert.equal(selected.origin, "managed");
  assert.equal(runtime.current()?.version, "0.1.1-rc.2");
  rmSync(join(prefix, "node_modules", "@deepseek-ai", "dsh", "package.json"));
  assert.throws(() => runtime.current(), /metadata is unreadable/);
  assert.throws(() => runtime.inventory(), /metadata is unreadable/);
});

test("selectExisting records a trusted path after verifying the real version", async () => {
  const prefix = tempDir("dsh-existing-");
  const bin = writeFakeCli(prefix, "0.1.1-rc.2");
  const { runtime } = store({ run: mockRun() });
  const selected = await runtime.selectExisting({ bin, version: "0.1.1-rc.2" });
  assert.equal(selected.origin, "system");
  assert.equal(selected.bin, bin);
  assert.equal(runtime.current()?.bin, bin);
  assert.ok(existsSync(bin));
  await assert.rejects(
    () => runtime.selectExisting({ bin, version: "9.9.9" }),
    /reports 0\.1\.1-rc\.2, expected 9\.9\.9/,
  );
  await assert.rejects(
    () => runtime.selectExisting({ bin: join(prefix, "missing.js"), version: "0.1.1-rc.2" }),
    /not found/,
  );
});
