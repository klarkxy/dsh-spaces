import React, { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import type { WorkbenchApi } from "../../../../src/shared/workbench";
import { WorkbenchHome } from "./dashboard-home";
import { WorkbenchView } from "./components";
import { WorkbenchController, type WorkbenchEnv } from "./store";

export interface WorkbenchAppProps {
  api: WorkbenchApi;
  env?: Partial<WorkbenchEnv>;
  homeUrl?: string;
}

/**
 * Production workbench root. Hosts inject a real WorkbenchApi.
 * Closing a tab does not call shutdown; that is an explicit settings action.
 */
export function WorkbenchApp({ api, env, homeUrl }: WorkbenchAppProps): ReactElement {
  const controller = useMemo(() => new WorkbenchController(api, env), [api, env]);
  const [chatOpened, setChatOpened] = useState(false);
  const [chatActive, setChatActive] = useState(false);
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  return <WorkbenchView ui={ui} controller={controller}
    homeUrl={chatOpened ? homeUrl : undefined} chatActive={chatActive}
    homeContent={<WorkbenchHome api={api} ui={ui} controller={controller} chatAvailable={!!homeUrl}
      onChat={active => { setChatActive(active); if (active) setChatOpened(true); }} />} />;
}
