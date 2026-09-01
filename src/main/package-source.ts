import type { PackageSource } from "../shared/types";

export const NODE_VERSION = "22.16.0";
export const PNPM_VERSION = "10.29.2";

export function nodeArchiveName(platform = process.platform, arch = process.arch): string {
  const cpu = arch === "arm64" ? "arm64" : "x64";
  if (platform === "win32") return `node-v${NODE_VERSION}-win-${cpu}.zip`;
  if (platform === "darwin") return `node-v${NODE_VERSION}-darwin-${cpu}.tar.gz`;
  return `node-v${NODE_VERSION}-linux-${cpu}.tar.gz`;
}

export function nodeDownloadUrl(
  source: PackageSource,
  platform = process.platform,
  arch = process.arch,
): string {
  const file = nodeArchiveName(platform, arch);
  const base =
    source === "china"
      ? `https://npmmirror.com/mirrors/node/v${NODE_VERSION}`
      : `https://nodejs.org/dist/v${NODE_VERSION}`;
  return `${base}/${file}`;
}

export function npmRegistry(source: PackageSource): string {
  return source === "china" ? "https://registry.npmmirror.com" : "https://registry.npmjs.org";
}

export function electronMirror(source: PackageSource): string | undefined {
  return source === "china" ? "https://npmmirror.com/mirrors/electron/" : undefined;
}

export function sourceEnv(source: PackageSource): Record<string, string> {
  const registry = npmRegistry(source);
  const env: Record<string, string> = {
    npm_config_registry: registry,
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  const electron = electronMirror(source);
  if (electron) {
    env.ELECTRON_MIRROR = electron;
    env.npm_config_electron_mirror = electron;
  }
  if (source === "china") {
    env.NODEJS_ORG_MIRROR = `https://npmmirror.com/mirrors/node/`;
  }
  return env;
}
