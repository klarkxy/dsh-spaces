import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_MANAGER_FILE,
  HomeController,
  HomeControlPathError,
} from "../../../../src/adapters/node/home-controller";
import { invocationProfile } from "../../../../src/adapters/node/spaces-control";
import { samePath } from "../../../../src/adapters/node/home-guard";
import { PROFILE_NAME_RE } from "../../../../src/shared/types";
import type { WorkbenchRole } from "../../../../src/shared/workbench";

export interface HostIdentityInput {
  home?: string;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  allowRealHome?: boolean;
}

export interface HostIdentity {
  home: string | null;
  profileId: string | null;
  confirmed: boolean;
  role: WorkbenchRole;
  managerId: string | null;
  recoveryRequired: boolean;
  reasons: string[];
}

const IDENTITY_UNCONFIRMED =
  "Host identity could not be confirmed from DSH home, loader root, and invocation profile.";
const IDENTITY_DAMAGED = "Manager identity is damaged or ambiguous and cannot be guessed.";
const HOME_UNAVAILABLE = "The DSH home could not be opened safely.";

/**
 * Resolve the current profile role only from HomeController.roleOf(actual profile id).
 * Never infers manager from package name, plugin id, or environment role flags.
 * Does not call ensureManager and does not clear locks.
 */
export function resolveHostIdentity(input: HostIdentityInput = {}): HostIdentity {
  const env = input.env ?? process.env;
  const argv = input.argv ?? process.argv;
  const configured = (input.home ?? env.DSH_HOME?.trim() ?? join(homedir(), ".dsh")).trim();
  const invoked = invocationProfile(argv);
  const fromBase = profileDirFromBaseUrl(input.baseUrl);
  const home = realDirectory(configured);
  if (!home || !invoked || !fromBase) {
    return unconfirmed(home, IDENTITY_UNCONFIRMED);
  }
  const expected = join(home, "profiles", invoked);
  if (!sameContainedPath(expected, fromBase, home)) {
    return unconfirmed(home, IDENTITY_UNCONFIRMED);
  }

  let controller: HomeController;
  try {
    controller = new HomeController(home, { allowRealHome: input.allowRealHome === true });
  } catch {
    return {
      home,
      profileId: invoked,
      confirmed: true,
      role: "uninitialized",
      managerId: null,
      recoveryRequired: true,
      reasons: [HOME_UNAVAILABLE],
    };
  }

  try {
    const role = controller.roleOf(invoked);
    const managerId = role === "manager" ? invoked : readExistingManagerId(home);
    return {
      home,
      profileId: invoked,
      confirmed: true,
      role,
      managerId,
      recoveryRequired: false,
      reasons: [],
    };
  } catch (error) {
    if (error instanceof HomeControlPathError) {
      return {
        home,
        profileId: invoked,
        confirmed: true,
        role: "uninitialized",
        managerId: null,
        recoveryRequired: true,
        reasons: [IDENTITY_DAMAGED],
      };
    }
    return {
      home,
      profileId: invoked,
      confirmed: true,
      role: "uninitialized",
      managerId: null,
      recoveryRequired: true,
      reasons: [HOME_UNAVAILABLE],
    };
  }
}

function readExistingManagerId(home: string): string | null {
  const file = join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE);
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      version?: unknown;
      profileId?: unknown;
    };
    if (parsed.version !== 1 || typeof parsed.profileId !== "string") return null;
    if (!PROFILE_NAME_RE.test(parsed.profileId)) return null;
    return parsed.profileId;
  } catch {
    return null;
  }
}

function unconfirmed(home: string | null, reason: string): HostIdentity {
  return {
    home,
    profileId: null,
    confirmed: false,
    role: "uninitialized",
    managerId: null,
    recoveryRequired: false,
    reasons: [reason],
  };
}

function profileDirFromBaseUrl(baseUrl: string | undefined): string | null {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  try {
    const asUrl = baseUrl.includes("://") ? fileURLToPath(baseUrl) : resolve(baseUrl);
    const resolved = resolve(asUrl);
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  } catch {
    return null;
  }
}

function sameContainedPath(expected: string, actual: string, home: string): boolean {
  try {
    const left = existsSync(expected) ? realpathSync(expected) : resolve(expected);
    const right = existsSync(actual) ? realpathSync(actual) : resolve(actual);
    if (!inside(home, left) || !inside(home, right)) return false;
    return samePath(left, right);
  } catch {
    return false;
  }
}

function inside(root: string, target: string): boolean {
  const r = comparable(root);
  const t = comparable(target);
  if (samePath(r, t)) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

function comparable(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function realDirectory(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    return realpathSync(path);
  } catch {
    return null;
  }
}
