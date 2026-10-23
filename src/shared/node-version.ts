import { satisfies } from "semver";

// Official Desktop 0.2.1-rc.2 runs plugins under Electron's Node 24.21.0.
export const SUPPORTED_NODE_RANGE = ">=24.21.0 <25.0.0 || >=26.0.0 <27.0.0";

export function isSupportedNodeVersion(version: string): boolean {
  return satisfies(version, SUPPORTED_NODE_RANGE);
}

export function assertSupportedNode(version = process.versions.node): void {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(`DSH Spaces requires Node.js 24.21+ (24.x) or 26.x; the current runtime is ${version}.`);
  }
}
