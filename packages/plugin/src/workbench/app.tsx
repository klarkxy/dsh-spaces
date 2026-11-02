import React, { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import type { WorkbenchApi } from "../../../../src/shared/workbench";
import type { SpaceSurfaceView } from "../../../../src/shared/space-host";
import { attachSurfaceBridge } from "./surface-bridge";
import { WorkbenchView } from "./components";
import { WorkbenchController, type WorkbenchEnv } from "./store";

export interface WorkbenchAppProps {
  api: WorkbenchApi;
  env?: Partial<WorkbenchEnv>;
  homeUrl?: string;
  contained?: boolean;
  nativeSurface?: boolean;
  surfaceView?: SpaceSurfaceView;
}

/**
 * Production workbench root. Hosts inject a real WorkbenchApi.
 * Closing a tab does not call shutdown; that is an explicit settings action.
 */
export function WorkbenchApp({ api, env, homeUrl, contained = false, nativeSurface = false, surfaceView }: WorkbenchAppProps): ReactElement {
  const controller = useMemo(() => new WorkbenchController(api, env), [api, env]);
  const [systemPage, setSystemPage] = useState<"settings" | null>(null);
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  useEffect(() => {
    if (!contained || typeof window === "undefined" || window.parent === window) return;
    const view = surfaceView;
    if (!view) return;
    return attachSurfaceBridge(controller, view, window.parent, listener => {
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    }, nativeSurface ? setSystemPage : undefined);
  }, [controller, contained, surfaceView, nativeSurface]);
  return <WorkbenchView contained={contained} nativeSurface={nativeSurface} systemPage={systemPage} ui={ui} controller={controller}
    requestServiceStop={nativeSurface && surfaceView ? () => window.parent.postMessage({ source: "dsh-spaces-surface", type: "service-stop-preview",
      serviceEpoch: surfaceView.serviceEpoch, spaceId: surfaceView.spaceId, generation: surfaceView.generation, channel: surfaceView.channel }, surfaceView.parentOrigin) : undefined}
    homeUrl={homeUrl} />;
}
