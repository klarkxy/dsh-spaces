import type { WorkbenchController } from "./store";
import type { SpaceSurfaceView as ViewHandshakeConfig } from "../../../../src/shared/space-host";
import { isNativeSpaceTarget } from "../../../../src/shared/space-host";

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
      !(row.target === null || isNativeSpaceTarget(row.target))) return null;
  return { requestId: row.requestId as number, target: row.target as string | null };
}

export interface SurfaceIntent { requestId: number }
/**
 * The desktop shell asks the manager for a new space with one closed intent.
 * It is a presentation request inside the existing manager handshake: it
 * carries no right, no credential and no management request.
 */
export function parseSurfaceIntent(event: { source: unknown; origin: string; data: unknown },
  parent: unknown, view: ViewHandshakeConfig): SurfaceIntent | null {
  if (!parent || event.source !== parent || event.origin !== view.parentOrigin || !event.data ||
      typeof event.data !== "object" || Array.isArray(event.data)) return null;
  const row = event.data as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "channel,generation,intent,requestId,serviceEpoch,source,spaceId,type" ||
      row.source !== "dsh-spaces-surface-parent" || row.type !== "intent" || row.intent !== "create" ||
      row.serviceEpoch !== view.serviceEpoch || row.spaceId !== view.spaceId || row.generation !== view.generation ||
      row.channel !== view.channel || !Number.isSafeInteger(row.requestId) || (row.requestId as number) < 1) return null;
  return { requestId: row.requestId as number };
}

/** Navigation only, authorized by the existing manager parent handshake. No start/stop/submit relay. */
export function attachSurfaceBridge(controller: WorkbenchController, view: ViewHandshakeConfig,
  parent: Pick<Window, "postMessage">, listen: (fn: (event: MessageEvent) => void) => () => void,
  systemPage?: (page: "settings" | null) => void): () => void {
  let pending: SurfaceSelection | null = null, stopped = false, lastRequest = 0, lastIntent = 0;
  let page: "settings" | null = null;
  const answer = (request: SurfaceSelection, type: "selected" | "selection-failed") => {
    if (stopped) return;
    parent.postMessage({ source: "dsh-spaces-surface", type, requestId: request.requestId, target: request.target,
      serviceEpoch: view.serviceEpoch, spaceId: view.spaceId, generation: view.generation, channel: view.channel }, view.parentOrigin);
  };
  let initiated = false, selecting = false;
  const check = () => {
    if (!pending || stopped) return;
    const ui = controller.getSnapshot(), request = pending;
    if (ui.boot === "loading") return;
    if (ui.state?.serviceEpoch !== view.serviceEpoch || ui.state?.managerId !== view.spaceId ||
        ui.state?.availability === "unavailable" || ui.boot === "error" || ui.viewError?.spaceId === request.target) {
      pending = null; answer(request, "selection-failed"); return;
    }
    if (selecting) return;
    if (!initiated) {
      initiated = true;
      if (request.target === "@settings") {
        if (!systemPage) { pending = null; answer(request, "selection-failed"); return; }
        page = "settings";
        systemPage(page);
        controller.closeOverlay(); controller.selectHome();
        controller.openSettings();
      } else if (request.target === null) { page = null; if (systemPage) { systemPage(null); controller.closeOverlay(); } controller.selectHome(); }
      else {
        selecting = true;
        page = null;
        if (systemPage) { systemPage(null); controller.closeOverlay(); }
        void Promise.resolve(controller.selectRunningSpace(request.target, () => !stopped && pending === request)).then(accepted => {
          if (stopped || pending !== request) return;
          selecting = false;
          if (!accepted) { pending = null; answer(request, "selection-failed"); }
          else check();
        }, () => {
          if (stopped || pending !== request) return;
          selecting = false; pending = null; answer(request, "selection-failed");
        });
        return;
      }
      if (pending) check();
      return;
    }
    if (ui.selected === (request.target === "@settings" ? "home" : request.target ?? "home") &&
        (request.target !== "@settings" || ui.overlay?.type === "settings") && ui.pendingId === null) {
      pending = null; answer(request, "selected");
    }
  };
  const removeListener = listen(event => {
    const intent = parseSurfaceIntent(event, parent, view);
    if (intent) {
      if (stopped || intent.requestId <= lastIntent) return;
      lastIntent = intent.requestId;
      // Only the native surface knows this intent, and only its settings page
      // may open the create dialog on top of it.
      if (!systemPage || page !== "settings") return;
      const ui = controller.getSnapshot();
      if (ui.selected !== "home" || ui.overlay?.type !== "settings") return;
      controller.openCreate();
      return;
    }
    const request = parseSurfaceSelection(event, parent, view);
    if (!request || stopped || request.requestId <= lastRequest) return;
    lastRequest = request.requestId;
    pending = request; initiated = false; selecting = false;
    check();
  });
  const unsubscribe = controller.subscribe(check);
  parent.postMessage({ source: "dsh-spaces-surface", type: "ready", serviceEpoch: view.serviceEpoch,
    spaceId: view.spaceId, generation: view.generation, channel: view.channel }, view.parentOrigin);
  return () => { stopped = true; pending = null; removeListener(); unsubscribe(); };
}
