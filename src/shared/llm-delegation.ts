/** Internal, versioned plugin transport. Not a general remote Context proxy. */
export const LLM_DELEGATION_PREFIX = '/internal/llm-delegation/v1/';
export const LLM_DELEGATION_CHANNEL = 'dsh-spaces/llm-delegation/v1';
export interface LlmDelegationBootstrap {
  origin: string;
  spaceId: string;
  generation: number;
  serviceEpoch: string;
  instanceId: string;
  bearer: string;
}
