import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { satisfies } from "semver";

const DSH_PEER = /^@deepseek-ai\/dsh-/;

/** Peer ranges the current component build expects the host CLI release to satisfy. */
export function dshPeerRangesFromPackages(packageJsonPaths: readonly string[]): Record<string, string> {
  const ranges: Record<string, string> = {};
  for (const path of packageJsonPaths) {
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const peers = parsed && typeof parsed === "object"
      ? (parsed as { peerDependencies?: unknown }).peerDependencies
      : undefined;
    if (!peers || typeof peers !== "object") continue;
    for (const [name, range] of Object.entries(peers as Record<string, unknown>)) {
      if (!DSH_PEER.test(name) || typeof range !== "string" || !range.trim()) continue;
      ranges[name] = range;
    }
  }
  return ranges;
}

export function dshPeerRangesFromPayload(payloadRootLib: string): Record<string, string> {
  return dshPeerRangesFromPackages([
    join(payloadRootLib, "..", "package.json"),
    join(payloadRootLib, "view-bridge", "package.json"),
    join(payloadRootLib, "llm-bridge", "package.json"),
  ]);
}

export function dshPeerRangesFromProfile(profileDir: string): Record<string, string> {
  const modules = join(profileDir, "node_modules", "@dsh-spaces");
  return dshPeerRangesFromPackages([
    join(modules, "plugin", "package.json"),
    join(modules, "view-bridge", "package.json"),
    join(modules, "llm-bridge", "package.json"),
  ]);
}

/** Names and ranges the recorded CLI version does not satisfy. */
export function unmetDshPeers(version: string, ranges: Record<string, string>): string[] {
  const unmet: string[] = [];
  for (const [name, range] of Object.entries(ranges)) {
    let ok = false;
    try {
      ok = satisfies(version, range, { includePrerelease: true });
    } catch {
      ok = false;
    }
    if (!ok) unmet.push(`${name}@${range}`);
  }
  return unmet;
}

export function cliLoadError(version: string, unmet: readonly string[]): string {
  return `Recorded CLI ${version} cannot load this component: ${unmet.join(", ")}.`;
}

/** Regular component files shipped in one selected bridge. Extra installed files are ignored. */
export function payloadBridgeFiles(payloadRoot: string, bridge: string): string[] {
  const root = join(payloadRoot, bridge);
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      const abs = join(dir, name);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (rel === "lib" || rel.startsWith("lib/")) walk(abs, rel);
        continue;
      }
      if (!stat.isFile()) continue;
      if (rel === "package.json" || rel === "cordis.patch.yml" || rel.startsWith("lib/")) found.push(rel);
    }
  };
  walk(root, "");
  return found.sort();
}
