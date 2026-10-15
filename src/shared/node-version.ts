export function isSupportedNodeVersion(version: string): boolean {
  return /^v?26\.\d+\.\d+(?:$|[-+])/.test(version);
}

export function assertSupportedNode(version = process.versions.node): void {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(`DSH Spaces requires Node.js 26.x; the current runtime is ${version}.`);
  }
}
