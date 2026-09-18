import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { parseControlEndpoint } from "../../../../src/adapters/node/home-controller";
import { MAX_SPACE_ICON_FILE_BYTES } from "../../../../src/shared/space-icon";
import type { WorkbenchApi } from "../../../../src/shared/workbench";
import type { LlmApiResult, LlmCredentialRequest } from "../../../../src/shared/llm-api";
import { LLM_PUBLIC_ERROR, WORKBENCH_PUBLIC_ERROR, type LlmRemoteCode, type WorkbenchRemoteCode } from "./remote-errors";
import {
  backupsResultSchema,
  jobIdSchema,
  pluginsQuerySchema,
  snapshotIdSchema,
  spaceIdSchema,
  workbenchCommandSchema,
  workbenchJobSchema,
  workbenchPlanRequestSchema,
  workbenchPlanSchema,
  workbenchPluginListSchema,
  workbenchRuntimeListSchema,
  workbenchPackageResultSchema,
  workbenchSnapshotSchema,
  workbenchStateSchema,
  workbenchViewSchema,
  workbenchSpaceDetailSchema,
  llmApiRequestSchema,
  llmApiResultSchema,
  llmCredentialRequestSchema,
} from "./workbench-schemas";
import { parseSupervisorHandoffPath } from "./loopback";
import type { SupervisorEndpoint } from "./supervisor-endpoint";

export const WORKBENCH_HTTP_METHODS = [
  "state",
  "detail",
  "submit",
  "job",
  "cancel",
  "view",
  "preview",
  "plugins",
  "snapshots",
  "snapshot",
  "runtimes",
  "workbenchPackage",
  "backups",
  "llm",
  "llmCredential",
] as const;

export type WorkbenchHttpMethod = (typeof WORKBENCH_HTTP_METHODS)[number];

export const WORKBENCH_HTTP_BODY_LIMIT = MAX_SPACE_ICON_FILE_BYTES;

export interface WorkbenchHttpFetch {
  (input: string, init: RequestInit): Promise<Response>;
}

export interface WorkbenchHttpClientOptions {
  endpoint: SupervisorEndpoint;
  fetch?: WorkbenchHttpFetch;
}

/**
 * Node-only WorkbenchApi over POST /api/workbench/<method>.
 * Bearer is attached here and never returned to the browser Remote face.
 * Extra fields, paths, commands and original tokens are rejected by schema.
 */
export function createWorkbenchHttpClient(options: WorkbenchHttpClientOptions): WorkbenchApi {
  const origin = originOf(options.endpoint.origin);
  const doFetch = options.fetch ?? fetch;
  const call = <T>(method: WorkbenchHttpMethod, body: unknown, resultSchema: { parse(value: unknown): T }): Promise<T> =>
    workbenchPost(doFetch, origin, options.endpoint.bearer, method, body, resultSchema);

  return {
    state: () => call("state", {}, workbenchStateSchema),
    detail: (spaceId) => call("detail", { spaceId: spaceIdSchema.parse(spaceId) }, workbenchSpaceDetailSchema),
    submit: (command, requestId) =>
      call(
        "submit",
        { command: workbenchCommandSchema.parse(command), requestId: requireRequestId(requestId) },
        workbenchJobSchema,
      ),
    job: (id) => call("job", { id: jobIdSchema.parse(id) }, workbenchJobSchema),
    cancel: (id) => call("cancel", { id: jobIdSchema.parse(id) }, workbenchJobSchema),
    view: (spaceId) => call("view", { spaceId: spaceIdSchema.parse(spaceId) }, workbenchViewSchema),
    preview: (request) =>
      call("preview", { request: workbenchPlanRequestSchema.parse(request) }, workbenchPlanSchema),
    plugins: (query) => call("plugins", { query: pluginsQuerySchema.parse(query) }, workbenchPluginListSchema),
    snapshots: () => call("snapshots", {}, workbenchSnapshotSchema.array()),
    snapshot: (id) => call("snapshot", { id: snapshotIdSchema.parse(id) }, workbenchSnapshotSchema),
    runtimes: () => call("runtimes", {}, workbenchRuntimeListSchema),
    workbenchPackage: () => call("workbenchPackage", {}, workbenchPackageResultSchema),
    backups: (spaceId) => call("backups", { spaceId: spaceIdSchema.parse(spaceId) }, backupsResultSchema),
    llm: (request) => call("llm", llmApiRequestSchema.parse(request), llmApiResultSchema) as Promise<LlmApiResult>,
    llmCredential: (request: LlmCredentialRequest) =>
      call("llmCredential", llmCredentialRequestSchema.parse(request), llmApiResultSchema) as Promise<LlmApiResult>,
  };
}

export async function workbenchPost<T>(
  doFetch: WorkbenchHttpFetch,
  origin: string,
  bearer: string,
  method: WorkbenchHttpMethod,
  body: unknown,
  resultSchema: { parse(value: unknown): T },
): Promise<T> {
  if (!(WORKBENCH_HTTP_METHODS as readonly string[]).includes(method)) {
    throw publicError("workbench/invalid-input");
  }
  let payload: string;
  try {
    payload = JSON.stringify(body ?? {});
  } catch {
    throw publicError("workbench/invalid-input");
  }
  if (payload.length > WORKBENCH_HTTP_BODY_LIMIT) {
    throw publicError("workbench/invalid-input");
  }
  const url = `${origin}/api/workbench/${method}`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        origin,
      },
      body: payload,
      redirect: "error",
    });
  } catch {
    throw publicError("workbench/unavailable");
  }
  const text = await readLimitedText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw publicError("workbench/unavailable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw publicError("workbench/unavailable");
  }
  const row = parsed as { ok?: unknown; value?: unknown; error?: unknown };
  if (row.ok === false) {
    throw remoteFromSupervisorError(row.error);
  }
  if (row.ok !== true) throw publicError("workbench/unavailable");
  try {
    return resultSchema.parse(row.value);
  } catch {
    throw publicError("workbench/unavailable");
  }
}

function originOf(raw: string): string {
  try {
    return new URL(parseControlEndpoint(raw)).origin;
  } catch {
    throw publicError("workbench/unavailable");
  }
}

function requireRequestId(requestId: string): string {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId)) {
    throw publicError("workbench/invalid-input");
  }
  return requestId;
}

function remoteFromSupervisorError(error: unknown): RemoteError {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("workbench/")
  ) {
    const code = (error as { code: string }).code;
    if (code in WORKBENCH_PUBLIC_ERROR) {
      return publicError(code as WorkbenchRemoteCode);
    }
    if (code in LLM_PUBLIC_ERROR) {
      return new RemoteError(code as LlmRemoteCode, LLM_PUBLIC_ERROR[code as LlmRemoteCode], {});
    }
  }
  return publicError("workbench/unavailable");
}

async function readLimitedText(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > WORKBENCH_HTTP_BODY_LIMIT) {
    throw publicError("workbench/unavailable");
  }
  return new TextDecoder().decode(buffer);
}

function publicError(code: WorkbenchRemoteCode): RemoteError {
  return new RemoteError(code, WORKBENCH_PUBLIC_ERROR[code], {});
}

/** POST /internal/bootstrap with the Node bearer. Returns a relative /bootstrap/<token> path. */
export async function mintSupervisorHandoff(
  doFetch: WorkbenchHttpFetch,
  endpoint: SupervisorEndpoint,
): Promise<string> {
  const origin = originOf(endpoint.origin);
  let response: Response;
  try {
    response = await doFetch(`${origin}/internal/bootstrap`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${endpoint.bearer}`,
        origin,
      },
      body: "{}",
      redirect: "error",
    });
  } catch {
    throw publicError("workbench/unavailable");
  }
  const text = await readLimitedText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw publicError("workbench/unavailable");
  }
  const url = parsed && typeof parsed === "object" ? (parsed as { url?: unknown }).url : undefined;
  if (typeof url !== "string") throw publicError("workbench/unavailable");
  const path = parseSupervisorHandoffPath(url, origin);
  if (!path) throw publicError("workbench/unavailable");
  return path;
}
