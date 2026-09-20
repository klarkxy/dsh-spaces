import { app } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNotRealHome, realDshHome } from "../adapters/node/home-guard";

export { assertNotRealHome, realDshHome } from "../adapters/node/home-guard";

/**
 * Resolve DSH_HOME.
 * Unpackaged (dev) always uses the repo sandbox unless DSH_SPACES_HOME is set.
 * Packaged builds default to ~/.dsh.
 */
export function resolveDshHome(): string {
  if (app.isPackaged) process.env.DSH_SPACES_PACKAGED = "1";
  const explicit = process.env.DSH_SPACES_HOME;
  if (explicit) {
    const home = resolve(explicit);
    assertNotRealHome(home);
    return home;
  }
  if (!app.isPackaged) {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../.sandbox/dsh-home");
  }
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME);
  return realDshHome();
}
