import type { LlmSharedSnapshot } from "../../../src/core/domain/llm-connections";
import { LLM_ERROR, isManagedRouteId } from "../../../src/core/domain/llm-connections";
import {
  collectManagedWritePaths,
  userSectionHasManagedRoutes,
} from "../../../src/core/domain/llm-resolution";
import { managedRouteConflictError, sharedReadOnlyError } from "./errors";

export const LLM_PI_AI_NAMESPACE = "llm-pi-ai";
export const AGENT_DEFAULT_MODEL_NAMESPACE = "agent-default-model";

export interface LlmBridgeStatus {
  source: "spaces-shared" | "local-only";
  catalogRevision: number | null;
  policyRevision: number | null;
  connectionRevisions: Record<string, number>;
  adapterVersion: string | null;
  managedRouteConflict: boolean;
  conflictRouteIds: string[];
}

export function snapshotBridgeStatus(
  snapshot: LlmSharedSnapshot | null,
  conflictRouteIds: readonly string[] = [],
): LlmBridgeStatus {
  const connections = snapshot?.connections ?? [];
  return {
    source: snapshot && connections.length > 0 ? "spaces-shared" : "local-only",
    catalogRevision: snapshot?.catalogRevision ?? null,
    policyRevision: snapshot?.policyRevision ?? null,
    connectionRevisions: Object.fromEntries(connections.map((item) => [item.id, item.revision])),
    adapterVersion: snapshot?.adapterVersion ?? null,
    managedRouteConflict: conflictRouteIds.length > 0,
    conflictRouteIds: [...conflictRouteIds],
  };
}

export function assertNoManagedUserSection(section: unknown): void {
  if (userSectionHasManagedRoutes(section)) {
    throw managedRouteConflictError(collectManagedWritePaths(section));
  }
}

export function refuseManagedCall(status: LlmBridgeStatus): void {
  if (!status.managedRouteConflict) return;
  throw new (class extends Error {
    readonly code = LLM_ERROR.MANAGED_ROUTE_CONFLICT;
    constructor() {
      super("managed LLM routes are blocked while local settings occupy a reserved prefix");
    }
  })();
}

export function assertUserWrite(ns: string, section: object): void {
  if (ns !== LLM_PI_AI_NAMESPACE) return;
  const routes = collectManagedWritePaths(section);
  if (routes.length > 0) throw sharedReadOnlyError(routes[0]);
}

export function assertManagedMutate(ns: string, ops: readonly unknown[]): void {
  if (ns !== LLM_PI_AI_NAMESPACE) return;
  for (const op of ops) {
    if (!op || typeof op !== "object" || !("path" in op) || !Array.isArray(op.path)) continue;
    const path = op.path;
    const value = "value" in op ? op.value : undefined;
    if (path.length === 0) {
      if (value && typeof value === "object") assertUserWrite(ns, value as object);
      continue;
    }
    if (path[0] !== "providers") continue;
    if (path.length === 1) {
      if (value !== undefined) assertUserWrite(ns, { providers: value });
      continue;
    }
    if (typeof path[1] === "string" && isManagedRouteId(path[1])) {
      throw sharedReadOnlyError(path[1]);
    }
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
