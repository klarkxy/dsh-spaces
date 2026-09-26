import React, { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import type { WorkbenchApi } from "../../../../src/shared/workbench";
import type { SpaceSurfaceView } from "../../../../src/shared/space-host";
import { attachSurfaceBridge } from "./surface-bridge";
import { WorkbenchHome } from "./dashboard-home";
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
  const [chatOpened, setChatOpened] = useState(false);
  const [chatActive, setChatActive] = useState(false);
  const [systemPage, setSystemPage] = useState<"dashboard" | "settings" | null>(null);
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
    homeUrl={chatOpened ? homeUrl : undefined} chatActive={chatActive}
    homeContent={<WorkbenchHome api={api} ui={ui} controller={controller} chatAvailable={!nativeSurface && !!homeUrl}
      onChat={active => { setChatActive(active); if (active) setChatOpened(true); }} />} />;
}
