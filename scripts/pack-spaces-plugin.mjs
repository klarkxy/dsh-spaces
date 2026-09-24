#!/usr/bin/env node
/**
 * Pack @dsh-spaces/plugin and @dsh-spaces/view-bridge outside the package
 * trees. Default destination is a local directory without spaces.
 *
 * Does not delete stray *.tgz already sitting in packages/plugin or
 * packages/view-bridge (those were left by a null pack-destination). Detects
 * them, keeps them, and refuses if they would be nested into the archive.
 *
 *   node scripts/pack-spaces-plugin.mjs
 *   node scripts/pack-spaces-plugin.mjs --preflight
 *
 * Env: DSH_PACK_DEST (absolute, no spaces). Prints the current official
 * `dsh plugin --profile web add` command for the plugin tarball — that
 * tarball is the distribution unit (embedded supervisor + view-bridge).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = join(REPO, "packages", "plugin");
const VIEW_DIR = join(REPO, "packages", "view-bridge");
const LLM_DIR = join(REPO, "packages", "llm-bridge");
const SUPERVISOR_DIR = join(REPO, "packages", "supervisor");
const PACK_MS = 60_000;

/** v2 component payload. The plugin tarball is the distribution unit; this script does not publish. */
const COMPONENT_PAYLOAD_MANIFEST = "lib/supervisor/manifest.json";

const PLUGIN_REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "cordis.patch.yml",
  "lib/index.js",
  "lib/client.js",
  "lib/typert.host.js",
  "lib/typert.remote-client.js",
  "lib/supervisor/index.js",
  "lib/supervisor/launcher.mjs",
  COMPONENT_PAYLOAD_MANIFEST,
  "lib/supervisor/snapshot-worker.mjs",
  "lib/view-bridge/package.json",
  "lib/view-bridge/LICENSE",
  "lib/view-bridge/cordis.patch.yml",
  "lib/view-bridge/lib/index.js",
  "lib/view-bridge/lib/client.js",
  "lib/view-bridge/lib/settings.js",
  "lib/llm-bridge/package.json",
  "lib/llm-bridge/LICENSE",
  "lib/llm-bridge/cordis.patch.yml",
  "lib/llm-bridge/lib/index.js",
];

const VIEW_REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "cordis.patch.yml",
  "lib/index.js",
  "lib/client.js",
  "lib/settings.js",
];

const LLM_REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "cordis.patch.yml",
  "lib/index.js",
];

const FORBIDDEN_PACKED = [
  /\.tgz$/i,
  /(^|\/)\.sandbox(\/|$)/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)src\//,
  /(^|\/)node_modules\//,
];

function info(m) {
  console.log(`INFO  ${m}`);
}
function pass(m) {
  console.log(`PASS  ${m}`);
}

function hasSpace(path) {
  return /\s/.test(path);
}

function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function inside(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  if (samePath(r, t)) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return process.platform === "win32"
    ? t.toLowerCase().startsWith(prefix.toLowerCase())
    : t.startsWith(prefix);
}

function assertNoSpaces(path, label) {
  if (hasSpace(path)) {
    throw new Error(
      `${label} must not contain spaces (Windows dsh plugin add forwarding splits them): ${path}. Set DSH_PACK_DEST to an absolute directory without spaces.`,
    );
  }
}

function defaultPackDest() {
  const override = process.env.DSH_PACK_DEST?.trim();
  if (override) {
    const dest = resolve(override);
    if (!isAbsolute(override) && override !== dest) {
      throw new Error(`DSH_PACK_DEST must be an absolute path: ${override}`);
    }
    assertNoSpaces(dest, "DSH_PACK_DEST");
    return dest;
  }
  const dest = join(tmpdir(), "dsh-spaces-pack");
  assertNoSpaces(dest, "default pack destination (os.tmpdir()/dsh-spaces-pack)");
  return dest;
}

function listTarballs(dir) {
  try {
    return readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".tgz"));
  } catch {
    return [];
  }
}

function readPkg(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function resolveNpmCli(nodeExe) {
  const candidates = [
    join(dirname(nodeExe), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(nodeExe), "..", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(nodeExe), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const probe = spawnSync(nodeExe, ["-p", "require.resolve('npm/bin/npm-cli.js')"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (probe.status === 0 && probe.stdout.trim()) candidates.push(probe.stdout.trim());
  const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["npm"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  for (const line of (found.stdout || "").split(/\r?\n/)) {
    const loc = line.trim();
    if (!loc) continue;
    candidates.push(join(dirname(loc), "node_modules", "npm", "bin", "npm-cli.js"));
  }
  for (const path of candidates) {
    if (path && existsSync(path)) return resolve(path);
  }
  throw new Error("npm-cli.js not found. Use a Node install that ships npm, or put npm on PATH.");
}

function runNpmPack(nodeExe, npmCli, packageDir, dest, { dryRun }) {
  const args = [
    npmCli,
    "pack",
    packageDir,
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    dest,
  ];
  if (dryRun) args.push("--dry-run");
  const result = spawnSync(nodeExe, args, {
    cwd: REPO,
    encoding: "utf8",
    timeout: PACK_MS,
    windowsHide: true,
    env: {
      ...process.env,
      npm_config_ignore_scripts: "true",
      npm_config_offline: "true",
      npm_config_fund: "false",
      npm_config_audit: "false",
      npm_config_update_notifier: "false",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    throw new Error(`npm pack failed (${result.status}): ${output.slice(0, 1200)}`);
  }
  const start = (result.stdout || "").indexOf("[");
  if (start < 0) throw new Error("npm pack --json did not return an array");
  const rows = JSON.parse(result.stdout.slice(start));
  const row = rows[0];
  if (!row?.filename) throw new Error("npm pack --json missing filename");
  const files = Array.isArray(row.files)
    ? row.files.map((file) => String(file.path || file).replaceAll("\\", "/").replace(/^package\//, ""))
    : [];
  return {
    filename: row.filename,
    name: row.name,
    version: row.version,
    files,
    path: join(dest, row.filename),
  };
}

function listTarEntries(tgzPath) {
  const buf = gunzipSync(readFileSync(tgzPath));
  const names = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const sizeOct = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeOct, 8) || 0;
    const full = prefix ? `${prefix}/${name}` : name;
    if (full) names.push(full.replaceAll("\\", "/"));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!names.length) throw new Error(`tarball listed zero entries: ${tgzPath}`);
  return names;
}

function normalizePacked(entry) {
  return entry.replaceAll("\\", "/").replace(/^package\//, "");
}

function assertPackedFiles(label, files, required) {
  const set = new Set(files.map(normalizePacked));
  const missing = required.filter((rel) => !set.has(rel));
  if (missing.length) {
    throw new Error(`${label} tarball contents missing: ${missing.join(", ")}`);
  }
  const forbidden = [...set].filter((rel) => FORBIDDEN_PACKED.some((re) => re.test(rel)));
  if (forbidden.length) {
    throw new Error(`${label} tarball contains forbidden paths: ${forbidden.join(", ")}`);
  }
}

function assertManifest(pkg, { name, directory, keywords }) {
  const reasons = [];
  if (pkg.name !== name) reasons.push(`name=${pkg.name}`);
  if (!pkg.repository || pkg.repository.directory !== directory) {
    reasons.push(`repository.directory=${pkg.repository?.directory ?? "(missing)"}`);
  }
  if (!pkg.homepage) reasons.push("homepage");
  if (!pkg.bugs?.url) reasons.push("bugs.url");
  const have = Array.isArray(pkg.keywords) ? pkg.keywords : [];
  for (const word of keywords) {
    if (!have.includes(word)) reasons.push(`keywords missing ${word}`);
  }
  if (pkg.publishConfig?.access !== "public") reasons.push("publishConfig.access");
  if (pkg.private === true) reasons.push("must not be private");
  if (reasons.length) throw new Error(`${name} distribution metadata: ${reasons.join("; ")}`);
}

function warnStrayTarballs(dir, label) {
  const stray = listTarballs(dir);
  if (!stray.length) return stray;
  info(
    `${label} already contains tarball(s) left in place (not deleted): ${stray.join(", ")}. New packs go to DSH_PACK_DEST / os.tmpdir()/dsh-spaces-pack, never back into this directory.`,
  );
  return stray;
}

function nestedTgzFixture() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-nested-pack-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "nested-pack-fixture", version: "0.0.0", files: ["lib"] }, null, 2)}\n`,
    );
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib", "index.js"), "export {}\n");
    writeFileSync(join(dir, "lib", "nested.tgz"), "not-a-real-tarball\n");
    const dest = mkdtempSync(join(tmpdir(), "dsh-spaces-nested-dest-"));
    try {
      const nodeExe = process.execPath;
      const npmCli = resolveNpmCli(nodeExe);
      const packed = runNpmPack(nodeExe, npmCli, dir, dest, { dryRun: true });
      const nested = packed.files.some((rel) => rel.toLowerCase().endsWith(".tgz"));
      if (!nested) {
        throw new Error("nested-tgz fixture dry-run did not include lib/nested.tgz; detector would miss real nesting");
      }
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function printAddCommand(pluginTgz) {
  const abs = resolve(pluginTgz);
  assertNoSpaces(abs, "plugin tarball path");
  const command = `dsh plugin --profile web add ${abs}`;
  console.log("");
  console.log("User install (ordinary web). Pack first with: pnpm run pack:plugin");
  console.log(`  ${command}`);
  console.log("  dsh web");
  console.log("Then click 初始化 Spaces / Initialize Spaces. This package is not on the npm registry.");
  return command;
}

function preflightOnDisk() {
  const pluginPkg = readPkg(PLUGIN_DIR);
  const viewPkg = readPkg(VIEW_DIR);
  const supervisorPkg = readPkg(SUPERVISOR_DIR);
  assertManifest(pluginPkg, {
    name: "@dsh-spaces/plugin",
    directory: "packages/plugin",
    keywords: ["dsh-plugin", "deepseek-harness"],
  });
  assertManifest(viewPkg, {
    name: "@dsh-spaces/view-bridge",
    directory: "packages/view-bridge",
    keywords: ["dsh-plugin", "deepseek-harness"],
  });
  const llmPkg = readPkg(LLM_DIR);
  assertManifest(llmPkg, {
    name: "@dsh-spaces/llm-bridge",
    directory: "packages/llm-bridge",
    keywords: ["dsh-plugin", "deepseek-harness"],
  });
  if (supervisorPkg.private !== true) {
    throw new Error("@dsh-spaces/supervisor must stay private; the plugin tarball is the distribution unit");
  }
  if (supervisorPkg.publishConfig?.access === "public") {
    throw new Error("@dsh-spaces/supervisor must not be a public package");
  }
  const missing = [];
  for (const rel of PLUGIN_REQUIRED) {
    if (!existsSync(join(PLUGIN_DIR, rel))) missing.push(`packages/plugin/${rel}`);
  }
  for (const rel of VIEW_REQUIRED) {
    if (!existsSync(join(VIEW_DIR, rel))) missing.push(`packages/view-bridge/${rel}`);
  }
  for (const rel of LLM_REQUIRED) {
    if (!existsSync(join(LLM_DIR, rel))) missing.push(`packages/llm-bridge/${rel}`);
  }
  if (missing.length) {
    throw new Error(`prebuilt entries missing (run npm run build:spaces from the repo root): ${missing.join(", ")}`);
  }
  const pluginStray = warnStrayTarballs(PLUGIN_DIR, "packages/plugin");
  const viewStray = warnStrayTarballs(VIEW_DIR, "packages/view-bridge");
  warnStrayTarballs(LLM_DIR, "packages/llm-bridge");
  const dest = defaultPackDest();
  if (inside(PLUGIN_DIR, dest) || inside(VIEW_DIR, dest) || inside(LLM_DIR, dest) || inside(SUPERVISOR_DIR, dest)) {
    throw new Error(`pack destination is inside a package tree: ${dest}`);
  }
  nestedTgzFixture();
  pass("nested-tgz fixture is detected from dry-run file list, not from tarball existence");
  return { pluginPkg, viewPkg, dest, pluginStray, viewStray };
}

function packOne(nodeExe, npmCli, packageDir, dest, required, label) {
  const dry = runNpmPack(nodeExe, npmCli, packageDir, dest, { dryRun: true });
  assertPackedFiles(label, dry.files, required);
  if (dry.files.some((rel) => rel.toLowerCase().endsWith(".tgz"))) {
    throw new Error(`${label} would nest a .tgz (dry-run file list)`);
  }
  const packed = runNpmPack(nodeExe, npmCli, packageDir, dest, { dryRun: false });
  if (!existsSync(packed.path)) throw new Error(`${label} npm pack filename missing on disk: ${packed.path}`);
  if (inside(packageDir, packed.path)) {
    throw new Error(`${label} wrote the tarball back into the package directory`);
  }
  const entries = listTarEntries(packed.path).map(normalizePacked);
  assertPackedFiles(label, entries, required);
  if (entries.some((rel) => rel.toLowerCase().endsWith(".tgz"))) {
    throw new Error(`${label} tarball contents include a nested .tgz`);
  }
  const sha256 = createHash("sha256").update(readFileSync(packed.path)).digest("hex");
  pass(`${label} packed ${packed.filename} sha256=${sha256} files=${entries.length}`);
  return { ...packed, sha256, entries };
}

async function main() {
  const preflightOnly = process.argv.includes("--preflight");
  const { pluginPkg, dest } = preflightOnDisk();
  const payload = await validateBuiltPayload();
  const nodeExe = process.execPath;
  const npmCli = resolveNpmCli(nodeExe);
  mkdirSync(dest, { recursive: true });

  if (preflightOnly) {
    const pluginDry = runNpmPack(nodeExe, npmCli, PLUGIN_DIR, dest, { dryRun: true });
    const viewDry = runNpmPack(nodeExe, npmCli, VIEW_DIR, dest, { dryRun: true });
    const llmDry = runNpmPack(nodeExe, npmCli, LLM_DIR, dest, { dryRun: true });
    assertPackedFiles("@dsh-spaces/plugin", pluginDry.files, PLUGIN_REQUIRED);
    assertPackedFiles("@dsh-spaces/view-bridge", viewDry.files, VIEW_REQUIRED);
    assertPackedFiles("@dsh-spaces/llm-bridge", llmDry.files, LLM_REQUIRED);
    pass("preflight dry-run file lists include prebuilt payload and exclude nested tarballs");
    const preview = join(dest, pluginDry.filename);
    printAddCommand(preview);
    console.log("(preflight: command path is the destination filename; tarball is not written)");
    return { status: "preflight", dest, plugin: pluginDry, view: viewDry, llm: llmDry };
  }

  const plugin = packOne(nodeExe, npmCli, PLUGIN_DIR, dest, PLUGIN_REQUIRED, "@dsh-spaces/plugin");
  verifyPackedPayload(plugin.path, payload);
  const view = packOne(nodeExe, npmCli, VIEW_DIR, dest, VIEW_REQUIRED, "@dsh-spaces/view-bridge");
  const llm = packOne(nodeExe, npmCli, LLM_DIR, dest, LLM_REQUIRED, "@dsh-spaces/llm-bridge");
  const command = printAddCommand(plugin.path);
  const report = {
    status: "packed",
    dest,
    plugin,
    view,
    llm,
    add: command,
    unpublished: true,
    componentDigest: payload.digest,
    note: `${pluginPkg.name}@${pluginPkg.version} is the distribution unit. Supervisor stays private. Not on npm.`,
    at: new Date().toISOString(),
  };
  writeFileSync(join(dest, "pack-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function validateBuiltPayload() {
  const scratch = mkdtempSync(join(tmpdir(), "dsh-spaces-pack-validate-"));
  try {
    const outfile = join(scratch, "validator.mjs");
    await build({ absWorkingDir: REPO, entryPoints: ["src/adapters/node/component-payload.ts"],
      outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const validator = await import(pathToFileURL(outfile).href);
    return validator.validateComponentPayload(join(PLUGIN_DIR, "lib"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function verifyPackedPayload(archive, payload) {
  const bytes = gunzipSync(readFileSync(archive));
  const files = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const string = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/, "");
    const name = string(0, 100), prefix = string(345, 500);
    const size = Number.parseInt(string(124, 136).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) throw new Error("Invalid packed payload size");
    const path = normalizePacked(prefix ? `${prefix}/${name}` : name);
    const type = header[156];
    if (type === 0 || type === 48) {
      if (files.has(path)) throw new Error(`Duplicate packed payload file: ${path}`);
      files.set(path, bytes.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const manifest = files.get(COMPONENT_PAYLOAD_MANIFEST);
  if (!manifest || JSON.stringify(JSON.parse(manifest.toString("utf8"))) !== JSON.stringify(payload.manifest)) {
    throw new Error("Packed component manifest differs from the verified build");
  }
  for (const file of payload.files) {
    const content = files.get(file.path);
    if (!content || content.length !== file.size || createHash("sha256").update(content).digest("hex") !== file.sha256) {
      throw new Error(`Packed component differs from the verified build: ${file.path}`);
    }
  }
  pass(`packed component payload verified digest=${payload.digest}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`FAIL  ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export {
  COMPONENT_PAYLOAD_MANIFEST,
  PLUGIN_REQUIRED,
  VIEW_REQUIRED,
  LLM_REQUIRED,
  defaultPackDest,
  assertNoSpaces,
  listTarEntries,
  normalizePacked,
  printAddCommand,
  resolveNpmCli,
  runNpmPack,
};
