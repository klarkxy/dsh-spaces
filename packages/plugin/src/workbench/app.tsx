import React, { useEffect, useMemo, useSyncExternalStore, type ReactElement } from "react";
import type { WorkbenchApi } from "../../../../src/shared/workbench";
import { WorkbenchView } from "./components";
import { WorkbenchController, type WorkbenchEnv } from "./store";

export interface WorkbenchAppProps {
  api: WorkbenchApi;
  env?: Partial<WorkbenchEnv>;
}

/**
 * Production workbench root. Hosts inject a real WorkbenchApi.
 * Closing a tab does not call shutdown; that is an explicit settings action.
 */
export function WorkbenchApp({ api, env }: WorkbenchAppProps): ReactElement {
  const controller = useMemo(() => new WorkbenchController(api, env), [api, env]);
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  return <WorkbenchView ui={ui} controller={controller} />;
}
