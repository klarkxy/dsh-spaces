import type { WorkbenchController } from "./store";
import type { SpaceSurfaceView as ViewHandshakeConfig } from "../../../../src/shared/space-host";
import { PORTAL_SPACE_RE } from "../../../../src/shared/space-host";

export interface SurfaceSelection { requestId: number; target: string | null }
export function parseSurfaceSelection(event: { source: unknown; origin: string; data: unknown },
  parent: unknown, view: ViewHandshakeConfig): SurfaceSelection | null {
  if (!parent || event.source !== parent || event.origin !== view.parentOrigin || !event.data ||
      typeof event.data !== "object" || Array.isArray(event.data)) return null;
  const row = event.data as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "channel,generation,requestId,serviceEpoch,source,spaceId,target,type" ||
      row.source !== "dsh-spaces-surface-parent" || row.type !== "select" ||
      row.serviceEpoch !== view.serviceEpoch || row.spaceId !== view.spaceId || row.generation !== view.generation ||
      row.channel !== view.channel || !Number.isSafeInteger(row.requestId) || (row.requestId as number) < 1 ||
      !(row.target === null || typeof row.target === "string" && PORTAL_SPACE_RE.test(row.target))) return null;
  return { requestId: row.requestId as number, target: row.target as string | null };
}

/** Navigation only, authorized by the existing manager parent handshake. No start/stop/submit relay. */
export function attachSurfaceBridge(controller: WorkbenchController, view: ViewHandshakeConfig,
  parent: Pick<Window, "postMessage">, listen: (fn: (event: MessageEvent) => void) => () => void): () => void {
  let pending: SurfaceSelection | null = null, stopped = false, lastRequest = 0;
  const answer = (request: SurfaceSelection, type: "selected" | "selection-failed") => {
    if (stopped) return;
    parent.postMessage({ source: "dsh-spaces-surface", type, requestId: request.requestId, target: request.target,
      serviceEpoch: view.serviceEpoch, spaceId: view.spaceId, generation: view.generation, channel: view.channel }, view.parentOrigin);
  };
  let initiated = false;
  const check = () => {
    if (!pending || stopped) return;
    const ui = controller.getSnapshot(), request = pending;
    if (ui.boot === "loading") return;
    if (ui.state?.serviceEpoch !== view.serviceEpoch || ui.state?.managerId !== view.spaceId ||
        ui.state?.availability === "unavailable" || ui.boot === "error" || ui.viewError?.spaceId === request.target) {
      pending = null; answer(request, "selection-failed"); return;
    }
    if (!initiated) {
      initiated = true;
      if (request.target === null) controller.selectHome();
      else if (!controller.selectRunningSpace(request.target)) { pending = null; answer(request, "selection-failed"); }
      if (pending) check();
      return;
    }
    if (ui.selected === (request.target ?? "home") && ui.pendingId === null) {
      pending = null; answer(request, "selected");
    }
  };
  const removeListener = listen(event => {
    const request = parseSurfaceSelection(event, parent, view);
    if (!request || stopped || request.requestId <= lastRequest) return;
    lastRequest = request.requestId;
    pending = request; initiated = false;
    check();
  });
  const unsubscribe = controller.subscribe(check);
  parent.postMessage({ source: "dsh-spaces-surface", type: "ready", serviceEpoch: view.serviceEpoch,
    spaceId: view.spaceId, generation: view.generation, channel: view.channel }, view.parentOrigin);
  return () => { stopped = true; pending = null; removeListener(); unsubscribe(); };
}
