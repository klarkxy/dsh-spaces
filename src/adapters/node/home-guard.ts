import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const authorizedHomes = new Set<string>();

/** Product entrypoint authorization is scoped to one Home in this process. */
export function authorizeProductHome(home: string): void {
  authorizedHomes.add(resolve(home).toLowerCase());
}

export function isAuthorizedProductHome(home: string): boolean {
  const target = resolve(home).toLowerCase();
  return [...authorizedHomes].some(root => target === root || target.startsWith(root + sep));
}

export function realDshHome(): string {
  return join(homedir(), ".dsh");
}

export function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

export function isInsideRealHome(home: string): boolean {
  const real = resolve(realDshHome()).toLowerCase();
  const resolved = resolve(home).toLowerCase();
  return resolved === real || resolved.startsWith(real + sep);
}

/**
 * Refuse the user's production ~/.dsh unless this is a packaged app
 * (or the operator explicitly opted in). Node tests and unpackaged Electron
 * never write the real home.
 */
export function assertNotRealHome(home: string): void {
  if (isAuthorizedProductHome(home)) return;
  if (!isInsideRealHome(home)) return;
  if (process.env.DSH_SPACES_PACKAGED === "1") return;
  if (process.env.DSH_SPACES_ALLOW_REAL_HOME) return;
  throw new Error(
    `refusing to use the real DSH home: ${realDshHome()}. Set DSH_SPACES_HOME to a sandbox.`,
  );
}
