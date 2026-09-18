import {
  LLM_ERROR,
  LlmConfigError,
  isPinnedProtocol,
} from "../../core/domain/llm-connections";
import type { LlmProbeDiscoverInput, LlmProbePort, LlmProbeTestInput } from "../../core/ports/llm-runtime";

export const LLM_DISCOVERY_TIMEOUT_MS = 15_000;
export const LLM_DISCOVERY_MAX_BYTES = 2 * 1024 * 1024;
export const LLM_DISCOVERY_MAX_MODELS = 1000;
export const LLM_TEST_MAX_TOKENS = 8;
export const LLM_TEST_PROMPT = "ping";

/**
 * Official `llm-pi-ai` listing plus Host bounds: 15s, 2 MiB, no redirect follow,
 * no retry, 1000-model cap. Credentials stay on this side of the Host.
 */
export class OfficialLlmProbe implements LlmProbePort {
  async discover(input: LlmProbeDiscoverInput): Promise<{ models: Array<{ id: string; name?: string }>; truncated: boolean }> {
    const api = requirePinnedApi(input.api);
    const baseURL = requireBaseUrl(input.baseURL);
    const url = listingUrl(baseURL, api);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: listingHeaders(api, input.apiKey),
        redirect: "manual",
        signal: AbortSignal.timeout(LLM_DISCOVERY_TIMEOUT_MS),
      });
    } catch (error) {
      throw asDiscoveryError(error);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new LlmConfigError(LLM_ERROR.DISCOVERY_FAILED, "model discovery does not follow redirects");
    }
    const text = await readBoundedBody(response);
    if (!response.ok) {
      throw new LlmConfigError(LLM_ERROR.DISCOVERY_FAILED, "model listing was refused by the endpoint", {
        status: response.status,
      });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new LlmConfigError(LLM_ERROR.DISCOVERY_FAILED, "model listing was not JSON");
    }
    const listed = readListing(body);
    const truncated = listed.length > LLM_DISCOVERY_MAX_MODELS;
    return {
      truncated,
      models: listed.slice(0, LLM_DISCOVERY_MAX_MODELS),
    };
  }

  async test(input: LlmProbeTestInput): Promise<{ ok: true; modelId: string }> {
    const api = requirePinnedApi(input.api);
    const baseURL = requireBaseUrl(input.baseURL);
    if (typeof input.modelId !== "string" || input.modelId === "") {
      throw new LlmConfigError(LLM_ERROR.MODEL_NOT_FOUND, "testConnection requires a model id");
    }
    const url = testUrl(baseURL, api);
    const body = testBody(api, input.modelId);
    const headers = testHeaders(api, input.apiKey);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(LLM_DISCOVERY_TIMEOUT_MS),
      });
    } catch (error) {
      throw asDiscoveryError(error);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new LlmConfigError(LLM_ERROR.DISCOVERY_FAILED, "connection test does not follow redirects");
    }
    await readBoundedBody(response);
    if (!response.ok) {
      throw new LlmConfigError(LLM_ERROR.DISCOVERY_FAILED, "connection test was refused by the endpoint", {
        status: response.status,
      });
    }
    return { ok: true, modelId: input.modelId };
  }
}

function requirePinnedApi(api: string): string {
  if (!isPinnedProtocol(api)) {
    throw new LlmConfigError(LLM_ERROR.UNSUPPORTED_PROTOCOL, "protocol is not pinned for this runtime", { api });
  }
  return api;
}

function requireBaseUrl(baseURL: unknown): string {
  if (typeof baseURL !== "string" || baseURL === "") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "discovery requires a baseURL");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "baseURL is not a valid URL");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "baseURL cannot carry userinfo, query, or fragment");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "baseURL must be http or https");
  }
  return baseURL.replace(/\/+$/u, "");
}

function listingUrl(baseURL: string, api: string): string {
  if (api !== "anthropic-messages") return `${baseURL}/models`;
  return `${baseURL.endsWith("/v1") ? baseURL.slice(0, -3) : baseURL}/v1/models?limit=${String(LLM_DISCOVERY_MAX_MODELS)}`;
}

function listingHeaders(api: string, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (api === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function readListing(body: unknown): Array<{ id: string; name?: string }> {
  if (!body || typeof body !== "object") {
    throw new LlmConfigError(LLM_ERROR.DISCOVERY_FAILED, "model listing body is not an object");
  }
  const row = body as { data?: unknown; models?: unknown };
  const out: Array<{ id: string; name?: string }> = [];
  if (Array.isArray(row.data)) {
    for (const item of row.data) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id === "") continue;
      const name = (item as { name?: unknown }).name;
      out.push({ id, ...(typeof name === "string" && name ? { name } : {}) });
    }
  } else if (row.models && typeof row.models === "object" && !Array.isArray(row.models)) {
    for (const [key, item] of Object.entries(row.models)) {
      if (!item || typeof item !== "object") continue;
      const nestedId = (item as { id?: unknown }).id;
      const id = key || (typeof nestedId === "string" ? nestedId : "");
      if (!id) continue;
      const name = (item as { name?: unknown }).name;
      out.push({ id, ...(typeof name === "string" && name ? { name } : {}) });
    }
  } else {
    throw new LlmConfigError(LLM_ERROR.DISCOVERY_FAILED, "model listing is not a data array or models map");
  }
  return out;
}

function testUrl(baseURL: string, api: string): string {
  if (api === "openai-completions") return `${baseURL}/chat/completions`;
  if (api === "openai-responses") return `${baseURL}/responses`;
  return `${baseURL.endsWith("/v1") ? baseURL : `${baseURL}/v1`}/messages`;
}

function testHeaders(api: string, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (api === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function testBody(api: string, modelId: string): Record<string, unknown> {
  if (api === "openai-completions") {
    return {
      model: modelId,
      messages: [{ role: "user", content: LLM_TEST_PROMPT }],
      max_tokens: LLM_TEST_MAX_TOKENS,
      stream: false,
    };
  }
  if (api === "openai-responses") {
    return {
      model: modelId,
      input: LLM_TEST_PROMPT,
      max_output_tokens: LLM_TEST_MAX_TOKENS,
    };
  }
  return {
    model: modelId,
    max_tokens: LLM_TEST_MAX_TOKENS,
    messages: [{ role: "user", content: LLM_TEST_PROMPT }],
  };
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > LLM_DISCOVERY_MAX_BYTES) {
    await response.body?.cancel();
    throw new LlmConfigError(LLM_ERROR.DISCOVERY_FAILED, "provider response exceeded the size bound");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LLM_DISCOVERY_MAX_BYTES) {
        throw new LlmConfigError(LLM_ERROR.DISCOVERY_FAILED, "provider response exceeded the size bound");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function asDiscoveryError(error: unknown): LlmConfigError {
  if (error instanceof LlmConfigError) return error;
  const message = error instanceof Error ? error.message : "discovery failed";
  if (/secret|api[_-]?key|bearer|sk-/i.test(message)) {
    return new LlmConfigError(LLM_ERROR.DISCOVERY_FAILED, "the provider request failed");
  }
  return new LlmConfigError(LLM_ERROR.DISCOVERY_FAILED, message.slice(0, 200));
}
