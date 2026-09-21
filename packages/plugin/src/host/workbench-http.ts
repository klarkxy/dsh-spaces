import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { parseControlEndpoint } from "../../../../src/adapters/node/home-controller";
import { MAX_SPACE_ICON_FILE_BYTES } from "../../../../src/shared/space-icon";
import {
  isBlueprintLargeRequestMethod,
  isBlueprintLargeResponseMethod,
  WORKBENCH_BLUEPRINT_REQUEST_BODY_LIMIT,
  WORKBENCH_BLUEPRINT_RESPONSE_BODY_LIMIT,
} from "../../../../src/shared/workbench-blueprint";
import { MAX_WORKBENCH_SHARE_BASE64 } from "../../../../src/shared/workbench-product";
import type { WorkbenchApi, WorkbenchMutationContext } from "../../../../src/shared/workbench";
import type { LlmApiResult, LlmCredentialRequest } from "../../../../src/shared/llm-api";
import { LLM_PUBLIC_ERROR, WORKBENCH_PUBLIC_ERROR, type LlmRemoteCode, type WorkbenchRemoteCode } from "./remote-errors";
import {
  backupsResultSchema,
  jobIdSchema,
  mutationContextSchema,
  pluginsQuerySchema,
  snapshotIdSchema,
  spaceIdSchema,
  workbenchCommandSchema,
  workbenchJobSchema,
  workbenchPlanRequestSchema,
  workbenchPlanSchema,
  workbenchPluginListSchema,
  workbenchProductRequestSchema,
  workbenchProductResultSchema,
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
  "product",
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
export const WORKBENCH_API_METHODS = WORKBENCH_HTTP_METHODS;

/** Ordinary JSON methods stay at the icon-file bound. */
export const WORKBENCH_HTTP_BODY_LIMIT = MAX_SPACE_ICON_FILE_BYTES;

/** share.previewImport request / share.export response: 8MiB binary as base64 plus a small JSON envelope. */
export const WORKBENCH_PRODUCT_SHARE_JSON_OVERHEAD = 64 * 1024;
export const WORKBENCH_PRODUCT_SHARE_BODY_LIMIT = MAX_WORKBENCH_SHARE_BASE64 + WORKBENCH_PRODUCT_SHARE_JSON_OVERHEAD;

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
  const call = <T>(
    method: WorkbenchHttpMethod,
    body: unknown,
    resultSchema: { parse(value: unknown): T },
  ): Promise<T> => workbenchPost(doFetch, origin, options.endpoint.bearer, method, body, resultSchema);

  return {
    state: async () => call("state", {}, workbenchStateSchema),
    detail: async (spaceId) => call("detail", { spaceId: parseOrInvalid(spaceIdSchema, spaceId) }, workbenchSpaceDetailSchema),
    submit: async (command, requestId, context) =>
      call(
        "submit",
        {
          command: parseOrInvalid(workbenchCommandSchema, command),
          requestId: requireRequestId(requestId),
          context: parseContext(context),
        },
        workbenchJobSchema,
      ),
    job: async (id) => call("job", { id: parseOrInvalid(jobIdSchema, id) }, workbenchJobSchema),
    cancel: async (id) => call("cancel", { id: parseOrInvalid(jobIdSchema, id) }, workbenchJobSchema),
    view: async (spaceId) => call("view", { spaceId: parseOrInvalid(spaceIdSchema, spaceId) }, workbenchViewSchema),
    preview: async (request, context) =>
      call(
        "preview",
        {
          request: parseOrInvalid(workbenchPlanRequestSchema, request),
          context: parseContext(context),
        },
        workbenchPlanSchema,
      ),
    product: async (request) =>
      call("product", { request: parseOrInvalid(workbenchProductRequestSchema, request) }, workbenchProductResultSchema),
    plugins: async (query) => call("plugins", { query: parseOrInvalid(pluginsQuerySchema, query) }, workbenchPluginListSchema),
    snapshots: async () => call("snapshots", {}, workbenchSnapshotSchema.array()),
    snapshot: async (id) => call("snapshot", { id: parseOrInvalid(snapshotIdSchema, id) }, workbenchSnapshotSchema),
    runtimes: async () => call("runtimes", {}, workbenchRuntimeListSchema),
    workbenchPackage: async () => call("workbenchPackage", {}, workbenchPackageResultSchema),
    backups: async (spaceId) => call("backups", { spaceId: parseOrInvalid(spaceIdSchema, spaceId) }, backupsResultSchema),
    llm: async (request) => call("llm", parseOrInvalid(llmApiRequestSchema, request), llmApiResultSchema) as Promise<LlmApiResult>,
    llmCredential: async (request: LlmCredentialRequest) =>
      call("llmCredential", parseOrInvalid(llmCredentialRequestSchema, request), llmApiResultSchema) as Promise<LlmApiResult>,
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
  const requestLimit = requestBodyLimit(method, body);
  if (utf8Bytes(payload) > requestLimit) {
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
  const text = await readLimitedText(response, responseBodyLimit(method, body));
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

function parseContext(context: WorkbenchMutationContext | undefined): WorkbenchMutationContext {
  return parseOrInvalid(mutationContextSchema, context);
}

function parseOrInvalid<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof RemoteError) throw error;
    throw publicError("workbench/invalid-input");
  }
}

function productMethodOf(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const request = (body as { request?: unknown }).request;
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const method = (request as { method?: unknown }).method;
  return typeof method === "string" ? method : null;
}

function requestBodyLimit(method: WorkbenchHttpMethod, body: unknown): number {
  if (method === "product" && productMethodOf(body) === "share.previewImport") {
    return WORKBENCH_PRODUCT_SHARE_BODY_LIMIT;
  }
  if (method === "product" && isBlueprintLargeRequestMethod(productMethodOf(body) ?? "")) {
    return WORKBENCH_BLUEPRINT_REQUEST_BODY_LIMIT;
  }
  return WORKBENCH_HTTP_BODY_LIMIT;
}

function responseBodyLimit(method: WorkbenchHttpMethod, body: unknown): number {
  if (method === "product" && productMethodOf(body) === "share.export") {
    return WORKBENCH_PRODUCT_SHARE_BODY_LIMIT;
  }
  if (method === "product" && isBlueprintLargeResponseMethod(productMethodOf(body) ?? "")) {
    return WORKBENCH_BLUEPRINT_RESPONSE_BODY_LIMIT;
  }
  return WORKBENCH_HTTP_BODY_LIMIT;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function remoteFromSupervisorError(error: unknown): RemoteError {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return publicError("workbench/unavailable");
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") {
    return publicError("workbench/unavailable");
  }
  if (Object.hasOwn(WORKBENCH_PUBLIC_ERROR, code)) {
    return publicError(code as WorkbenchRemoteCode);
  }
  if (Object.hasOwn(LLM_PUBLIC_ERROR, code)) {
    return new RemoteError(code as LlmRemoteCode, LLM_PUBLIC_ERROR[code as LlmRemoteCode], {});
  }
  return publicError("workbench/unavailable");
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) throw publicError("workbench/unavailable");
    return new TextDecoder().decode(buffer);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw publicError("workbench/unavailable");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RemoteError) throw error;
    throw publicError("workbench/unavailable");
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
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
  const text = await readLimitedText(response, WORKBENCH_HTTP_BODY_LIMIT);
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
