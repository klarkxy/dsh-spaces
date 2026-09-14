/** Clean 127.0.0.1 origin/path checks. Never accept credentials, UNC, or tokens. */

export function parseLoopbackOrigin(raw: string): string | null {
  if (typeof raw !== "string" || raw !== raw.trim() || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname !== "127.0.0.1") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;
  return url.origin;
}

export function parseRelativeEntryPath(raw: string): string | null {
  if (typeof raw !== "string" || raw !== raw.trim()) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\") || raw.includes("\0")) return null;
  if (raw.length > 512) return null;
  try {
    const origin = "http://127.0.0.1";
    const url = new URL(raw, origin);
    if (url.origin !== origin || url.search || url.hash) return null;
    if (url.pathname !== raw.split("?")[0]) return null;
    return raw;
  } catch {
    return null;
  }
}

export function parsePrivateBearer(raw: string): string | null {
  if (typeof raw !== "string" || raw !== raw.trim() || !raw) return null;
  if (raw.length < 16 || raw.length > 256) return null;
  if (!/^[A-Za-z0-9._~+/-]+$/.test(raw)) return null;
  return raw;
}

export function parseExactInteger(raw: string): number | null {
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

export function parseViewChannel(raw: string): string | null {
  if (typeof raw !== "string" || raw !== raw.trim() || !raw) return null;
  if (raw.length > 128) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) return null;
  return raw;
}

export function parseSupervisorHandoffPath(raw: string, expectedOrigin: string): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== expectedOrigin) return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (!url.pathname.startsWith("/bootstrap/")) return null;
  const token = url.pathname.slice("/bootstrap/".length);
  if (!token || token.includes("/") || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  return url.pathname;
}

export function parseViewSpaceId(raw: string): string | null {
  if (typeof raw !== "string" || raw !== raw.trim() || !raw) return null;
  if (raw === "web") return raw;
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(raw)) return null;
  return raw;
}
