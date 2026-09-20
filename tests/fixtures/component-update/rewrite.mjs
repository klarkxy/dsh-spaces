/**
 * Pure URL rewrite for the component-update fixture registry.
 * Maps only official @dsh-spaces/plugin packument/tarball URLs onto a
 * loopback fixture origin. Every other URL is left unchanged.
 *
 * This is not a published npm registry.
 */
export const PLUGIN_PACKAGE = "@dsh-spaces/plugin";

const REGISTRY_HOSTS = new Set(["registry.npmjs.org", "registry.npmmirror.com"]);
const PLUGIN_PREFIX = `/${PLUGIN_PACKAGE}`;

export function parseHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function pluginRegistryPath(pathname) {
  if (typeof pathname !== "string" || !pathname) return null;
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  if (decoded === PLUGIN_PREFIX || decoded === `${PLUGIN_PREFIX}/`) return "packument";
  if (decoded.startsWith(`${PLUGIN_PREFIX}/`)) return "tarball";
  return null;
}

export function isPluginRegistryRequest(value) {
  const url = value instanceof URL ? value : parseHttpUrl(value);
  if (!url) return false;
  if (!REGISTRY_HOSTS.has(url.hostname.toLowerCase())) return false;
  return pluginRegistryPath(url.pathname) !== null;
}

export function rewritePluginRegistryUrl(value, fixtureOrigin) {
  const url = value instanceof URL ? value : parseHttpUrl(value);
  if (!url || !isPluginRegistryRequest(url)) return null;
  const origin = parseHttpUrl(fixtureOrigin);
  if (!origin) return null;
  if (origin.protocol !== "http:") return null;
  const host = origin.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") return null;
  const next = new URL(origin.origin);
  next.pathname = url.pathname;
  next.search = url.search;
  return next.toString();
}
