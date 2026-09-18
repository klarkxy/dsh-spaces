import { LLM_ERROR, LlmConfigError, type LlmErrorCode } from "../../../src/core/domain/llm-connections";

export { LLM_ERROR, LlmConfigError, type LlmErrorCode };

export function sharedReadOnlyError(routeId?: string): LlmConfigError {
  return new LlmConfigError(
    LLM_ERROR.SHARED_CONNECTION_READ_ONLY,
    "shared LLM connections are read-only in this space",
    routeId ? { routeId } : {},
  );
}

export function managedRouteConflictError(routeIds: readonly string[]): LlmConfigError {
  return new LlmConfigError(
    LLM_ERROR.MANAGED_ROUTE_CONFLICT,
    "local settings tried to occupy a managed shared LLM route",
    { routeId: routeIds[0], count: routeIds.length },
  );
}

export function missingSharedCredentialError(ref: string): LlmConfigError {
  return new LlmConfigError(
    LLM_ERROR.CREDENTIAL_MISSING,
    "shared LLM credential is not configured for this space snapshot",
    { ref },
  );
}
