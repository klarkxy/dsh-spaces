import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_MANAGER_FILE,
  HOME_CONTROL_OWNER_FILE,
  HOME_CONTROL_RUN_DIR_NAME,
  HomeController,
  type HomeControlHandle,
} from "../src/adapters/node/home-controller.ts";
import { canonicalHome } from "../src/adapters/node/home-operation-lock.ts";
import { deriveServiceEpoch, digestHomeIdentity } from "../src/adapters/node/workbench-protocol.ts";
import { attachExistingSupervisor } from "../packages/plugin/src/host/supervisor-attach.ts";
import {
  bootstrapSupervisor,
  SUPERVISOR_ENDPOINT_FILE,
} from "../packages/plugin/src/host/supervisor-bootstrap.ts";
import {
  endpointHomeId,
  endpointServiceEpoch,
  readEndpointFile,
  writeEndpointFile,
  type SupervisorEndpoint,
} from "../packages/plugin/src/host/supervisor-endpoint.ts";
import {
  mutationContextSchema,
  workbenchCommandSchema,
  workbenchPlanRequestSchema,
  workbenchStateSchema,
} from "../packages/plugin/src/host/workbench-schemas.ts";

const temps: string[] = [];
const handles: HomeControlHandle[] = [];
const BEARER = "B".repeat(32);
const REVISION = "ab".repeat(32);
const SINCE = "2026-09-20T00:00:00.000Z";

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try {
      handle.release();
    } catch {
      /* test isolation */
    }
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-ep-v2-"));
  temps.push(home);
  return home;
}

function endpointPath(home: string): string {
  return join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE);
}

function acquireWeb(home: string, origin: string): HomeControlHandle {
  const handle = new HomeController(home, { allowRealHome: false }).acquire("web", `${origin}/`);
  handles.push(handle);
  return handle;
}

function v2Record(home: string, origin: string, nonce: string): SupervisorEndpoint {
  return {
    origin,
    bearer: BEARER,
    protocolVersion: 2,
    homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
    serviceEpoch: deriveServiceEpoch(nonce),
  };
}

function v2State(epoch: string) {
  return {
    protocolVersion: 2 as const,
    serviceEpoch: epoch,
    revision: REVISION,
    availability: "ready" as const,
    role: "manager" as const,
    managerId: "spaces-hub",
    owner: { kind: "web" as const, since: SINCE },
    writable: true,
    mode: "verified-full" as const,
    dshVersion: "0.1.5-rc.1",
    maintenance: false,
    reasons: [],
    spaces: [],
    jobs: [],
  };
}

function okFetch(epoch: string): (input: string, init: RequestInit) => Promise<Response> {
  return async (_input, init) => {
    const auth = String((init.headers as Record<string, string>).authorization ?? "");
    if (auth !== `Bearer ${BEARER}`) {
      return new Response(JSON.stringify({ ok: false, error: { code: "workbench/unauthorized", message: "no" } }), {
        status: 401,
      });
    }
    return new Response(JSON.stringify({ ok: true, value: v2State(epoch) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function deadFetch(): (input: string, init: RequestInit) => Promise<Response> {
  return async () => new Response("{}", { status: 500 });
}

test("healthy v2 attach matches canonical home, web lease origin, and authenticated epoch", async () => {
  const home = tempHome();
  const origin = "http://127.0.0.1:9";
  const handle = acquireWeb(home, origin);
  const record = v2Record(home, origin, handle.owner.nonce);
  writeEndpointFile(endpointPath(home), record);
  const attached = await attachExistingSupervisor({
    home,
    allowRealHome: false,
    fetch: okFetch(record.serviceEpoch),
  });
  assert.equal("endpoint" in attached, true);
  if (!("endpoint" in attached)) return;
  assert.equal(attached.endpoint.protocolVersion, 2);
  const homeId = digestHomeIdentity(canonicalHome(home, { allowRealHome: false }));
  const epoch = deriveServiceEpoch(handle.owner.nonce);
  assert.equal(attached.endpoint.homeId, homeId);
  assert.equal(attached.endpoint.serviceEpoch, epoch);
  assert.equal(endpointHomeId(home), homeId);
  assert.equal(endpointServiceEpoch(handle.owner.nonce), epoch);
  assert.equal(attached.endpoint.origin, origin);
  assert.equal(JSON.stringify(attached).includes(handle.owner.nonce), false);
});

test("same Home path alias normalizes to the canonical homeId", async () => {
  const home = tempHome();
  const origin = "http://127.0.0.1:9";
  const handle = acquireWeb(home, origin);
  const record = v2Record(home, origin, handle.owner.nonce);
  writeEndpointFile(endpointPath(home), record);
  const alias = join(home, ".");
  const attached = await attachExistingSupervisor({
    home: alias,
    allowRealHome: false,
    fetch: okFetch(record.serviceEpoch),
  });
  assert.equal("endpoint" in attached, true);
  if (!("endpoint" in attached)) return;
  assert.equal(attached.endpoint.homeId, digestHomeIdentity(canonicalHome(home, { allowRealHome: false })));
});

test("endpoint homeId from another Home is blocked", async () => {
  const home = tempHome();
  const other = tempHome();
  const origin = "http://127.0.0.1:9";
  const handle = acquireWeb(home, origin);
  const record = v2Record(other, origin, handle.owner.nonce);
  writeEndpointFile(endpointPath(home), record);
  const attached = await attachExistingSupervisor({
    home,
    allowRealHome: false,
    fetch: okFetch(record.serviceEpoch),
  });
  assert.equal("blocked" in attached, true);
  if (!("blocked" in attached)) return;
  assert.ok(attached.reasons.some((row) => /different Home/i.test(row)));
});

test("wrong service epoch is blocked", async () => {
  const home = tempHome();
  const origin = "http://127.0.0.1:9";
  const handle = acquireWeb(home, origin);
  const record = {
    ...v2Record(home, origin, handle.owner.nonce),
    serviceEpoch: "cd".repeat(32),
  };
  writeEndpointFile(endpointPath(home), record);
  const attached = await attachExistingSupervisor({
    home,
    allowRealHome: false,
    fetch: okFetch(record.serviceEpoch),
  });
  assert.equal("blocked" in attached, true);
  if (!("blocked" in attached)) return;
  assert.ok(attached.reasons.some((row) => /epoch/i.test(row)));
  assert.equal(JSON.stringify(attached).includes(handle.owner.nonce), false);
});

test("free lease with a recorded endpoint is blocked, not missing", async () => {
  const home = tempHome();
  const origin = "http://127.0.0.1:9";
  writeEndpointFile(endpointPath(home), {
    origin,
    bearer: BEARER,
    protocolVersion: 2,
    homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
    serviceEpoch: "ab".repeat(32),
  });
  const attached = await attachExistingSupervisor({
    home,
    allowRealHome: false,
    fetch: okFetch("ab".repeat(32)),
  });
  assert.equal("blocked" in attached, true);
  assert.equal("missing" in attached, false);
});

test("missing endpoint with a held lock is blocked", async () => {
  const home = tempHome();
  acquireWeb(home, "http://127.0.0.1:9");
  const attached = await attachExistingSupervisor({ home, allowRealHome: false, fetch: deadFetch() });
  assert.equal("blocked" in attached, true);
  assert.equal("missing" in attached, false);
  assert.equal(existsSync(endpointPath(home)), false);
});

test("old version and invalid bytes are rejected and left in place", async () => {
  const home = tempHome();
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME), { recursive: true });
  const v1 = `${JSON.stringify({ version: 1, origin: "http://127.0.0.1:9", bearer: BEARER })}\n`;
  writeFileSync(endpointPath(home), v1);
  const old = await attachExistingSupervisor({ home, allowRealHome: false, fetch: deadFetch() });
  assert.equal("blocked" in old, true);
  assert.equal("missing" in old, false);
  assert.equal(readFileSync(endpointPath(home), "utf8"), v1);
  assert.equal("endpoint" in readEndpointFile(endpointPath(home)), false);

  const raw = "{not-json";
  writeFileSync(endpointPath(home), raw);
  const broken = await attachExistingSupervisor({ home, allowRealHome: false, fetch: deadFetch() });
  assert.equal("blocked" in broken, true);
  assert.equal(readFileSync(endpointPath(home), "utf8"), raw);
});

test("stale authenticated endpoint does not cold-start", async () => {
  const home = tempHome();
  const origin = "http://127.0.0.1:9";
  const handle = acquireWeb(home, origin);
  writeEndpointFile(endpointPath(home), v2Record(home, origin, handle.owner.nonce));
  let spawned = 0;
  const result = await bootstrapSupervisor({
    home,
    allowRealHome: false,
    allowColdStart: true,
    payloadRoot: tempHome(),
    toolsRoot: tempHome(),
    timeoutMs: 200,
    fetch: deadFetch(),
    spawn: () => {
      spawned += 1;
    },
  });
  assert.equal(result.connected, false);
  assert.equal(spawned, 0);
  assert.ok(result.reasons.some((row) => /ping/i.test(row)));
});

test("owner origin mismatch is blocked", async () => {
  const home = tempHome();
  const handle = acquireWeb(home, "http://127.0.0.1:1");
  const record = v2Record(home, "http://127.0.0.1:9", handle.owner.nonce);
  writeEndpointFile(endpointPath(home), record);
  const attached = await attachExistingSupervisor({
    home,
    allowRealHome: false,
    fetch: okFetch(record.serviceEpoch),
  });
  assert.equal("blocked" in attached, true);
  if (!("blocked" in attached)) return;
  assert.ok(attached.reasons.some((row) => /different controller/i.test(row)));
});

test("owner change after ping is rejected", async () => {
  const home = tempHome();
  const origin = "http://127.0.0.1:9";
  const first = acquireWeb(home, origin);
  const record = v2Record(home, origin, first.owner.nonce);
  writeEndpointFile(endpointPath(home), record);
  const attached = await attachExistingSupervisor({
    home,
    allowRealHome: false,
    fetch: async (_input, init) => {
      first.release();
      acquireWeb(home, origin);
      return okFetch(record.serviceEpoch)(_input, init);
    },
  });
  assert.equal("blocked" in attached, true);
  if (!("blocked" in attached)) return;
  assert.ok(attached.reasons.some((row) => /changed/i.test(row)));
  assert.equal(JSON.stringify(attached).includes(first.owner.nonce), false);
});

test("missing endpoint without a lease does not write Home business state", async () => {
  const home = tempHome();
  const before = snapshot(home);
  const attached = await attachExistingSupervisor({ home, allowRealHome: false, fetch: deadFetch() });
  assert.equal("missing" in attached, true);
  assert.deepEqual(snapshot(home), before);
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE)), false);
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME, HOME_CONTROL_OWNER_FILE)), false);
});

test("schemas accept v2 state and reject recovery or takeover commands", () => {
  const epoch = "ab".repeat(32);
  assert.equal(workbenchStateSchema.safeParse(v2State(epoch)).success, true);
  assert.equal(workbenchStateSchema.safeParse({ ...v2State(epoch), recoveryRequired: false }).success, false);
  assert.equal(workbenchCommandSchema.safeParse({ kind: "controller.acquire" }).success, false);
  assert.equal(workbenchCommandSchema.safeParse({ kind: "recovery.resume" }).success, false);
  assert.equal(workbenchPlanRequestSchema.safeParse({ kind: "snapshot.restore", snapshotId: "s".repeat(8) }).success, false);
  assert.equal(workbenchPlanRequestSchema.safeParse({ kind: "controller.release" }).success, false);
  assert.equal(workbenchPlanRequestSchema.safeParse({ kind: "service.shutdown" }).success, true);
  assert.equal(mutationContextSchema.safeParse({ serviceEpoch: epoch, expectedRevision: REVISION }).success, true);
});

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      out.push(full.slice(root.length).replaceAll("\\", "/"));
      try {
        walk(full);
      } catch {
        /* file */
      }
    }
  };
  walk(root);
  return out.sort();
}
