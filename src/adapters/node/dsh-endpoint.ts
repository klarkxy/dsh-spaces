import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";

/** Do not probe a reserved port until this child confirms it bound that exact endpoint. */
export function waitForDshEndpoint(child: ChildProcess, port: number, signal: AbortSignal, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let tail = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown, url?: string) => { cleanup(); error ? reject(error) : resolve(url!); };
    const onData = (chunk: Buffer | string) => {
      tail = (tail + (typeof chunk === "string" ? chunk : decoder.write(chunk))).slice(-16384);
      const announced = tail.match(/dsh web:\s*(https?:\/\/[^\s\x1b]+)(?=[\s\x1b])/)?.[1];
      if (!announced) return;
      try {
        const endpoint = new URL(announced);
        if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || Number(endpoint.port) !== port || endpoint.username || endpoint.password || endpoint.pathname !== "/") {
          finish(new Error(`DSH opened an unexpected endpoint instead of the reserved localhost port ${port}. Retry after resolving the port conflict.`));
        } else finish(undefined, endpoint.href);
      } catch (error) { finish(error); }
    };
    const onExit = () => finish(new Error("DSH exited before announcing its API endpoint."));
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(signal.reason || new Error("DSH startup cancelled."));
    const timer = setTimeout(() => finish(new Error(`DSH API startup timed out after ${timeoutMs}ms without announcing its endpoint.`)), timeoutMs);
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

/** Exchange the owned child's launch URL without following redirects or leaking its token. */
export async function dshSessionCookie(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<string | undefined> {
  if (!new URL(url).searchParams.has("token")) return undefined;
  const response = await fetchImpl(url, { redirect: "manual", signal });
  const cookies = response.headers.getSetCookie();
  await response.body?.cancel();
  const cookie = cookies.map(value => value.split(";", 1)[0]).find(value => /^dsh-auth-[^=]+=.+$/.test(value));
  // Alpha uses a directory-relative clean redirect for mounted web apps.
  // Accept only the two known root forms; never follow arbitrary locations.
  const location = response.headers.get("location");
  if (response.status !== 303 || (location !== "/" && location !== "./") || !cookie) {
    throw new Error("DSH browser authentication failed.");
  }
  return cookie;
}

/** DSH moved session.list to the typed session/list transport in newer releases. */
export async function dshSessionList(port: number, fetchImpl: typeof fetch, signal: AbortSignal, cookie?: string): Promise<unknown> {
  const origin = `http://127.0.0.1:${port}`;
  for (const method of ["session.list", "session/list"]) {
    const response = await fetchImpl(`${origin}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, connection: "close", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method,
        payload: method === "session.list" ? {} : { args: { _request: {} } } }),
      signal,
    });
    const text = await response.text();
    if (response.status === 404 && method === "session.list") continue;
    if (!response.ok) throw new Error(`session.list HTTP ${response.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { result?: { ok?: boolean; value?: unknown } };
    if (!body.result?.ok) throw new Error(`session.list RPC failed: ${text.slice(0, 200)}`);
    return body.result.value;
  }
  throw new Error("DSH session list endpoint is unavailable.");
}
