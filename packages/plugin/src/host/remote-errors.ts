declare module "@deepseek-ai/dsh-typert-protocol/types" {
  interface RemoteErrorDetailsMap {
    "spaces/read-only": {};
    "spaces/host-denied": {};
    "spaces/invalid-input": {};
    "spaces/not-found": {};
    "spaces/already-exists": {};
    "spaces/locked": {};
    "spaces/unavailable": {};
  }
}

export const SPACES_REMOTE_CODES = [
  "spaces/read-only",
  "spaces/host-denied",
  "spaces/invalid-input",
  "spaces/not-found",
  "spaces/already-exists",
  "spaces/locked",
  "spaces/unavailable",
] as const;

export type SpacesRemoteCode = (typeof SPACES_REMOTE_CODES)[number];
