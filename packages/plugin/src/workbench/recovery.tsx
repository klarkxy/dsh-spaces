import React, { useEffect, useMemo, useSyncExternalStore, type ReactElement } from "react";
import type { WorkbenchApi } from "../../../../src/shared/workbench";
import { RecoveryView } from "./components";
import { WorkbenchController, type WorkbenchEnv } from "./store";

export interface RecoverySurfaceProps {
  api: WorkbenchApi;
  env?: Partial<WorkbenchEnv>;
}

/**
 * Stable-entry recovery page. Shows jobs, read-only reasons, acquire and resume.
 * Does not embed or fake a manager frame; the supervisor wires that later.
 */
export function RecoverySurface({ api, env }: RecoverySurfaceProps): ReactElement {
  const controller = useMemo(() => new WorkbenchController(api, env), [api, env]);
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  return (
    <RecoveryView
      locale={ui.locale}
      state={ui.state}
      error={ui.error}
      commandError={ui.commandError}
      onLocale={controller.setLocale}
      onAcquire={controller.acquire}
      onResume={controller.resume}
      onCancelJob={controller.cancelJob}
      onRefresh={() => void controller.poll()}
    />
  );
}
