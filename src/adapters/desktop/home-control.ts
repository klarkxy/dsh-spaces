import { MaintenanceGate } from "../../core/application/maintenance-gate";
import { HomeOperationLock } from "../node/home-operation-lock";
import { lstatSync } from "node:fs";
import { join } from "node:path";

export interface DesktopHomeControl {
  readonly lock: HomeOperationLock;
  readonly maintenance: MaintenanceGate;
  mutate<T>(action: () => T | Promise<T>): Promise<T>;
  runMaintenance<T>(label: string, action: () => Promise<T>): Promise<T>;
}

export function createDesktopHomeControl(home: string): DesktopHomeControl {
  const lock = new HomeOperationLock(home);
  const maintenance = new MaintenanceGate(lock);
  const journal = join(lock.home, ".dsh-spaces-mutation.json");
  const hasPendingMutation = () => {
    try { lstatSync(journal); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const assertNoUnfinishedEvidence = () => {
    if (hasPendingMutation()) {
      throw new Error("A Spaces operation left unfinished evidence. Writes are blocked.");
    }
  };
  return {
    lock,
    maintenance,
    mutate<T>(action: () => T | Promise<T>): Promise<T> {
      return maintenance.runMutation(async () => { assertNoUnfinishedEvidence(); return action(); });
    },
    runMaintenance<T>(label: string, action: () => Promise<T>): Promise<T> {
      return maintenance.run(label, async () => {
        if (label !== "quit") assertNoUnfinishedEvidence();
        return action();
      });
    },
  };
}
