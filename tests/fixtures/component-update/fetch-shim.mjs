/**
 * Test-only Node --import loader for component-update acceptance.
 *
 * Redirects global fetch for fixed @dsh-spaces/plugin registry hosts onto a
 * loopback fixture HTTP origin. All other requests pass through unchanged.
 *
 * Refuses to load without an explicit disposable-Home flag set. Never reads
 * real ~/.dsh, credentials, or auth stores. Not a runtime backdoor: production
 * Supervisor/launcher entries must not import this module.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { rewritePluginRegistryUrl } from "./rewrite.mjs";

const FLAG = "DSH_TEST_COMPONENT_UPDATE";
const HOME_FLAG = "DSH_TEST_COMPONENT_UPDATE_HOME";
const FIXTURE_FLAG = "DSH_TEST_FIXTURE_REGISTRY";

function realDshHome() {
  return resolve(homedir(), ".dsh");
}

function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function inside(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  if (samePath(r, t)) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return process.platform === "win32"
    ? t.toLowerCase().startsWith(prefix.toLowerCase())
    : t.startsWith(prefix);
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && typeof input.url === "string") return input.url;
  return "";
}

function assertDisposableGate() {
  if (process.env[FLAG] !== "1") {
    throw new Error(
      "component-update fetch shim refuses to load without DSH_TEST_COMPONENT_UPDATE=1 (test-only; not a runtime backdoor)",
    );
  }
  const marked = process.env[HOME_FLAG]?.trim();
  if (!marked) {
    throw new Error("component-update fetch shim requires DSH_TEST_COMPONENT_UPDATE_HOME (explicit disposable Home)");
  }
  if (!isAbsolute(marked)) {
    throw new Error("DSH_TEST_COMPONENT_UPDATE_HOME must be an absolute path");
  }
  const home = process.env.DSH_SPACES_HOME?.trim() || process.env.DSH_HOME?.trim();
  if (!home) {
    throw new Error("component-update fetch shim requires DSH_HOME or DSH_SPACES_HOME");
  }
  if (!isAbsolute(home)) {
    throw new Error("DSH_HOME / DSH_SPACES_HOME must be an absolute disposable Home");
  }
  if (!samePath(home, marked)) {
    throw new Error("DSH_HOME / DSH_SPACES_HOME must equal DSH_TEST_COMPONENT_UPDATE_HOME");
  }
  const real = realDshHome();
  if (inside(real, home) || inside(real, marked)) {
    throw new Error("component-update fetch shim refuses real ~/.dsh");
  }
  const fixture = process.env[FIXTURE_FLAG]?.trim();
  if (!fixture) {
    throw new Error("component-update fetch shim requires DSH_TEST_FIXTURE_REGISTRY");
  }
  let origin;
  try {
    origin = new URL(fixture);
  } catch {
    throw new Error("DSH_TEST_FIXTURE_REGISTRY is not a URL");
  }
  if (origin.protocol !== "http:") {
    throw new Error("DSH_TEST_FIXTURE_REGISTRY must be loopback HTTP (local fixture, not a published registry)");
  }
  const host = origin.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("DSH_TEST_FIXTURE_REGISTRY must be 127.0.0.1 or localhost");
  }
  return origin.origin;
}

function installFetchPatch(fixtureOrigin) {
  const original = globalThis.fetch;
  if (typeof original !== "function") {
    throw new Error("component-update fetch shim requires globalThis.fetch");
  }
  const patched = function patchedFetch(input, init) {
    const url = requestUrl(input);
    const rewritten = rewritePluginRegistryUrl(url, fixtureOrigin);
    if (!rewritten) return original.call(this, input, init);
    if (typeof input === "string" || input instanceof URL) {
      return original.call(this, rewritten, init);
    }
    return original.call(this, rewritten, init);
  };
  patched.shim = "dsh-spaces-component-update-fixture";
  globalThis.fetch = patched;
}

const fixtureOrigin = assertDisposableGate();
installFetchPatch(fixtureOrigin);
