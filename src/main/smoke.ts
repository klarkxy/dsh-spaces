import { randomUUID } from "node:crypto";
import type { ProcessManager } from "./process-manager";

async function rpc(port: number, method: string): Promise<unknown> {
  const origin = `http://127.0.0.1:${port}`;
  const res = await fetch(`${origin}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      type: "client-request",
      rpcId: randomUUID(),
      method,
      payload: {},
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { result?: { ok?: boolean; value?: unknown } };
  if (!body.result?.ok) throw new Error(`${method} RPC failed: ${text.slice(0, 200)}`);
  return body.result.value;
}

export async function smokeLifecycle(processes: ProcessManager): Promise<void> {
  const web = await processes.start("web");
  const coding = await processes.start("coding");
  const writing = await processes.start("writing");
  const listsBefore = {
    web: JSON.stringify(await rpc(web.port, "session.list")),
    writing: JSON.stringify(await rpc(writing.port, "session.list")),
  };
  await rpc(coding.port, "session.list");
  console.log("SMOKE A3: web + coding + writing APIs live");
  const restarted = await processes.restart("coding");
  const webAfter = JSON.stringify(await rpc(web.port, "session.list"));
  const writingAfter = JSON.stringify(await rpc(writing.port, "session.list"));
  if (webAfter !== listsBefore.web) {
    throw new Error("web session.list changed after coding restart");
  }
  if (writingAfter !== listsBefore.writing) {
    throw new Error("writing session.list changed after coding restart");
  }
  await rpc(restarted.port, "session.list");
  console.log("SMOKE A9: coding restart left web/writing unchanged");
  await processes.stopAll();
}
