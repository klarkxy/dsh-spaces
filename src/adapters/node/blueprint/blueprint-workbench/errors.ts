import { lstatSync } from "../../../../shared/node/filesystem";
import { BlueprintError } from "@klarkxy/dsh-blueprint/v1/types";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES } from "../../../../shared/types";
import { LLM_ERROR, LlmConfigError } from "../../../../shared/llm-connections";
import type { LlmApiResult, LlmDescribeResult, LlmSpacePolicyResult } from "../../../../shared/llm-api";
import { BlueprintPackageError, blueprintPackageErrorMessage } from "../blueprint-package";
import { sanitizeLogText } from "../../diagnostics/diagnostics";
import { GITHUB_APPLY_MESSAGE, INSPECT_RUNTIME_FAILED } from "./constants";
import { looksLikeLocalPath } from "./utils";

export function publicError(message: string, _path?: string): Error {
  return new Error(sanitizePublicMessage(message));
}

export function sanitizeBlueprintError(error: unknown): string {
  if (error instanceof BlueprintError) return sanitizePublicMessage(error.message);
  if (error instanceof BlueprintPackageError) {
    if (error.code === "github-unsupported") return GITHUB_APPLY_MESSAGE;
    return sanitizePublicMessage(error.message);
  }
  if (error instanceof Error) return sanitizePublicMessage(error.message);
  return "The blueprint request failed.";
}

export function sanitizePublicMessage(message: string): string {
  const redacted = sanitizeLogText(message)
    .replace(/[A-Za-z]:\\[^\s"'\\]+(?:\\[^\s"'\\]+)*/g, "[path]")
    .replace(/\/(?:home|Users|root|opt|var|tmp)\/[^\s"']+/g, "[path]");
  return redacted.length > 500 ? `${redacted.slice(0, 499)}…` : redacted;
}

export function isPublicError(error: unknown): error is Error {
  return error instanceof Error && error.name === "Error" && isSafeKnownReason(error.message);
}

export function isInspectRuntimeFailure(error: unknown): boolean {
  return error instanceof Error && error.message === INSPECT_RUNTIME_FAILED;
}

export function modelWriteFailureReason(error: unknown): string {
  if (error instanceof LlmConfigError) {
    if (error.code === LLM_ERROR.REVISION_CONFLICT) return "The model policy could not be updated.";
    if (error.code === LLM_ERROR.MODEL_NOT_FOUND) return "The selected model is not available on that connection.";
  }
  if (error instanceof Error && isSafeKnownReason(error.message)) return error.message;
  return "The model binding could not be written.";
}

export function durableFailureReason(error: unknown, stage: "space-create" | "packages" | "presets"): string {
  if (isAbortError(error)) return "The blueprint apply was cancelled.";
  if (error instanceof BlueprintPackageError && error.code === "github-unsupported") return GITHUB_APPLY_MESSAGE;
  if (error instanceof BlueprintPackageError) return blueprintPackageErrorMessage(error);
  if (isPublicError(error) && isSafeKnownReason(error.message)) return error.message;
  if (stage === "packages") return "Package installation failed.";
  if (stage === "presets") return "Blueprint presets could not be written.";
  return "The space could not be created.";
}

export function durableText(message: string): string {
  const cleaned = sanitizePublicMessage(message);
  if (looksLikeLocalPath(cleaned) || /[A-Za-z]:[\\/]|\\\\|\/\/|\/(?:home|Users|root|opt|var|tmp)\//.test(cleaned)) {
    return "The blueprint operation failed.";
  }
  return cleaned;
}

function isSafeKnownReason(message: string): boolean {
  if (!message) return false;
  if (looksLikeLocalPath(message)) return false;
  if (/canary|sk-[A-Za-z0-9]{10,}/i.test(message)) return false;
  if (/[A-Za-z]:[\\/]|\\\\|\/\/|\/(?:home|Users|root|opt|var|tmp)\//.test(message)) return false;
  return message.length <= 500;
}

export function safeBlueprintLabel(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed || looksLikeLocalPath(trimmed) || /[\\/]/.test(trimmed)) return undefined;
  return trimmed.slice(0, 80);
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: string }).name === "AbortError");
}

export function compositionFailureReason(error: unknown, fallback = "Blueprint composition could not be verified."): string {
  if (error instanceof Error && isSafeKnownReason(error.message) && !/EPERM|ENOENT|EACCES|EISDIR/i.test(error.message)) {
    return error.message;
  }
  return fallback;
}

export function assertMutableName(spaceId: string, managerId: string | null): void {
  if (!PROFILE_NAME_RE.test(spaceId)) throw publicError("That space name is not allowed.");
  if (spaceId === "web" || (RESERVED_PROFILE_NAMES as readonly string[]).includes(spaceId)) {
    throw publicError(`The ${spaceId} space cannot be changed this way.`);
  }
  if (managerId && spaceId === managerId) throw publicError(`The ${spaceId} space cannot be changed this way.`);
}

export function assertRegularFile(path: string): void {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink()) throw publicError("The space manifest is not a regular file.");
}

export function asDescribe(result: LlmApiResult): LlmDescribeResult {
  if (!result || typeof result !== "object" || !("connections" in result) || !("revision" in result)) {
    throw publicError("The model catalog could not be read.");
  }
  return result as LlmDescribeResult;
}

export function asSpacePolicy(result: LlmApiResult): LlmSpacePolicyResult {
  if (!result || typeof result !== "object" || !("policy" in result)) {
    throw publicError("The space model policy could not be read.");
  }
  const policy = (result as LlmSpacePolicyResult).policy;
  if (!policy || typeof policy.revision !== "number" || !Number.isInteger(policy.revision) || policy.revision < 0) {
    throw publicError("The space model policy could not be read.");
  }
  return result as LlmSpacePolicyResult;
}
