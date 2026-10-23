import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { isExactRuntimeVersion } from "../../../../shared/runtime";
import { CONTROL_PACKAGE_SET } from "./constants";

export function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function containedIn(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function sameResolved(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function exactOrNull(value: string | null): string | null {
  return value && isExactRuntimeVersion(value) ? value : null;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("The blueprint apply was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

export function isOwnedBridgeName(name: string): boolean {
  if (CONTROL_PACKAGE_SET.has(name)) return true;
  return name === "dsh-spaces-view-bridge" || name === "dsh-spaces-llm-bridge" || name === "dsh-spaces-plugin";
}

export function looksLikeModulePath(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.startsWith("/") ||
    name.startsWith("file:") ||
    /^[A-Za-z]:[\\/]/.test(name) ||
    name.includes("\\")
  );
}

export function looksLikeLocalPath(value: string): boolean {
  if (value.startsWith("file:")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("/") && !value.startsWith("//") && value.length > 1) return true;
  if (value.includes("\\") && /[A-Za-z]:\\/.test(value)) return true;
  return false;
}
