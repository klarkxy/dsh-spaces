/**
 * The failure helpers of the workbench client.
 *
 * These helpers were module-level functions of `workbench/store.ts`. They
 * move here unchanged: the parts read a failure the same way, and none of
 * them recovers from one.
 */

import type { LocalePreference } from "../../../../../src/shared/types";
import type { WorkbenchCommand } from "../../../../../src/shared/workbench";
import type { WorkbenchProductOutcome } from "../../../../../src/shared/workbench-product";
import type { WorkbenchLocale } from "../i18n";

export function localLogMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message) return null;
  if (
    message.startsWith("The workbench request did not reach") ||
    message.startsWith("The workbench response") ||
    message.startsWith("The workbench endpoint") ||
    message.startsWith("The workbench error did not include") ||
    message.startsWith("Expected ")
  ) {
    return message;
  }
  return null;
}

export function wrongProduct(expected: string, actual: string): Error {
  return Object.assign(new Error(`Expected ${expected}, received ${actual}.`), { code: "workbench/unavailable" });
}

export function errorCode(error: unknown): { code?: string; message?: string } {
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  }
  return {};
}

export function intentKey(command: WorkbenchCommand): string {
  return JSON.stringify(command);
}

export function mapLocale(value: LocalePreference): WorkbenchLocale {
  if (value === "en") return "en";
  if (value === "zh") return "zh";
  return "zh";
}

export function importSpaceId(product: WorkbenchProductOutcome | undefined): string | undefined {
  if (!product) return undefined;
  if (product.kind === "template.create" || product.kind === "space.import") {
    return product.import.spaceId;
  }
  return undefined;
}
