#!/usr/bin/env node
/**
 * Developer runtime: recreate a disposable Home, pack this checkout's plugin,
 * install it into official `web` with `dsh plugin add`, then start `dsh web`.
 *
 * Does not write the real ~/.dsh. Does not click 初始化 Spaces — that stays
 * an explicit action in the browser. Electron remains `pnpm run dev`.
 *
 *   node scripts/dev-dsh-web.mjs
 *
 * Env: DSH_TEST_BIN / DSH_TEST_CLI_BIN, DSH_TEST_PNPM_CJS,
 * DSH_SPACES_WEB_HOME, DSH_PACK_DEST.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoSpaces, defaultPackDest } from "./pack-spaces-plugin.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON_HOME = join(REPO, ".sandbox", "dsh-home");
const DEFAULT_HOME = join(REPO, ".sandbox", "dsh-web-home");
const REAL_HOME = join(homedir(), ".dsh");
const WEB_PROFILE = "web";
const CANONICAL_NAME = "@dsh-spaces/plugin";
const BUILD_SCRIPT = join(REPO, "scripts", "build-spaces.mjs");
const PACK_SCRIPT = join(REPO, "scripts", "pack-spaces-plugin.mjs");
const DSH_DLX_SPEC = "@deepseek-ai/dsh@0.1.7-alpha.1";
const BUILD_MS = 180_000;
const PACK_MS = 120_000;
const DUMP_MS = 300_000;
const PLUGIN_MS = 300_000;

function info(message) {
  console.log(`INFO  ${message}`);
}

function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function refuseRealHome(home) {
  const resolved = resolve(home);
  const real = resolve(REAL_HOME);
  if (samePath(resolved, real) || resolved.toLowerCase().startsWith(real.toLowerCase() + sep)) {
    throw new Error("refusing real ~/.dsh");
  }
}

function resolveHome() {
  const override = process.env.DSH_SPACES_WEB_HOME?.trim();
  const home = resolve(override || DEFAULT_HOME);
  refuseRealHome(home);
  if (samePath(home, ELECTRON_HOME)) {
    throw new Error(
      "dev:web Home must not be the Electron sandbox (.sandbox/dsh-home). Unset DSH_SPACES_WEB_HOME or point it at a separate directory.",
    );
  }
  return home;
}

function npmGlobalRoot() {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  const path = (result.stdout || "").trim();
  return result.status === 0 && path ? path : "";
}

function dshBinFromPackage(dir) {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return null;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.name !== "@deepseek-ai/dsh") return null;
  const bin = join(dir, "lib", "bin.js");
  return existsSync(bin) ? resolve(bin) : null;
}

function resolveDshBin() {
  const explicit = process.env.DSH_TEST_BIN || process.env.DSH_TEST_CLI_BIN;
  if (explicit) {
    const bin = resolve(explicit.trim());
    if (!existsSync(bin)) throw new Error(`DSH_TEST_BIN is missing: ${bin}`);
    return bin;
  }
  const globalRoot = npmGlobalRoot();
  return globalRoot ? dshBinFromPackage(join(globalRoot, "@deepseek-ai", "dsh")) : null;
}

function resolvePnpmCjs() {
  const override = process.env.DSH_TEST_PNPM_CJS?.trim();
  if (override) {
    if (!existsSync(override)) throw new Error(`DSH_TEST_PNPM_CJS is not a file: ${override}`);
    return resolve(override);
  }
  const globalRoot = npmGlobalRoot();
  const candidates = [
    globalRoot ? join(globalRoot, "pnpm", "bin", "pnpm.cjs") : "",
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs") : "",
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return resolve(path);
  }
  throw new Error("pnpm.cjs not found. Set DSH_TEST_PNPM_CJS, or install @deepseek-ai/dsh and set DSH_TEST_BIN.");
}

function resolveCli() {
  const bin = resolveDshBin();
  if (bin) return { kind: "bin", bin, label: bin };
  const pnpmCjs = resolvePnpmCjs();
  return { kind: "dlx", pnpmCjs, spec: DSH_DLX_SPEC, label: `pnpm dlx ${DSH_DLX_SPEC}` };
}

function cliArgv(cli, args) {
  if (cli.kind === "bin") return [cli.bin, ...args];
  return [cli.pnpmCjs, "dlx", cli.spec, ...args];
}

function dshEnv(home, { ci }) {
  const env = {
    ...process.env,
    DSH_HOME: home,
    npm_config_ignore_workspace_root_check: "true",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_update_notifier: "false",
  };
  if (ci) env.CI = "1";
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function run(exe, args, { cwd, env, timeoutMs, label, inherit }) {
  const result = spawnSync(exe, args, {
    cwd,
    env,
    encoding: inherit ? undefined : "utf8",
    stdio: inherit ? "inherit" : undefined,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = inherit ? "" : `${result.stdout || ""}${result.stderr || ""}`;
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    throw new Error(`${label} timed out after ${timeoutMs}ms`);
  }
  if (result.status !== 0) {
    const detail = inherit
      ? result.error?.message || `exit ${result.status}`
      : (result.stderr || result.stdout || result.error?.message || "").slice(0, 1200);
    throw new Error(`${label} failed (${result.status}): ${detail}`);
  }
  return output;
}

function pluginState(home) {
  const pkgPath = join(home, "profiles", WEB_PROFILE, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : null;
  const deps = pkg?.dependencies ?? {};
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const installDir = join(home, "profiles", WEB_PROFILE, "node_modules", ...CANONICAL_NAME.split("/"));
  return {
    dependency: Object.prototype.hasOwnProperty.call(deps, CANONICAL_NAME) ? String(deps[CANONICAL_NAME]) : null,
    inBundles: bundles.includes(CANONICAL_NAME),
    installedOnDisk: existsSync(join(installDir, "package.json")),
  };
}

function dumpHasPlugin(dump) {
  return /^- id:\s*dsh-spaces\b/m.test(dump) && dump.includes(CANONICAL_NAME);
}

function recreateHome(home) {
  if (existsSync(home)) {
    info(`removing previous Home ${home}`);
    rmSync(home, { recursive: true, force: true });
  }
  mkdirSync(home, { recursive: true });
}

function packedPluginPath() {
  const dest = defaultPackDest();
  const reportPath = join(dest, "pack-report.json");
  if (!existsSync(reportPath)) throw new Error(`pack report missing: ${reportPath}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const pluginTgz = report?.plugin?.path;
  if (!pluginTgz || !existsSync(pluginTgz)) {
    throw new Error(`packed plugin missing at ${pluginTgz || "(unset)"}`);
  }
  assertNoSpaces(pluginTgz, "plugin tarball path");
  return pluginTgz;
}

function startWeb(cli, home) {
  info(`starting dsh web (DSH_HOME=${home})`);
  info("in the browser: 工作台 / Workbench → 初始化 Spaces / Initialize Spaces");
  const child = spawn(process.execPath, cliArgv(cli, ["web"]), {
    cwd: REPO,
    env: dshEnv(home, { ci: false }),
    stdio: "inherit",
    windowsHide: false,
  });
  if (!child.pid) throw new Error("failed to spawn dsh web");
  child.on("error", (error) => {
    console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

function main() {
  info("runtime: official dsh web with this plugin preinstalled");
  info("Electron shell is pnpm run dev");

  const home = resolveHome();
  const cli = resolveCli();
  info(`dsh CLI ${cli.label}`);

  info("building spaces packages");
  run(process.execPath, [BUILD_SCRIPT], {
    cwd: REPO,
    env: process.env,
    timeoutMs: BUILD_MS,
    label: "build:spaces",
    inherit: true,
  });

  info("packing plugin");
  run(process.execPath, [PACK_SCRIPT], {
    cwd: REPO,
    env: { ...process.env, npm_config_offline: "true" },
    timeoutMs: PACK_MS,
    label: "pack:plugin",
    inherit: true,
  });
  const pluginTgz = packedPluginPath();
  info(`plugin tarball ${pluginTgz}`);

  recreateHome(home);
  info(`Home ${home}`);

  const env = dshEnv(home, { ci: true });
  info("seeding official web profile");
  run(process.execPath, cliArgv(cli, ["--profile", WEB_PROFILE, "--dump-config"]), {
    cwd: REPO,
    env,
    timeoutMs: DUMP_MS,
    label: "dsh --profile web --dump-config",
    inherit: true,
  });

  info(`installing ${CANONICAL_NAME} into web`);
  run(
    process.execPath,
    cliArgv(cli, ["plugin", "--profile", WEB_PROFILE, "add", pluginTgz]),
    {
      cwd: REPO,
      env,
      timeoutMs: PLUGIN_MS,
      label: "dsh plugin --profile web add",
      inherit: true,
    },
  );

  const afterAdd = pluginState(home);
  if (!afterAdd.dependency || !afterAdd.inBundles || !afterAdd.installedOnDisk) {
    throw new Error(`web add did not install bundle: ${JSON.stringify(afterAdd)}`);
  }
  const dumpAfterAdd = run(process.execPath, cliArgv(cli, ["--profile", WEB_PROFILE, "--dump-config"]), {
    cwd: REPO,
    env,
    timeoutMs: DUMP_MS,
    label: "dump-config after plugin add",
    inherit: false,
  });
  if (!dumpHasPlugin(dumpAfterAdd)) {
    throw new Error("web dump-config missing id: dsh-spaces after plugin add");
  }
  info("plugin registered on official web");

  startWeb(cli, home);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL  ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
  }
}
