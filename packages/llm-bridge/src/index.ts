export {
  SpacesFileSettingsProvider,
  LLM_PI_AI_NAMESPACE,
  AGENT_DEFAULT_MODEL_NAMESPACE,
  assertNoManagedUserSection,
  refuseManagedCall,
  type LlmBridgeStatus,
  type SpacesFileSettingsConfig,
} from "./settings-provider";
export {
  SpacesCredentialsProvider,
  SHARED_CREDENTIAL_SOURCE,
  type SharedCredentialLookup,
} from "./credentials-provider";
export { installManagedRequestGuard, type BridgeStatusReader } from "./request-guard";
export {
  freezeSpaceSnapshot,
  openSpaceLlmBridge,
  type OpenedSpaceLlmBridge,
} from "./space-bridge";
export { attachOfficialLlm } from "./official-host";
export { LLM_ERROR, LlmConfigError, sharedReadOnlyError, managedRouteConflictError, missingSharedCredentialError } from "./errors";
