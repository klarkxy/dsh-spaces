import { realpathSync } from "../../shared/node/filesystem";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import type { RuntimeRef } from "../../shared/runtime";
import type { SnapshotRuntime } from "../../shared/snapshots";

export function readRuntimeRef(bin: string | undefined): RuntimeRef | undefined {
  if (!bin || !existsSync(bin)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(bin), "..", "package.json"), "utf8"));
    return pkg.name === "@deepseek-ai/dsh" && typeof pkg.version === "string" ? { bin, version: pkg.version } : undefined;
  } catch { return undefined; }
}

/** Snapshot a managed prefix or the self-contained system package, never all global npm packages. */
export function describeRuntime(ref: RuntimeRef | undefined, trustedPrefix?: string): SnapshotRuntime {
  if (!ref) throw new Error("No usable DSH runtime is selected.");
  const bin = resolve(ref.bin);
  const packageRoot = resolve(dirname(bin), "..");
  const normalized = bin.replace(/\\/g, "/");
  const marker = normalized.lastIndexOf("/node_modules/@deepseek-ai/dsh/");
  if (marker < 0) throw new Error("Cannot snapshot this runtime layout.");
  const prefix = resolve(normalized.slice(0, marker));
  if (trustedPrefix && resolve(trustedPrefix) !== prefix) throw new Error("Runtime binary is outside its managed prefix.");
  const root = trustedPrefix ? resolve(trustedPrefix) : packageRoot;
  assertDependencyClosure(root, packageRoot);
  return { root, version: ref.version, binRelative: relative(root, bin).replace(/\\/g, "/") };
}

/** Resolve required packages as Node does, but stop at the declared snapshot boundary. */
function assertDependencyClosure(root: string, packageRoot: string): void {
  const seen = new Set<string>();
  const requests: { importer: string; name: string; packageRoot: string }[] = [];
  const inside = (target: string) => { const rel = relative(root, target); return !isAbsolute(rel) && !rel.split(/[\\/]/).includes(".."); };
  const visit = (dir: string): void => {
    const real = realpathSync(dir);
    if (!inside(real)) throw new Error("Runtime dependencies escape the snapshot scope.");
    if (seen.has(real)) return;
    seen.add(real);
    const pkg = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
    if (dir === packageRoot && pkg.name !== "@deepseek-ai/dsh") throw new Error("Runtime package identity is invalid.");
    const optional = pkg.optionalDependencies ?? {};
    const optionalPeers = pkg.peerDependenciesMeta ?? {};
    const peers = Object.keys(pkg.peerDependencies ?? {}).filter(name => !optionalPeers[name]?.optional);
    const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(optional), ...peers]);
    for (const name of names) {
      if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name)) throw new Error("Runtime dependency name is invalid.");
      // Use Node's ordered lookup paths, including its node_modules-ancestor
      // rules, from the real package location rather than its link alias.
      let found: string | undefined;
      const require = createRequire(join(real, "package.json"));
      for (const modules of require.resolve.paths(name) ?? []) {
        const candidate = join(modules, name);
        if (["", ".js", ".json", ".node"].some(extension => {
          const file = candidate + extension;
          return existsSync(file) && statSync(file).isFile();
        })) throw new Error("Runtime dependency entry is outside its declared package: " + name);
        if (existsSync(join(candidate, "package.json"))) { found = candidate; break; }
      }
      if (found) {
        requests.push({ importer: join(real, "package.json"), name, packageRoot: realpathSync(found) });
        visit(found);
      }
      else if (!(name in optional)) throw new Error("Runtime dependency is outside the snapshot scope or missing: " + name);
    }
  };
  visit(packageRoot);
  if (!requests.length) return;
  // A long-lived Supervisor's require.resolve caches package entry metadata.
  // Resolve this batch in a fresh process without loading dependency code or
  // inherited preload hooks; no retry or persistent worker is involved.
  const probe = spawnSync(process.execPath, ["--input-type=commonjs", "-e", RESOLVE_ENTRIES], {
    input: JSON.stringify(requests), encoding: "utf8", windowsHide: true,
    timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: undefined },
  });
  if (probe.error) throw new Error("Runtime dependency resolution failed.", { cause: probe.error });
  if (probe.status !== 0) throw new Error("Runtime dependency resolution failed: " + probe.stderr.trim());
  const entries: unknown = JSON.parse(probe.stdout);
  if (!Array.isArray(entries) || entries.length !== requests.length) throw new Error("Runtime dependency resolution returned invalid results.");
  entries.forEach((result: unknown, index) => {
    if (!result || typeof result !== "object") throw new Error("Runtime dependency resolution returned an invalid entry.");
    const { entry, code, message } = result as { entry?: unknown; code?: unknown; message?: unknown };
    if (typeof entry !== "string") {
      // Packages used only via subpaths or import conditions need not expose
      // a CommonJS root entry. Their manifests and closure were checked above.
      if (code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return;
      throw new Error("Runtime dependency resolution failed: " + (typeof message === "string" ? message : "invalid result"));
    }
    const actual = realpathSync(entry);
    if (!inside(actual)) throw new Error("Runtime dependencies escape the snapshot scope.");
    const request = requests[index]!;
    const packageRelative = relative(request.packageRoot, actual);
    if (isAbsolute(packageRelative) || packageRelative.split(/[\\/]/).includes("..")) {
      throw new Error("Runtime dependency entry is outside its declared package: " + request.name);
    }
  });
}

const RESOLVE_ENTRIES = `
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const requests = JSON.parse(readFileSync(0, 'utf8'));
const results = requests.map(({ importer, name }) => {
  try { return { entry: createRequire(importer).resolve(name) }; }
  catch (error) { return { code: error.code, message: error.message }; }
});
process.stdout.write(JSON.stringify(results));
`;
