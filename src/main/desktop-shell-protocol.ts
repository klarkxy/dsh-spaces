import { randomUUID } from "node:crypto";
import { workbenchMutationContextSchema } from "../shared/workbench-product-schemas";
import type {
  WorkbenchApi,
  WorkbenchJob,
  WorkbenchMutationContext,
  WorkbenchPlan,
  WorkbenchState,
} from "../shared/workbench";

export type ShellWorkbenchPort = Pick<WorkbenchApi, "state" | "preview" | "submit" | "job">;

export interface StopSpacesResult {
  kind: "stop-spaces";
  stopped: string[];
  failed: string | null;
  job: WorkbenchJob | null;
  remaining: string[];
  message?: string;
}

export interface ShutdownServiceResult {
  kind: "shutdown-service";
  job: WorkbenchJob | null;
  succeeded: boolean;
  disconnected: boolean;
  message: string;
}

export interface ProtocolHelpers {
  requestId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

const DISCONNECTED = "The workbench service disconnected before the job finished.";
const SHUTDOWN_UNCONFIRMED =
  "The service disappeared after shutdown was submitted. The last received job is kept; the result is not confirmed.";
const STOP_FAILED = "A space could not be stopped. Remaining spaces were left as they were.";
const MISSING_PLAN_EPOCH = "The preview is missing a service identity.";
const MISSING_PLAN_REVISION = "The preview is missing a state revision.";
const MISSING_MANAGER = "The workbench state is missing a manager identity.";
const UNKNOWN_SPACE = "The workbench state contains an unknown space record.";
const UNSUPPORTED_PROTOCOL = "This workbench protocol is not supported.";
const SERVICE_UNAVAILABLE = "The workbench service is unavailable.";
const EPOCH_CHANGED = "The workbench service identity changed. Remaining spaces were not stopped.";
const OWNERSHIP_CHANGED = "That space is no longer an owned ordinary workspace. Remaining spaces were not stopped.";
const TARGET_MISSING = "That space is no longer in the workbench state. Remaining spaces were not stopped.";

export function mutationContextFromState(state: WorkbenchState): WorkbenchMutationContext {
  if (state.protocolVersion !== 2) throw new Error(UNSUPPORTED_PROTOCOL);
  if (state.availability === "unavailable") throw new Error(SERVICE_UNAVAILABLE);
  return workbenchMutationContextSchema.parse({
    serviceEpoch: state.serviceEpoch,
    expectedRevision: state.revision,
  });
}

export function ownedOrdinaryStopTargets(state: WorkbenchState): string[] {
  mutationContextFromState(state);
  if (typeof state.managerId !== "string" || !state.managerId.trim()) {
    throw new Error(MISSING_MANAGER);
  }
  if (!Array.isArray(state.spaces)) throw new Error(UNKNOWN_SPACE);
  const targets: string[] = [];
  for (const space of state.spaces) {
    if (!space || typeof space.id !== "string" || !space.id || typeof space.managed !== "boolean") {
      throw new Error(UNKNOWN_SPACE);
    }
    if (space.id === "web" || space.id === state.managerId) continue;
    if (space.managed !== true) continue;
    if (space.status === "running" || space.status === "starting") targets.push(space.id);
  }
  return targets;
}

export function assertPlanMatches(plan: WorkbenchPlan, context: WorkbenchMutationContext): void {
  if (typeof plan.serviceEpoch !== "string" || !plan.serviceEpoch) {
    throw new Error(MISSING_PLAN_EPOCH);
  }
  if (typeof plan.stateRevision !== "string" || !plan.stateRevision) {
    throw new Error(MISSING_PLAN_REVISION);
  }
  const parsed = workbenchMutationContextSchema.parse({
    serviceEpoch: plan.serviceEpoch,
    expectedRevision: plan.stateRevision,
  });
  if (parsed.serviceEpoch !== context.serviceEpoch) {
    throw new Error("The preview does not match the current service identity.");
  }
  if (parsed.expectedRevision !== context.expectedRevision) {
    throw new Error("The preview does not match the current workbench revision.");
  }
}

export async function stopOwnedSpaces(
  api: ShellWorkbenchPort,
  helpers: ProtocolHelpers = {},
): Promise<StopSpacesResult> {
  const initial = await api.state();
  const initialContext = mutationContextFromState(initial);
  const targets = ownedOrdinaryStopTargets(initial);
  const stopped: string[] = [];
  let lastJob: WorkbenchJob | null = null;
  const requestId = helpers.requestId ?? randomUUID;
  for (const spaceId of targets) {
    const remaining = targets.filter((id) => !stopped.includes(id));
    const state = await api.state();
    const context = mutationContextFromState(state);
    if (context.serviceEpoch !== initialContext.serviceEpoch) {
      return {
        kind: "stop-spaces",
        stopped,
        failed: spaceId,
        job: lastJob,
        remaining,
        message: EPOCH_CHANGED,
      };
    }
    const current = state.spaces.find((row) => row.id === spaceId);
    if (!current) {
      return {
        kind: "stop-spaces",
        stopped,
        failed: spaceId,
        job: lastJob,
        remaining,
        message: TARGET_MISSING,
      };
    }
    if (current.managed !== true || current.id === "web" || current.id === state.managerId) {
      return {
        kind: "stop-spaces",
        stopped,
        failed: spaceId,
        job: lastJob,
        remaining,
        message: OWNERSHIP_CHANGED,
      };
    }
    if (current.status !== "running" && current.status !== "starting") {
      stopped.push(spaceId);
      continue;
    }
    const plan = await api.preview({ kind: "space.stop", spaceId }, context);
    assertPlanMatches(plan, context);
    if (plan.serviceEpoch !== initialContext.serviceEpoch) {
      return {
        kind: "stop-spaces",
        stopped,
        failed: spaceId,
        job: lastJob,
        remaining,
        message: EPOCH_CHANGED,
      };
    }
    const submitted = await api.submit({ kind: "plan.execute", planId: plan.id }, requestId(), context);
    const settled = await waitForJob(api, submitted, helpers);
    lastJob = settled.job;
    if (settled.disconnected || settled.job.status !== "succeeded") {
      return {
        kind: "stop-spaces",
        stopped,
        failed: spaceId,
        job: settled.job,
        remaining,
      };
    }
    stopped.push(spaceId);
  }
  return { kind: "stop-spaces", stopped, failed: null, job: lastJob, remaining: [] };
}

export async function shutdownWorkbenchService(
  api: ShellWorkbenchPort,
  helpers: ProtocolHelpers = {},
): Promise<ShutdownServiceResult> {
  let job: WorkbenchJob | null = null;
  try {
    const state = await api.state();
    const context = mutationContextFromState(state);
    const plan = await api.preview({ kind: "service.shutdown" }, context);
    assertPlanMatches(plan, context);
    job = await api.submit(
      { kind: "plan.execute", planId: plan.id },
      (helpers.requestId ?? randomUUID)(),
      context,
    );
    const settled = await waitForJob(api, job, helpers);
    if (settled.disconnected) {
      return {
        kind: "shutdown-service",
        job: settled.job,
        succeeded: false,
        disconnected: true,
        message: SHUTDOWN_UNCONFIRMED,
      };
    }
    return {
      kind: "shutdown-service",
      job: settled.job,
      succeeded: settled.job.status === "succeeded",
      disconnected: false,
      message: settled.job.message || settled.job.status,
    };
  } catch (error) {
    if (job) {
      return {
        kind: "shutdown-service",
        job,
        succeeded: false,
        disconnected: isUnavailable(error),
        message: isUnavailable(error) ? SHUTDOWN_UNCONFIRMED : messageOf(error),
      };
    }
    throw error;
  }
}

export async function waitForJob(
  api: Pick<WorkbenchApi, "job">,
  job: WorkbenchJob,
  helpers: ProtocolHelpers = {},
): Promise<{ job: WorkbenchJob; disconnected: boolean }> {
  let current = job;
  if (isTerminalJob(current)) return { job: current, disconnected: false };
  const sleep = helpers.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    for (;;) {
      await sleep(50);
      current = await api.job(current.id);
      if (isTerminalJob(current)) return { job: current, disconnected: false };
    }
  } catch (error) {
    if (isUnavailable(error)) return { job: current, disconnected: true };
    throw error;
  }
}

export function stopFailureMessage(result: StopSpacesResult): string {
  if (!result.failed) return "";
  if (result.message) return result.message;
  if (result.job && result.job.status !== "succeeded") {
    return result.job.error?.message || result.job.message || STOP_FAILED;
  }
  return DISCONNECTED;
}

function isTerminalJob(job: WorkbenchJob): boolean {
  return job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
}

function isUnavailable(error: unknown): boolean {
  const message = messageOf(error).toLowerCase();
  return (
    message.includes("unavailable") ||
    message.includes("econnrefused") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "The workbench request failed.";
}
