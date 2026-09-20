import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { RuntimeRef } from "../../shared/runtime";
import type { SnapshotRuntime } from "../../shared/snapshots";

export function readRuntimeRef(bin: string | undefined): RuntimeRef | undefined {
  if (!bin || !existsSync(bin)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(bin), "..", "package.json"), "utf8"));
    return pkg.name === "@deepseek-ai/dsh" && typeof pkg.version === "string" ? { bin, version: pkg.version } : undefined;
  } catch { return undefined; }
}

/** Keep the install prefix, including pnpm's dependency tree, in offline snapshots. */
export function describeRuntime(ref: RuntimeRef | undefined): SnapshotRuntime {
  if (!ref) throw new Error("No usable DSH runtime is selected.");
  const bin = resolve(ref.bin);
  const normalized = bin.replace(/\\/g, "/");
  const marker = normalized.indexOf("/node_modules/");
  if (marker < 0) throw new Error("Cannot snapshot this runtime layout. Install a managed DSH version first.");
  const root = resolve(normalized.slice(0, marker));
  return { root, version: ref.version, binRelative: relative(root, bin).replace(/\\/g, "/") };
}
