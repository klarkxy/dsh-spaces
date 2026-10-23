import type {
  LlmRemoteCode,
  SpacesRemoteCode,
  WorkbenchRemoteCode,
} from "../../../../src/shared/workbench-errors";

type PublicRemoteErrorDetails = {
  [Code in SpacesRemoteCode | WorkbenchRemoteCode | LlmRemoteCode]: {};
};

declare module "@deepseek-ai/dsh-typert-protocol/types" {
  interface RemoteErrorDetailsMap extends PublicRemoteErrorDetails {}
}

export {
  LLM_PUBLIC_ERROR,
  LLM_REMOTE_CODES,
  SPACES_PUBLIC_ERROR,
  SPACES_REMOTE_CODES,
  WORKBENCH_PUBLIC_ERROR,
  WORKBENCH_REMOTE_CODES,
  type LlmRemoteCode,
  type SpacesRemoteCode,
  type WorkbenchRemoteCode,
} from "../../../../src/shared/workbench-errors";
