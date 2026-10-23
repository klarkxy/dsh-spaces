import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PackageSource, PluginCatalogEntry } from "../../../../shared/types";
import { DOWNLOAD_TIMEOUT_MS } from "./constants";
import { WorkbenchMaintenanceError } from "./errors";
import type { Packument } from "./types";

export function npmCatalogEntry(packageName: string): PluginCatalogEntry {
  const scoped = packageName.startsWith("@");
  const [owner, repo] = scoped ? packageName.slice(1).split("/") : ["npm", packageName];
  return {
    id: packageName.toLowerCase(),
    repo: repo || packageName,
    owner: owner || "npm",
    url: `https://www.npmjs.com/package/${packageName}`,
    tier: "verified-npm",
    packageName,
    installMethod: "npm",
    installSpec: packageName,
    runsBuildScript: false,
    description: packageName,
    tags: [],
    stars: 0,
    hasClient: false,
  };
}

export function assertVersionInPackument(packument: Packument, version: string): void {
  const tarball = packument.versions?.[version]?.dist?.tarball;
  if (typeof tarball !== "string" || !tarball) throw new WorkbenchMaintenanceError("workbench/not-found");
}

export function rewriteTarballUrl(url: string, source: PackageSource): string {
  if (source !== "china") return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "registry.npmjs.org" || parsed.hostname.endsWith(".npmjs.org")) {
      parsed.protocol = "https:";
      parsed.hostname = "registry.npmmirror.com";
      return parsed.toString();
    }
  } catch {
    return url;
  }
  return url;
}

export function writeAtomicBin(file: string, contents: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

export async function defaultFetcher(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: init?.headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
