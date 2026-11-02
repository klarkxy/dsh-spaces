import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkbenchApi, WorkbenchCommand, WorkbenchState } from "../../../../src/shared/workbench";
import { validDesktopSpaceAction, type DesktopSpaceAction } from "../types";

/** One explicit operation; polling only observes its result, never resubmits it. */
export async function runDesktopSpaceAction(api: WorkbenchApi, request: DesktopSpaceAction, timeoutMs = 240_000,
  initialState?: WorkbenchState): Promise<WorkbenchState> {
  if (!validDesktopSpaceAction(request)) throw Error("Invalid space action.");
  const { spaceId, action, serviceEpoch } = request;
  const deadline = Date.now() + timeoutMs;
  const inspect = (state: WorkbenchState) => {
    if (state.serviceEpoch !== serviceEpoch || state.availability === "unavailable" || state.maintenance) throw Error("The space service changed or is unavailable.");
    const space = state.spaces.find(row => row.id === spaceId);
    if (state.spaces.some(row => row.id === "desktop") || spaceId === "desktop" || spaceId === "web" ||
        !space || !space.managed || space.isHost || spaceId === state.managerId || !space.hasWebApp) throw Error("Only managed child spaces can be controlled from the Desktop rail.");
    return space;
  };
  let state = initialState ?? await api.state();
  let space = inspect(state);
  if (request.expectedGeneration !== undefined && request.expectedGeneration !== space.generation) throw Error("空间已发生变化，请重新确认操作。");
  if ((action === "open" || action === "start") && space.status === "running") return state;
  if (action === "stop" && space.status === "stopped") return state;
  // Another accepted launch is already in progress. Observe it without creating a second job.
  if ((action === "open" || action === "start") && space.status === "starting") {
    while (Date.now() < deadline) {
      await delay(250);
      state = await api.state(); space = inspect(state);
      if (space.status === "running") return state;
      if (space.status !== "starting") throw Error("The existing space launch did not succeed.");
    }
    throw Error("The space launch result could not be confirmed before the deadline.");
  }
  if (!state.writable) throw Error("The space service is read-only.");
  if (space.status === "unknown" || space.status === "stopping" || (action === "restart" && space.status === "starting")) {
    throw Error("The space state does not allow this operation.");
  }
  const context = { serviceEpoch, expectedRevision: state.revision };
  let command: WorkbenchCommand;
  if (action === "open" || action === "start") command = { kind: "space.start", spaceId };
  else {
    const plan = await api.preview({ kind: action === "stop" ? "space.stop" : "space.restart", spaceId }, context);
    if (plan.kind !== `space.${action}` || plan.scope !== "space" || plan.destructive ||
        plan.serviceEpoch !== serviceEpoch || plan.stateRevision !== state.revision ||
        plan.affectedSpaceIds.length !== 1 || plan.affectedSpaceIds[0] !== spaceId ||
        !Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= Date.now()) throw Error("The space operation requires a new review in space management.");
    if (plan.taskActivity !== "idle" && !request.interruptAccepted) throw Error("空间存在运行中的任务或任务状态无法确认。请确认任务中断影响后再操作。");
    command = { kind: "plan.execute", planId: plan.id };
  }
  const requestId = "desktop-space-" + randomUUID();
  let job = await api.submit(command, requestId, context);
  const id = job.id;
  for (;;) {
    if (job.id !== id || job.requestId !== requestId) throw Error("The space operation result does not match the request.");
    if (job.status === "failed" || job.status === "cancelled") throw Error(job.error?.message || job.message || "The space operation failed.");
    if (job.status === "succeeded") {
      state = await api.state();
      const final = inspect(state);
      if (final.status !== (action === "stop" ? "stopped" : "running")) throw Error("The space operation completed without the expected running state.");
      return state;
    }
    if (!["queued", "running"].includes(job.status) || Date.now() >= deadline) throw Error("The space operation result could not be confirmed. No request was resent.");
    await delay(250);
    job = await api.job(id);
  }
}
