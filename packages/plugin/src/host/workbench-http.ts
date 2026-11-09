import { parseSpaceHostAudience, type SpaceHostAudience } from "../../../../src/shared/space-host";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { parseControlEndpoint } from "../../../../src/adapters/node/home/home-lease";
import { MAX_SPACE_ICON_FILE_BYTES } from "../../../../src/shared/space-icon";
import {
  isBlueprintLargeRequestMethod,
  isBlueprintLargeResponseMethod,
  WORKBENCH_BLUEPRINT_REQUEST_BODY_LIMIT,
  WORKBENCH_BLUEPRINT_RESPONSE_BODY_LIMIT,
} from "../../../../src/shared/workbench-blueprint";
import { MAX_WORKBENCH_SHARE_BASE64 } from "../../../../src/shared/workbench-product";
import {
  WORKBENCH_API,
  WORKBENCH_API_METHODS,
  type WorkbenchApi,
  type WorkbenchApiArgs,
  type WorkbenchApiMethod,
  type WorkbenchApiResult,
} from "../../../../src/shared/workbench";
import { reportedOrFallback } from "../../../../src/shared/public-reason";
import {
  LLM_PUBLIC_ERROR,
  SPACES_PUBLIC_ERROR,
  WORKBENCH_PUBLIC_ERROR,
  type LlmRemoteCode,
  type SpacesRemoteCode,
  type WorkbenchRemoteCode,
} from "./remote-errors";
import { WORKBENCH_API_CODECS } from "./workbench-api";
import { parseSupervisorHandoffPath } from "../../../../src/shared/loopback";
import type { SupervisorEndpoint } from "../../../../src/adapters/node/home/supervisor-endpoint";

export const WORKBENCH_HTTP_METHODS = WORKBENCH_API_METHODS;

export type WorkbenchHttpMethod = WorkbenchApiMethod;
export { WORKBENCH_API_METHODS };

/**
 * The two LLM methods carry their request as the whole request body instead of
 * as a named field. Every other method sends its arguments by name.
 */

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

/** Process-local abort for one startup observation. Omitted calls keep the existing timeout. */
export interface WorkbenchPostTransport {
  signal?: AbortSignal;
}

/**
 * The request body of one management API call.
 *
 * Every argument is validated with its canonical codec and sent under its
 * canonical wire name, except for the two LLM methods whose single argument is
 * the whole body.
 */
function workbenchBody<K extends WorkbenchApiMethod>(method: K, args: WorkbenchApiArgs<K>): unknown {
  const spec: { args: readonly { name: string }[] } = WORKBENCH_API[method];
  const codecs: {
    params: Record<string, { schema: { parse(value: unknown): unknown } }>;
  } = WORKBENCH_API_CODECS[method];
  const values = args as unknown as readonly unknown[];
  const parsed = spec.args.map((arg, index) => parseOrInvalid(codecs.params[arg.name].schema, values[index]));
  const body: Record<string, unknown> = {};
  spec.args.forEach((arg, index) => {
    body[arg.name] = parsed[index];
  });
  return body;
}

/**
 * Node-only WorkbenchApi over POST /api/workbench/<method>.
 * Bearer is attached here and never returned to the browser Remote face.
 * Extra fields, paths, commands and original tokens are rejected by schema.
 */
export function createWorkbenchHttpClient(options: WorkbenchHttpClientOptions): WorkbenchApi {
  const origin = originOf(options.endpoint.origin);
  const doFetch = options.fetch ?? fetch;
  const call = <K extends WorkbenchApiMethod>(
    method: K,
    args: WorkbenchApiArgs<K>,
    signal?: AbortSignal,
  ): Promise<WorkbenchApiResult<K>> => workbenchPost(
    doFetch,
    origin,
    options.endpoint.bearer,
    method,
    workbenchBody(method, args),
    WORKBENCH_API_CODECS[method].result.schema,
    signal ? { signal } : undefined,
  ) as Promise<WorkbenchApiResult<K>>;

  return {
    state: async (signal?: AbortSignal) => call("state", [], signal),
    startupStatus: async (signal?: AbortSignal) => call("startupStatus", [], signal),
    detail: async (spaceId) => call("detail", [spaceId]),
    submit: async (command, requestId, context) => call("submit", [command, requestId, context]),
    job: async (id) => call("job", [id]),
    cancel: async (id) => call("cancel", [id]),
    view: async (spaceId) => call("view", [spaceId]),
    preview: async (request, context) => call("preview", [request, context]),
    product: async (request) => call("product", [request]),
    plugins: async (query) => call("plugins", [query]),
    snapshots: async () => call("snapshots", []),
    snapshot: async (id) => call("snapshot", [id]),
    runtimes: async () => call("runtimes", []),
    backups: async (spaceId) => call("backups", [spaceId]),
  };
}

export async function workbenchPost<T>(
  doFetch: WorkbenchHttpFetch,
  origin: string,
  bearer: string,
  method: WorkbenchHttpMethod,
  body: unknown,
  resultSchema: { parse(value: unknown): T },
  transport?: WorkbenchPostTransport,
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
    const init: RequestInit = {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        origin,
      },
      body: payload,
      redirect: "error",
    };
    if (transport?.signal) init.signal = transport.signal;
    response = await doFetch(url, init);
  } catch {
    throw publicError("workbench/unavailable", "The workbench request did not reach the supervisor.");
  }
  const text = await readLimitedText(response, responseBodyLimit(method, body), transport?.signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw publicError("workbench/unavailable", "The workbench response was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw publicError("workbench/unavailable", "The workbench response was not a completed result.");
  }
  const row = parsed as { ok?: unknown; value?: unknown; error?: unknown };
  if (row.ok === false) {
    throw remoteFromSupervisorError(row.error);
  }
  if (row.ok !== true) throw publicError("workbench/unavailable", "The workbench response was not a completed result.");
  try {
    return resultSchema.parse(row.value);
  } catch {
    throw publicError("workbench/unavailable", "The workbench response did not match the expected result.");
  }
}

function originOf(raw: string): string {
  try {
    return new URL(parseControlEndpoint(raw)).origin;
  } catch {
    throw publicError("workbench/unavailable", "The workbench endpoint is not a valid loopback origin.");
  }
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
    return publicError("workbench/unavailable", "The workbench error did not include a code.");
  }
  const code = (error as { code?: unknown }).code;
  const reported = (error as { message?: unknown }).message;
  if (typeof code !== "string") {
    return publicError("workbench/unavailable", "The workbench error did not include a code.");
  }
  if (Object.hasOwn(WORKBENCH_PUBLIC_ERROR, code)) {
    return publicError(code as WorkbenchRemoteCode, reported);
  }
  if (Object.hasOwn(LLM_PUBLIC_ERROR, code)) {
    const known = code as LlmRemoteCode;
    return new RemoteError(known, reportedOrFallback(reported, LLM_PUBLIC_ERROR[known]), {});
  }
  if (Object.hasOwn(SPACES_PUBLIC_ERROR, code)) {
    const known = code as SpacesRemoteCode;
    return new RemoteError(known, reportedOrFallback(reported, SPACES_PUBLIC_ERROR[known]), {});
  }
  return publicError("workbench/unavailable");
}

async function readLimitedText(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    if (signal?.aborted) {
      detachBody(response.body);
      throw publicError("workbench/unavailable", "The workbench response could not be read.");
    }
    try {
      const buffer = await untilAborted(response.arrayBuffer(), signal);
      if (buffer.byteLength > limit) throw publicError("workbench/unavailable", "The workbench response was too large.");
      return new TextDecoder().decode(buffer);
    } catch (error) {
      if (signal) detachBody(response.body);
      if (error instanceof RemoteError) throw error;
      throw publicError("workbench/unavailable", "The workbench response could not be read.");
    }
  }
  // A stand-in stream may never resolve cancel(). Observation cleanup must not wait for it.
  let released = false;
  const release = (wait: boolean): Promise<void> => {
    if (released) return Promise.resolve();
    released = true;
    const done = reader.cancel().then(() => undefined, () => undefined);
    return wait ? done : Promise.resolve();
  };
  const onAbort = () => { void release(false); };
  if (signal?.aborted) {
    await release(false);
    throw publicError("workbench/unavailable", "The workbench response could not be read.");
  }
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await untilAborted(reader.read(), signal);
      if (next.done) break;
      const value = next.value;
      total += value.byteLength;
      if (total > limit) {
        await release(signal === undefined);
        throw publicError("workbench/unavailable", "The workbench response was too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await release(signal === undefined);
    if (error instanceof RemoteError) throw error;
    throw publicError("workbench/unavailable", "The workbench response could not be read.");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function detachBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  void body.cancel().then(() => undefined, () => undefined);
}

function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  void work.then(() => undefined, () => undefined);
  if (signal.aborted) return Promise.reject(publicError("workbench/unavailable", "The workbench response could not be read."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(publicError("workbench/unavailable", "The workbench response could not be read."));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function publicError(code: WorkbenchRemoteCode, reported?: unknown): RemoteError {
  return new RemoteError(code, reportedOrFallback(reported, WORKBENCH_PUBLIC_ERROR[code]), {});
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
    throw publicError("workbench/unavailable", "The workbench request did not reach the supervisor.");
  }
  const text = await readLimitedText(response, WORKBENCH_HTTP_BODY_LIMIT);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw publicError("workbench/unavailable", "The workbench response was not valid JSON.");
  }
  const url = parsed && typeof parsed === "object" ? (parsed as { url?: unknown }).url : undefined;
  if (typeof url !== "string") throw publicError("workbench/unavailable", "The workbench response was not a completed result.");
  const path = parseSupervisorHandoffPath(url, origin);
  if (!path) throw publicError("workbench/unavailable", "The supervisor handoff path was not accepted.");
  return path;
}

/** Issue a single-use, audience-bound iframe entry through the Node-only management connection. */
export async function mintSupervisorPortal(doFetch: WorkbenchHttpFetch, endpoint: SupervisorEndpoint, audience: SpaceHostAudience): Promise<string> {
  const valid = parseSpaceHostAudience(audience);
  if (!valid) throw publicError("workbench/unsupported", "This host needs a compatible presentation adapter.");
  const origin = originOf(endpoint.origin);
  const response = await doFetch(`${origin}/internal/portal`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.bearer}`, origin },
    body: JSON.stringify(valid), redirect: "error", signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw publicError("workbench/unavailable");
  const result: unknown = JSON.parse(await readLimitedText(response, 1024));
  const path = result && typeof result === "object" ? (result as { path?: unknown }).path : undefined;
  if (typeof path !== "string" || !/^\/portal-bootstrap\/[A-Za-z0-9_-]{32}$/.test(path)) throw publicError("workbench/unavailable");
  return path;
}
