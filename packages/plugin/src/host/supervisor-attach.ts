import { join } from "node:path";
import {
  HOME_CONTROL_DIR_NAME,
  HomeController,
  validLaunchOwner,
  parseControlEndpoint,
  type HomeControlInspect,
  type HomeControlOwner,
} from "../../../../src/adapters/node/home-controller";
import { workbenchStateSchema } from "./workbench-schemas";
import { workbenchPost, type WorkbenchHttpFetch } from "./workbench-http";
import {
  endpointHomeId,
  endpointServiceEpoch,
  readEndpointFile,
  SUPERVISOR_ENDPOINT_FILE,
  type SupervisorEndpoint,
} from "./supervisor-endpoint";

export type LeaseVerdict = "ok" | "free" | "foreign" | "ambiguous" | "dead" | "unbound" | "mismatch";

export type SupervisorAttachResult =
  | { endpoint: SupervisorEndpoint }
  | { missing: true; previousOwner?: HomeControlOwner }
  | { blocked: true; reasons: string[] }
  | { stale: true; reasons: string[] };

export interface SupervisorAttachOptions {
  home: string;
  allowRealHome: boolean;
  fetch?: WorkbenchHttpFetch;
  /** Reusable discovery handle; inspect() always re-reads on-disk state. */
  controller?: HomeController;
}

const HELD_NO_ENDPOINT = "A controller holds the Home lease but no supervisor endpoint was found.";
const ENDPOINT_WITHOUT_LEASE =
  "A supervisor endpoint is recorded but no controller holds the Home lease. The lease was not cleared.";
const FOREIGN_OWNER = "A different controller already holds the workbench endpoint.";
const DEAD_OWNER = "The recorded controller is dead. The lease was not cleared.";
const AMBIGUOUS_OWNER = "Controller ownership is incomplete or ambiguous. The lease was not cleared.";
const UNBOUND_ORIGIN = "The recorded controller does not bind a workbench endpoint.";
const HOME_MISMATCH = "The recorded supervisor endpoint belongs to a different Home.";
const EPOCH_MISMATCH = "The recorded supervisor service epoch does not match the current Home lease.";
const PROTOCOL_MISMATCH = "The supervisor protocol or service epoch does not match this Home.";
const OWNER_CHANGED = "Controller ownership changed while authenticating the supervisor endpoint.";
const STALE_PING = "The recorded supervisor endpoint did not accept a private bearer state ping.";
const HOME_UNAVAILABLE = "The DSH home could not be opened safely.";

export async function pingSupervisorState(
  endpoint: SupervisorEndpoint,
  doFetch?: WorkbenchHttpFetch,
): Promise<boolean> {
  try {
    const state = await workbenchPost(
      doFetch ?? fetch,
      endpoint.origin,
      endpoint.bearer,
      "state",
      {},
      workbenchStateSchema,
    );
    if (state.protocolVersion !== 2) return false;
    if (state.serviceEpoch !== endpoint.serviceEpoch) return false;
    return true;
  } catch {
    return false;
  }
}

export function inspectLease(
  home: string,
  origin: string,
  allowRealHome: boolean,
  identity?: { homeId: string; serviceEpoch: string },
): LeaseVerdict {
  let controller: HomeController;
  try {
    controller = new HomeController(home, { allowRealHome });
  } catch {
    return "ambiguous";
  }
  return verdictOf(controller.inspect(), origin, identity);
}

export async function attachExistingSupervisor(
  options: SupervisorAttachOptions,
): Promise<SupervisorAttachResult> {
  let controller: HomeController;
  if (options.controller) {
    controller = options.controller;
  } else {
    try {
      controller = new HomeController(options.home, { allowRealHome: options.allowRealHome });
    } catch {
      return blocked([HOME_UNAVAILABLE]);
    }
  }

  const homeId = endpointHomeId(controller.home, { allowRealHome: options.allowRealHome });
  const path = join(controller.home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE);
  const recorded = readEndpointFile(path);
  const before = controller.inspect();

  if ("missing" in recorded) {
    if (!before.held) return { missing: true };
    if (isDeadLaunchOwner(before)) return { missing: true, previousOwner: before.owner };
    return blocked([heldReason(before)]);
  }
  if ("invalid" in recorded) {
    return blocked(recorded.reasons);
  }

  const endpoint = recorded.endpoint;
  if (endpoint.homeId !== homeId) return blocked([HOME_MISMATCH]);

  const beforeVerdict = verdictOf(before, endpoint.origin, {
    homeId: endpoint.homeId,
    serviceEpoch: endpoint.serviceEpoch,
  });
  // Discovery never mutates disk. Only a subsequent explicit launch may retire
  // this exact dead owner; a polling client cannot start or clear anything.
  if (beforeVerdict === "dead" && isDeadLaunchOwner(before)) {
    return { missing: true, previousOwner: before.owner };
  }
  const beforeBlock = leaseRejection(beforeVerdict);
  if (beforeBlock) return beforeBlock;

  let state;
  try {
    state = await workbenchPost(
      options.fetch ?? fetch,
      endpoint.origin,
      endpoint.bearer,
      "state",
      {},
      workbenchStateSchema,
    );
  } catch {
    return { stale: true, reasons: [STALE_PING] };
  }

  const after = controller.inspect();
  if (ownerFingerprint(before) !== ownerFingerprint(after)) {
    return blocked([OWNER_CHANGED]);
  }
  const afterVerdict = verdictOf(after, endpoint.origin, {
    homeId: endpoint.homeId,
    serviceEpoch: endpoint.serviceEpoch,
  });
  const afterBlock = leaseRejection(afterVerdict);
  if (afterBlock) return afterBlock;

  if (state.protocolVersion !== 2 || state.serviceEpoch !== endpoint.serviceEpoch) {
    return blocked([PROTOCOL_MISMATCH]);
  }
  return { endpoint };
}

function verdictOf(
  inspection: HomeControlInspect,
  origin: string,
  identity?: { homeId: string; serviceEpoch: string },
): LeaseVerdict {
  if (!inspection.held) return "free";
  if ("incomplete" in inspection && inspection.incomplete) return "ambiguous";
  if ("reclaim" in inspection && inspection.reclaim) return "ambiguous";
  if ("ambiguous" in inspection && inspection.ambiguous) return "ambiguous";
  if ("handoff" in inspection && inspection.handoff) return "ambiguous";
  if (!("owner" in inspection)) return "ambiguous";
  if (inspection.liveness === "ambiguous") return "ambiguous";
  if (inspection.owner.kind !== "web") return "foreign";
  const ownerOrigin = ownerOriginOf(inspection.owner.endpoint);
  if (!ownerOrigin) return "unbound";
  if (ownerOrigin !== origin) return "foreign";
  if (identity) {
    try {
      if (endpointServiceEpoch(inspection.owner.nonce) !== identity.serviceEpoch) return "mismatch";
    } catch {
      return "mismatch";
    }
  }
  if (inspection.liveness === "dead") return "dead";
  return "ok";
}

function isDeadLaunchOwner(inspection: HomeControlInspect): inspection is Extract<HomeControlInspect, { owner: HomeControlOwner }> {
  return inspection.held && "owner" in inspection && !("handoff" in inspection) &&
    (inspection.owner.kind === "web" || (inspection.owner.kind === "desktop" && !inspection.owner.endpoint)) &&
    inspection.liveness === "dead" && validLaunchOwner(inspection.owner);
}

function leaseRejection(
  verdict: LeaseVerdict,
): { blocked: true; reasons: string[] } | { stale: true; reasons: string[] } | null {
  if (verdict === "ok") return null;
  if (verdict === "free") return blocked([ENDPOINT_WITHOUT_LEASE]);
  if (verdict === "dead") return blocked([DEAD_OWNER]);
  if (verdict === "foreign") return blocked([FOREIGN_OWNER]);
  if (verdict === "unbound") return blocked([UNBOUND_ORIGIN]);
  if (verdict === "mismatch") return blocked([EPOCH_MISMATCH]);
  return blocked([AMBIGUOUS_OWNER]);
}

function heldReason(inspection: HomeControlInspect): string {
  if ("incomplete" in inspection && inspection.incomplete) return AMBIGUOUS_OWNER;
  if ("reclaim" in inspection && inspection.reclaim) return AMBIGUOUS_OWNER;
  if ("ambiguous" in inspection && inspection.ambiguous) return AMBIGUOUS_OWNER;
  if ("handoff" in inspection && inspection.handoff) return AMBIGUOUS_OWNER;
  if ("owner" in inspection && inspection.liveness === "dead") return DEAD_OWNER;
  if ("owner" in inspection && inspection.owner.kind !== "web") return FOREIGN_OWNER;
  return HELD_NO_ENDPOINT;
}

function ownerFingerprint(inspection: HomeControlInspect): string {
  if (!inspection.held || !("owner" in inspection)) return `held:${inspection.held}`;
  return [
    inspection.owner.kind,
    String(inspection.owner.pid),
    inspection.owner.nonce,
    inspection.owner.endpoint ?? "",
    inspection.liveness,
  ].join("\0");
}

function blocked(reasons: string[]): { blocked: true; reasons: string[] } {
  return { blocked: true, reasons };
}

function ownerOriginOf(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(parseControlEndpoint(endpoint)).origin;
  } catch {
    return null;
  }
}
