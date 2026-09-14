import { join } from "node:path";
import {
  HOME_CONTROL_DIR_NAME,
  HomeController,
  parseControlEndpoint,
} from "../../../../src/adapters/node/home-controller";
import { workbenchStateSchema } from "./workbench-schemas";
import { workbenchPost, type WorkbenchHttpFetch } from "./workbench-http";
import { readEndpointFile, SUPERVISOR_ENDPOINT_FILE, type SupervisorEndpoint } from "./supervisor-endpoint";

export type LeaseVerdict = "ok" | "free" | "foreign" | "ambiguous" | "dead";

export async function pingSupervisorState(
  endpoint: SupervisorEndpoint,
  doFetch?: WorkbenchHttpFetch,
): Promise<boolean> {
  try {
    await workbenchPost(doFetch ?? fetch, endpoint.origin, endpoint.bearer, "state", {}, workbenchStateSchema);
    return true;
  } catch {
    return false;
  }
}

export function inspectLease(home: string, origin: string, allowRealHome: boolean): LeaseVerdict {
  let controller: HomeController;
  try {
    controller = new HomeController(home, { allowRealHome });
  } catch {
    return "ambiguous";
  }
  const inspection = controller.inspect();
  if (!inspection.held) return "free";
  if ("incomplete" in inspection && inspection.incomplete) return "ambiguous";
  if ("reclaim" in inspection && inspection.reclaim) return "ambiguous";
  if ("ambiguous" in inspection && inspection.ambiguous) return "ambiguous";
  if (!("owner" in inspection)) return "ambiguous";
  if (inspection.liveness === "ambiguous") return "ambiguous";
  if (inspection.liveness === "dead") return "dead";
  const ownerOrigin = ownerOriginOf(inspection.owner.endpoint);
  if (ownerOrigin && ownerOrigin !== origin) return "foreign";
  return "ok";
}

export async function attachExistingSupervisor(options: {
  home: string;
  allowRealHome: boolean;
  fetch?: WorkbenchHttpFetch;
}): Promise<
  | { endpoint: SupervisorEndpoint }
  | { missing: true }
  | { blocked: true; reasons: string[] }
  | { stale: true; reasons: string[] }
> {
  const path = join(options.home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE);
  const endpoint = readEndpointFile(path);
  if (!endpoint) return { missing: true };
  const lease = inspectLease(options.home, endpoint.origin, options.allowRealHome);
  if (lease === "foreign" || lease === "ambiguous" || lease === "dead") {
    return {
      blocked: true,
      reasons: [
        lease === "foreign"
          ? "A different controller already holds the workbench endpoint."
          : lease === "dead"
            ? "The recorded controller is dead. The lease was not cleared."
            : "Controller ownership is incomplete or ambiguous. The lease was not cleared.",
      ],
    };
  }
  const alive = await pingSupervisorState(endpoint, options.fetch);
  if (!alive) {
    return {
      stale: true,
      reasons: ["The recorded supervisor endpoint did not accept a private bearer state ping."],
    };
  }
  return { endpoint };
}

function ownerOriginOf(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(parseControlEndpoint(endpoint)).origin;
  } catch {
    return null;
  }
}
