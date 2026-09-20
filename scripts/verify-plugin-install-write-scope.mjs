#!/usr/bin/env node
/**
 * Task 01: measure official `dsh plugin --profile <name> add|remove` write
 * scope on a disposable Home. Records a no-secret hash manifest of the
 * measured install tree and compares a copy replay to that baseline.
 * Not a product restore entry.
 *
 *   node --import tsx scripts/verify-plugin-install-write-scope.mjs
 *   node --import tsx scripts/verify-plugin-install-write-scope.mjs --preflight
 *
 * Env: DSH_TEST_BIN, DSH_TEST_PNPM_CJS, DSH_TEST_OUTPUT.
 * Never writes the real ~/.dsh. Does not implement tasks 02–11.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DUMP_MS,
  PLUGIN_MS,
  cliVersion,
  dshBin,
  isolatedEnv,
  redact,
  refuseRealHome,
  resolveNpmCli,
  resolvePnpmCjs,
  run,
  runDsh,
  runDshRetry,
  samePath,
  sha256File,
  writeJson,
  writePnpmShim,
} from "./verify-spaces-distribution.mjs";
import { copyLinkedTree } from "../src/adapters/node/snapshot-store.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THIS_FILE = fileURLToPath(import.meta.url);
const REAL_HOME = join(homedir(), ".dsh");
const PACKAGE = "@dsh-spaces/write-scope-probe";
const ALPHA = "alpha";
const BETA = "beta";
const VERSION_A = "1.0.0";
const VERSION_B = "1.0.1";

const proved = [];
const report = { status: "running", proved };

function info(m) {
  console.log(`INFO  ${redact(m)}`);
}
function pass(m) {
  proved.push(m);
  console.log(`PASS  ${redact(m)}`);
}

function outputDir() {
  return resolve(process.env.DSH_TEST_OUTPUT || join(REPO, ".sandbox", "plugin-install-write-scope"));
}

function posixRel(from, to) {
  return relative(from, to).split(sep).join("/");
}

const PROTECTED_REL_RE =
  /(^|\/)(sessions|storages)(\/|$)|(^|\/)\.credentials\.yaml$|(^|\/)\.anonymous-user-id$|(^|\/)profiles\/web(\/|$)/i;
const LIVE_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/;

function posixWriteRel(rel) {
  const posix = String(rel).replaceAll("\\", "/").replace(/^\/+/, "");
  if (!posix || posix.includes("\0") || posix.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`write-scope path is invalid: ${rel}`);
  }
  return posix;
}

function classifyWritePath(rel, kind, root = "home") {
  const posix = posixWriteRel(rel);
  const excluded = root === "home" && PROTECTED_REL_RE.test(posix);
  const base = posix.split("/").pop() ?? posix;
  let role = "other";
  if (kind === "link" || posix === "profiles/node_modules" || posix.startsWith("profiles/node_modules/")) {
    role = "link";
  } else if (
    base === "pnpm-lock.yaml" ||
    base === "pnpm-lock.yml" ||
    base === "pnpm-workspace.yaml" ||
    base === ".modules.yaml" ||
    base === "package-lock.json"
  ) {
    role = "lock";
  } else if (base === "package.json") {
    role = "manifest";
  } else if (base === "cordis.patch.yml" || base === "cordis.yml") {
    role = "config";
  } else if (
    root === "store" ||
    posix.includes("/node_modules/") ||
    posix.endsWith("/node_modules") ||
    posix.startsWith("node_modules/")
  ) {
    role = "dependency";
  }
  const shared =
    root === "store" || posix === "profiles/node_modules" || posix.startsWith("profiles/node_modules/");
  return { role, shared, excluded };
}

function assertProtectedPathsUntouched(scope, label) {
  const bad = scope.filter((entry) => entry.root === "home" && PROTECTED_REL_RE.test(entry.rel.replaceAll("\\", "/")));
  if (bad.length) {
    throw new Error(`${label}: write scope touched web/session/storage/credential paths: ${bad.map((row) => row.rel).join(", ")}`);
  }
}

function buildWriteScopeManifest({ packageName, spaceId, resolvedVersion, contentDigest, paths }) {
  if (typeof contentDigest !== "string" || !/^[0-9a-f]{64}$/.test(contentDigest)) {
    throw new Error("write-scope contentDigest must be 64 hex");
  }
  const included = paths
    .filter((entry) => !entry.excluded)
    .map((entry) => ({
      root: entry.root,
      rel: posixWriteRel(entry.rel),
      kind: entry.kind,
      role: entry.role,
      shared: entry.shared === true,
    }));
  if (included.some((entry) => entry.root === "home" && PROTECTED_REL_RE.test(entry.rel))) {
    throw new Error("write-scope manifest must not list web/session/storage/credential paths");
  }
  const manifest = {
    kind: "plugin-install-write-scope",
    packageName,
    spaceId,
    resolvedVersion,
    contentDigest,
    excluded: { web: true, sessions: true, storages: true, credentials: true },
    paths: included,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (LIVE_KEY.test(text)) throw new Error("write-scope manifest contains a key-like token");
  if (/probe-secret|apiKey|authorization/i.test(text)) {
    throw new Error("write-scope manifest contains a secret-like field");
  }
  return { manifest, text };
}

function realHomeFingerprint() {
  if (!existsSync(REAL_HOME)) return { exists: false };
  const st = statSync(REAL_HOME);
  return {
    exists: true,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    names: readdirSync(REAL_HOME).sort(),
  };
}

function assertUnchangedRealHome(before, after) {
  assert.deepEqual(after, before, "real ~/.dsh changed during the probe");
}

function inventory(root) {
  const map = new Map();
  if (!existsSync(root)) return map;
  const visit = (abs, rel) => {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    const kind = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
    map.set(rel, {
      kind,
      size: st.size,
      mtimeMs: st.mtimeMs,
      target: kind === "link" ? String(readlinkSync(abs)) : null,
    });
    if (kind !== "dir") return;
    let names = [];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) visit(join(abs, name), rel ? `${rel}/${name}` : name);
  };
  visit(root, "");
  return map;
}

function diffInventory(before, after) {
  const changes = [];
  for (const [rel, rec] of after) {
    if (!rel) continue;
    const prev = before.get(rel);
    if (!prev) {
      changes.push({ op: "add", rel, ...rec });
      continue;
    }
    if (prev.kind !== rec.kind || prev.size !== rec.size || prev.target !== rec.target || prev.mtimeMs !== rec.mtimeMs) {
      changes.push({ op: "change", rel, ...rec, previous: prev });
    }
  }
  for (const [rel, rec] of before) {
    if (!rel) continue;
    if (!after.has(rel)) changes.push({ op: "remove", rel, ...rec });
  }
  return changes;
}

function scopeEntries(changes, root) {
  return changes.map((change) => {
    const kind = change.kind === "link" || change.kind === "dir" || change.kind === "file" ? change.kind : "file";
    const classified = classifyWritePath(change.rel, kind, root);
    return {
      op: change.op,
      root,
      rel: change.rel,
      kind,
      role: classified.role,
      shared: classified.shared,
      excluded: classified.excluded,
      target: change.target ?? null,
    };
  });
}

function summarizeScope(entries) {
  const roles = {};
  const kinds = {};
  for (const entry of entries) {
    roles[entry.role] = (roles[entry.role] ?? 0) + 1;
    kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  }
  return {
    count: entries.length,
    roles,
    kinds,
    locks: entries.filter((e) => e.role === "lock").map((e) => e.rel),
    dependencies: entries.filter((e) => e.role === "dependency").map((e) => e.rel).slice(0, 40),
    links: entries.filter((e) => e.kind === "link" || e.role === "link").map((e) => ({ rel: e.rel, target: e.target })),
  };
}

function installedVersion(home, space) {
  const pkgPath = join(home, "profiles", space, "node_modules", ...PACKAGE.split("/"), "package.json");
  if (!existsSync(pkgPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const manifest = JSON.parse(readFileSync(join(home, "profiles", space, "package.json"), "utf8"));
  return {
    name: pkg.name ?? null,
    version: pkg.version ?? null,
    declared: manifest.dependencies?.[PACKAGE] ?? null,
    bundles: manifest.dsh?.profile?.bundles ?? [],
  };
}

function spaceConfigFingerprint(home, space) {
  const dir = join(home, "profiles", space);
  const files = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "cordis.patch.yml", "cordis.yml"];
  const out = {};
  for (const name of files) {
    const path = join(dir, name);
    out[name] = existsSync(path) ? sha256File(path) : null;
  }
  return out;
}

function writeMarkers(home, space, token) {
  for (const kind of ["sessions", "storages"]) {
    const dir = join(home, "hub", space, kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marker.json"), `${JSON.stringify({ space, kind, token })}\n`);
  }
}

function markerFingerprint(home, space) {
  const out = {};
  for (const kind of ["sessions", "storages"]) {
    const path = join(home, "hub", space, kind, "marker.json");
    out[kind] = existsSync(path) ? sha256File(path) : null;
  }
  return out;
}

function credentialFingerprint(home) {
  const out = {};
  for (const name of [".credentials.yaml", ".anonymous-user-id"]) {
    const path = join(home, name);
    out[name] = existsSync(path) ? sha256File(path) : null;
  }
  return out;
}

function copyTreeRaw(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) copyNodeRaw(join(src, name), join(dest, name));
}

function copyNodeRaw(from, to) {
  const st = lstatSync(from);
  if (st.isSymbolicLink()) {
    mkdirSync(dirname(to), { recursive: true });
    const target = String(readlinkSync(from));
    try {
      symlinkSync(target, to, followsDirectory(from) ? "dir" : "file");
    } catch (error) {
      if (process.platform === "win32") {
        symlinkSync(resolve(dirname(from), target), to, "junction");
        return;
      }
      throw error;
    }
    return;
  }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyNodeRaw(join(from, name), join(to, name));
    return;
  }
  if (st.isFile()) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

function followsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function copyRoot(src, dest, fallbackRuntimeRoot) {
  if (!existsSync(src)) return { method: "missing" };
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  const st = lstatSync(src);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    try {
      copyLinkedTree(src, dest, fallbackRuntimeRoot);
      return { method: "copyLinkedTree" };
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).includes("External link")) throw error;
      copyTreeRaw(src, dest);
      return { method: "raw-external-links", error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (st.isSymbolicLink()) {
    copyNodeRaw(src, dest);
    return { method: "link" };
  }
  copyFileSync(src, dest);
  return { method: "file" };
}

function hashTree(root) {
  const hash = createHash("sha256");
  const inv = inventory(root);
  for (const rel of [...inv.keys()].sort()) {
    const rec = inv.get(rel);
    hash.update(rel);
    hash.update(rec.kind);
    if (rec.kind === "file") hash.update(readFileSync(join(root, ...rel.split("/"))));
    if (rec.kind === "link") hash.update(String(rec.target ?? ""));
  }
  return hash.digest("hex");
}

function independentRoots(space) {
  return [`profiles/${space}`];
}

function packProbePlugin(nodeExe, npmCli, destDir, version) {
  const src = join(destDir, `src-${version}`);
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "package.json"),
    `${JSON.stringify(
      {
        name: PACKAGE,
        version,
        private: true,
        type: "module",
        main: "./index.js",
        files: ["index.js", "cordis.patch.yml"],
        exports: { ".": "./index.js", "./cordis.patch.yml": "./cordis.patch.yml" },
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(src, "index.js"),
    `export const name = "dsh-spaces-write-scope-probe";\nexport function apply() {}\n`,
  );
  writeFileSync(
    join(src, "cordis.patch.yml"),
    `- insert:\n    - id: dsh-spaces-write-scope-probe\n      name: '${PACKAGE}'\n      config: {}\n`,
  );
  const packed = run(nodeExe, [npmCli, "pack", src, "--pack-destination", destDir], {
    timeoutMs: 60_000,
    label: `npm pack ${PACKAGE}@${version}`,
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
  const name = packed
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const tarball = name ? join(destDir, name) : "";
  if (!tarball || !existsSync(tarball)) throw new Error(`npm pack did not produce ${version}`);
  if (tarball.includes(" ")) throw new Error(`tarball path contains spaces: ${tarball}`);
  return resolve(tarball);
}

function resolveOfficialCli() {
  try {
    const bin = dshBin();
    return { bin, version: cliVersion(bin), source: process.env.DSH_TEST_BIN?.trim() ? "DSH_TEST_BIN" : "verify-spaces-distribution" };
  } catch (error) {
    const managed = process.env.APPDATA
      ? join(process.env.APPDATA, "dsh-spaces", "dsh-cli", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
      : "";
    if (managed && existsSync(managed)) {
      return { bin: resolve(managed), version: cliVersion(managed), source: "managed-cli" };
    }
    throw error;
  }
}

function cliRuntimeRoot(bin) {
  return resolve(dirname(bin), "..", "..", "..", "..");
}

function offlineIsolated(home, nodeExe, tooling) {
  const env = isolatedEnv(home, nodeExe, tooling);
  env.npm_config_offline = "true";
  env.npm_config_prefer_offline = "true";
  env.npm_config_fetch_retries = "0";
  return env;
}

function runDshOffline(nodeExe, bin, home, tooling, args, timeoutMs, label, logPath) {
  return run(nodeExe, [bin, ...args], {
    env: offlineIsolated(home, nodeExe, tooling),
    timeoutMs,
    label,
    logPath,
  });
}

function capturePair(home, store) {
  return { home: inventory(home), store: inventory(store) };
}

function scopeFromPair(before, after) {
  const home = scopeEntries(diffInventory(before.home, after.home), "home");
  const store = scopeEntries(diffInventory(before.store, after.store), "store");
  return [...home, ...store];
}

function collectLinks(root, limit = 20) {
  const links = [];
  if (!existsSync(root)) return links;
  for (const [rel, rec] of inventory(root)) {
    if (rec.kind !== "link") continue;
    links.push({ rel, target: rec.target });
    if (links.length >= limit) break;
  }
  return links;
}

function assertScopeNamesInstallFiles(scope, home, label) {
  if (scope.length === 0) throw new Error(`${label}: write scope is empty`);
  const summary = summarizeScope(scope.filter((entry) => !entry.excluded));
  if (summary.locks.length === 0) throw new Error(`${label}: write scope has no lock files`);
  const hasDeps =
    summary.roles.dependency !== undefined ||
    scope.some((entry) => entry.rel.includes("node_modules"));
  if (!hasDeps) throw new Error(`${label}: write scope has no dependency paths`);
  const sharedFallbackLinks = collectLinks(join(home, "profiles", "node_modules"));
  if (summary.links.length === 0 && sharedFallbackLinks.length === 0) {
    throw new Error(`${label}: write scope named no links and profiles/node_modules has none`);
  }
  summary.sharedFallbackLinks = sharedFallbackLinks;
  return summary;
}

function preflight() {
  const probeHome = mkdtempSync(join(tmpdir(), "dsh-spaces-write-scope-preflight-"));
  try {
    refuseRealHome(probeHome);
    let refused = false;
    try {
      refuseRealHome(REAL_HOME);
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).includes("refusing real")) throw error;
      refused = true;
    }
    if (!refused) throw new Error("refuseRealHome accepted ~/.dsh");
  } finally {
    rmSync(probeHome, { recursive: true, force: true });
  }
  pass("disposable Home is required; real user Home is refused");

  const fixture = [
    { root: "home", rel: "profiles/alpha/pnpm-lock.yaml", kind: "file" },
    { root: "home", rel: "profiles/alpha/node_modules/@dsh-spaces/write-scope-probe", kind: "dir" },
    { root: "home", rel: "profiles/node_modules/ms", kind: "link" },
    { root: "home", rel: "hub/alpha/sessions/chat.jsonl", kind: "file" },
    { root: "home", rel: "hub/web/storages/data.json", kind: "file" },
    { root: "home", rel: ".credentials.yaml", kind: "file" },
  ].map((row) => ({ ...row, ...classifyWritePath(row.rel, row.kind, row.root) }));
  assert.equal(fixture.find((row) => row.rel.endsWith("pnpm-lock.yaml"))?.role, "lock");
  assert.equal(fixture.find((row) => row.rel.includes("node_modules/@dsh-spaces"))?.role, "dependency");
  assert.equal(fixture.find((row) => row.rel.includes("sessions"))?.excluded, true);
  assert.equal(fixture.find((row) => row.rel.includes("storages"))?.excluded, true);
  assert.equal(fixture.find((row) => row.rel.endsWith(".credentials.yaml"))?.excluded, true);
  const digest = createHash("sha256")
    .update(JSON.stringify(fixture.filter((row) => !row.excluded).map((row) => row.rel)))
    .digest("hex");
  const { manifest, text } = buildWriteScopeManifest({
    packageName: PACKAGE,
    spaceId: ALPHA,
    resolvedVersion: VERSION_A,
    contentDigest: digest,
    paths: fixture,
  });
  assert.equal(manifest.excluded.sessions, true);
  assert.equal(manifest.excluded.storages, true);
  assert.equal(manifest.excluded.web, true);
  assert.equal(manifest.excluded.credentials, true);
  assert.equal(manifest.paths.some((row) => /sessions|storages|credentials|profiles\/web/.test(row.rel)), false);
  assert.equal(LIVE_KEY.test(text), false);
  JSON.parse(text);
  pass("write-scope classifier excludes sessions/storages/web/credentials; hash manifest has no secret paths");
  return { status: "preflight", proved };
}

function assertNoHardcodedUserHome() {
  const text = readFileSync(THIS_FILE, "utf8");
  if (text.includes(join(homedir(), ".dsh").replaceAll("\\", "\\\\")) && !text.includes("REAL_HOME")) {
    throw new Error("probe hardcodes the real Home path as a write target");
  }
}

async function experiment(out) {
  assertNoHardcodedUserHome();
  const nodeExe = process.execPath;
  let cli;
  try {
    cli = resolveOfficialCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(join(out, "cli-unavailable.log"), `${message}\n`, "utf8");
    preflight();
    report.status = "cli-unavailable";
    report.error = message;
    writeJson(join(out, "results.json"), report);
    console.log("\nPLUGIN WRITE-SCOPE: CLI UNAVAILABLE");
    return report;
  }
  pass(`official CLI ${cli.version} from ${cli.source}`);

  const beforeReal = realHomeFingerprint();
  const session = mkdtempSync(join(tmpdir(), "dsh-spaces-write-scope-"));
  refuseRealHome(session);
  const tooling = {
    shim: join(session, "bin"),
    pnpmHome: join(session, "pnpm-home"),
    store: join(session, "pnpm-store"),
    cache: join(session, "npm-cache"),
  };
  for (const path of Object.values(tooling)) mkdirSync(path, { recursive: true });
  writePnpmShim(tooling.shim, nodeExe, resolvePnpmCjs());
  const npmCli = resolveNpmCli(nodeExe);
  const packDir = mkdtempSync(join(tmpdir(), "dsh-write-scope-pack-"));
  const tarballA = packProbePlugin(nodeExe, npmCli, packDir, VERSION_A);
  const tarballB = packProbePlugin(nodeExe, npmCli, packDir, VERSION_B);
  pass(`packed ${PACKAGE}@${VERSION_A} and @${VERSION_B}`);

  const home = join(session, "home");
  mkdirSync(home);
  refuseRealHome(home);
  if (samePath(home, REAL_HOME) || resolve(home).toLowerCase().startsWith(resolve(REAL_HOME).toLowerCase() + sep)) {
    throw new Error("disposable Home resolved inside ~/.dsh");
  }

  const seedLog = join(out, "seed.log");
  writeFileSync(seedLog, "", "utf8");
  runDsh(nodeExe, cli.bin, home, tooling, ["--profile", "web", "--dump-config"], DUMP_MS, "seed web", seedLog);
  for (const name of [ALPHA, BETA]) {
    runDsh(
      nodeExe,
      cli.bin,
      home,
      tooling,
      ["--profile", name, "--from-default-profile", "web", "--dump-config"],
      DUMP_MS,
      `seed ${name}`,
      seedLog,
    );
  }
  pass("seeded web plus two ordinary spaces from official dump-config");

  writeFileSync(join(home, ".credentials.yaml"), "probe-secret\n");
  writeFileSync(join(home, ".anonymous-user-id"), "probe-machine\n");
  const markerToken = randomUUID();
  writeMarkers(home, ALPHA, `${markerToken}-alpha`);
  writeMarkers(home, BETA, `${markerToken}-beta`);
  writeMarkers(home, "web", `${markerToken}-web`);
  const peerBefore = {
    config: spaceConfigFingerprint(home, BETA),
    markers: markerFingerprint(home, BETA),
    credentials: credentialFingerprint(home),
  };
  const webBefore = {
    config: spaceConfigFingerprint(home, "web"),
    markers: markerFingerprint(home, "web"),
  };

  const addAlphaLog = join(out, "plugin-add-alpha.log");
  writeFileSync(addAlphaLog, "", "utf8");
  const beforeAlpha = capturePair(home, tooling.store);
  runDshRetry(
    nodeExe,
    cli.bin,
    home,
    tooling,
    ["plugin", "--profile", ALPHA, "add", tarballA],
    PLUGIN_MS,
    "dsh plugin add alpha",
    addAlphaLog,
  );
  const afterAlpha = capturePair(home, tooling.store);
  const addAlphaScope = scopeFromPair(beforeAlpha, afterAlpha);
  assertProtectedPathsUntouched(addAlphaScope, "alpha add");
  const addAlphaSummary = assertScopeNamesInstallFiles(addAlphaScope, home, "alpha add");
  const alphaInstalled = installedVersion(home, ALPHA);
  if (!alphaInstalled || alphaInstalled.version !== VERSION_A) {
    throw new Error(`alpha did not resolve ${PACKAGE}@${VERSION_A}: ${JSON.stringify(alphaInstalled)}`);
  }
  pass(`alpha installed ${PACKAGE}@${alphaInstalled.version}; write scope ${addAlphaSummary.count} paths`);

  const addBetaLog = join(out, "plugin-add-beta.log");
  writeFileSync(addBetaLog, "", "utf8");
  const beforeBeta = capturePair(home, tooling.store);
  runDshRetry(
    nodeExe,
    cli.bin,
    home,
    tooling,
    ["plugin", "--profile", BETA, "add", tarballB],
    PLUGIN_MS,
    "dsh plugin add beta",
    addBetaLog,
  );
  const afterBeta = capturePair(home, tooling.store);
  const addBetaScope = scopeFromPair(beforeBeta, afterBeta);
  assertProtectedPathsUntouched(addBetaScope, "beta add");
  const addBetaSummary = assertScopeNamesInstallFiles(addBetaScope, home, "beta add");
  const betaInstalled = installedVersion(home, BETA);
  if (!betaInstalled || betaInstalled.version !== VERSION_B) {
    throw new Error(`beta did not resolve ${PACKAGE}@${VERSION_B}: ${JSON.stringify(betaInstalled)}`);
  }
  if (alphaInstalled.version === betaInstalled.version) {
    throw new Error("both spaces resolved the same version");
  }
  pass(`beta installed ${PACKAGE}@${betaInstalled.version}; versions differ`);

  const fallbackRuntimeRoot = cliRuntimeRoot(cli.bin);
  const backup = join(session, "measured-baseline");
  const copyMethods = {};
  for (const rel of independentRoots(ALPHA)) {
    copyMethods[rel] = copyRoot(join(home, ...rel.split("/")), join(backup, ...rel.split("/")), fallbackRuntimeRoot);
  }
  const storeChanged = addAlphaScope.some((entry) => entry.root === "store" && !entry.excluded);
  if (storeChanged) {
    copyMethods.store = copyRoot(tooling.store, join(backup, "store"), fallbackRuntimeRoot);
  }
  const sharedNm = addAlphaScope.some((entry) => entry.root === "home" && entry.rel.startsWith("profiles/node_modules"));
  if (sharedNm) {
    copyMethods["profiles/node_modules"] = copyRoot(
      join(home, "profiles", "node_modules"),
      join(backup, "profiles", "node_modules"),
      fallbackRuntimeRoot,
    );
  }
  const digest = hashTree(join(backup, "profiles", ALPHA));
  const measuredPaths = addAlphaScope
    .filter((entry) => !entry.excluded)
    .map((entry) => ({
      root: entry.root,
      rel: entry.rel,
      kind: entry.kind,
      role: entry.role,
      shared: entry.shared,
      excluded: false,
    }));
  const peerTouched = addAlphaScope.some(
    (entry) =>
      entry.root === "home" &&
      (entry.rel === `profiles/${BETA}` || entry.rel.startsWith(`profiles/${BETA}/`)),
  );
  const sharedDepTouched = addAlphaScope.some((entry) => entry.shared && !entry.excluded && entry.op !== "change");
  let boundary = !peerTouched && copyMethods[`profiles/${ALPHA}`]?.method === "copyLinkedTree"
    ? "independent-per-space"
    : "shared-deps-require-pause";
  if (sharedDepTouched && copyMethods[`profiles/${ALPHA}`]?.method !== "copyLinkedTree") {
    boundary = "shared-deps-require-pause";
  }

  const peerAfterInstall = {
    config: spaceConfigFingerprint(home, BETA),
    markers: markerFingerprint(home, BETA),
    credentials: credentialFingerprint(home),
  };
  const alphaMarkersBeforeReplay = markerFingerprint(home, ALPHA);
  assert.deepEqual(markerFingerprint(home, "web"), webBefore.markers, "web sessions/storages changed by plugin add");
  assert.deepEqual(spaceConfigFingerprint(home, "web"), webBefore.config, "web profile changed by plugin add");

  const removeLog = join(out, "plugin-remove-alpha.log");
  writeFileSync(removeLog, "", "utf8");
  const beforeRemove = capturePair(home, tooling.store);
  runDshRetry(
    nodeExe,
    cli.bin,
    home,
    tooling,
    ["plugin", "--profile", ALPHA, "remove", PACKAGE],
    PLUGIN_MS,
    "dsh plugin remove alpha",
    removeLog,
  );
  const afterRemove = capturePair(home, tooling.store);
  const removeScope = scopeFromPair(beforeRemove, afterRemove);
  assertProtectedPathsUntouched(removeScope, "alpha remove");
  const removeSummary = summarizeScope(removeScope.filter((entry) => !entry.excluded));
  if (installedVersion(home, ALPHA)) throw new Error("alpha still has the probe package after remove");
  if (installedVersion(home, BETA)?.version !== VERSION_B) throw new Error("beta version changed during alpha remove");
  pass(`alpha remove write scope ${removeSummary.count} paths; beta still ${VERSION_B}`);

  for (const rel of independentRoots(ALPHA)) {
    copyRoot(join(backup, ...rel.split("/")), join(home, ...rel.split("/")), fallbackRuntimeRoot);
  }
  let usedSharedCopy = false;
  const dumpLog = join(out, "dump-after-baseline-replay.log");
  writeFileSync(dumpLog, "", "utf8");
  let replayDump;
  try {
    replayDump = runDshOffline(
      nodeExe,
      cli.bin,
      home,
      tooling,
      ["--profile", ALPHA, "--dump-config"],
      DUMP_MS,
      "offline dump-config after measured copy replay",
      dumpLog,
    );
  } catch (error) {
    if (!storeChanged) throw error;
    info(`independent copy replay did not start offline; replaying measured store: ${error instanceof Error ? error.message : error}`);
    copyRoot(join(backup, "store"), tooling.store, fallbackRuntimeRoot);
    usedSharedCopy = true;
    boundary = "shared-deps-require-pause";
    replayDump = runDshOffline(
      nodeExe,
      cli.bin,
      home,
      tooling,
      ["--profile", ALPHA, "--dump-config"],
      DUMP_MS,
      "offline dump-config after shared-store copy replay",
      dumpLog,
    );
  }
  const replayed = installedVersion(home, ALPHA);
  if (!replayed || replayed.version !== VERSION_A) {
    throw new Error(`measured copy replay did not bring back ${VERSION_A}: ${JSON.stringify(replayed)}`);
  }
  assert.equal(hashTree(join(home, "profiles", ALPHA)), digest, "measured copy replay did not match baseline digest");
  if (!replayDump.includes("dsh-spaces-write-scope-probe") && !replayDump.includes(PACKAGE)) {
    info("dump-config did not name the probe id; installed package version still matched");
  }
  pass(`measured copy replay matched baseline digest and ${replayed.version}`);

  const peerAfter = {
    config: spaceConfigFingerprint(home, BETA),
    markers: markerFingerprint(home, BETA),
    credentials: credentialFingerprint(home),
  };
  assert.deepEqual(peerAfter.config, peerAfterInstall.config, "beta config changed by alpha copy replay");
  assert.deepEqual(peerAfter.markers, peerAfterInstall.markers, "beta sessions/storages changed by alpha copy replay");
  assert.deepEqual(peerAfter.credentials, peerBefore.credentials, "Home credentials changed");
  assert.deepEqual(markerFingerprint(home, ALPHA), alphaMarkersBeforeReplay, "alpha sessions/storages overwritten by copy replay");
  assert.deepEqual(markerFingerprint(home, "web"), webBefore.markers, "web sessions/storages changed by copy replay");
  assert.deepEqual(spaceConfigFingerprint(home, "web"), webBefore.config, "web profile changed by copy replay");
  pass("web/peer sessions/storages and credentials/runtime identity files untouched");

  const linkPreservingCopySufficient =
    copyMethods[`profiles/${ALPHA}`]?.method === "copyLinkedTree" && !usedSharedCopy;
  if (!linkPreservingCopySufficient && boundary === "independent-per-space") {
    boundary = "shared-deps-require-pause";
  }
  const { manifest, text: manifestText } = buildWriteScopeManifest({
    packageName: PACKAGE,
    spaceId: ALPHA,
    resolvedVersion: VERSION_A,
    contentDigest: digest,
    paths: measuredPaths,
  });
  writeFileSync(join(out, "write-scope-manifest.json"), manifestText);

  const afterReal = realHomeFingerprint();
  assertUnchangedRealHome(beforeReal, afterReal);
  pass("real ~/.dsh was not used and its listing/mtime did not change");

  report.status = "pass";
  report.cli = cli;
  report.package = PACKAGE;
  report.versions = { alpha: replayed.version, beta: betaInstalled.version };
  report.writeScope = {
    addAlpha: addAlphaSummary,
    addBeta: addBetaSummary,
    removeAlpha: removeSummary,
  };
  report.copyMethods = copyMethods;
  report.boundary = boundary;
  report.linkPreservingCopySufficient = linkPreservingCopySufficient;
  report.writeScopeManifest = manifest;
  report.home = posixRel(session, home);
  report.realHome = { used: false, unchanged: true };
  writeJson(join(out, "results.json"), report);
  writeJson(join(out, "write-scope.json"), {
    addAlpha: addAlphaScope,
    addBeta: addBetaScope,
    removeAlpha: removeScope,
  });
  console.log("\nPLUGIN WRITE-SCOPE: PASS");
  return report;
}

async function main() {
  const out = outputDir();
  mkdirSync(out, { recursive: true });
  report.output = out;
  report.startedAt = new Date().toISOString();
  if (process.argv.includes("--preflight")) {
    const result = preflight();
    writeJson(join(out, "preflight.json"), result);
    console.log("\nPLUGIN WRITE-SCOPE PREFLIGHT: PASS");
    return;
  }
  await experiment(out);
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`FAIL  ${redact(message)}`);
    report.status = "fail";
    report.error = redact(error instanceof Error ? error.message : String(error));
    try {
      const out = outputDir();
      mkdirSync(out, { recursive: true });
      writeJson(join(out, "results.json"), report);
    } catch {
      // keep the original failure
    }
    process.exit(1);
  });
}
