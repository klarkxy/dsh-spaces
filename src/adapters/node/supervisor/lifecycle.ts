import type { WorkbenchSpace, WorkbenchState } from "../../../shared/workbench";
import type { HomeControlHandle } from "../home/home-controller";
import { WorkbenchPublicError } from "./errors";

export class SupervisorLifecycle {
  constructor(private readonly validateRegistry?: () => void) {}

  handle: HomeControlHandle | undefined;
  closed = false;
  sealing = false;
  blocked = false;
  initializing = false;
  managerStartFailure: string | undefined;
  managerBootstrapFailure: string | undefined;
  registryFailure: string | undefined;
  maintenanceBlocked = false;
  shutdownFailure: "before-stop" | "final-save" | undefined;
  maintenanceFlag = false;
  // Inventory is a display snapshot while maintenance swaps its backing tree.
  // Admission still uses the live controller and transaction locks.
  maintenanceInventory: { mode: WorkbenchState["mode"]; spaces: WorkbenchSpace[] } | null = null;
  relinquishKind: "service.shutdown" | null = null;
  relinquishJobId: string | null = null;
  activeJobId: string | undefined;
  reasons: string[] = [];
  private derivedReasons = new Set<string>();

  addReason(reason: string): void {
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
  }

  assertWritable(): void {
    if (!this.handle) throw new WorkbenchPublicError("workbench/read-only");
    if (this.registryFailure) throw new WorkbenchPublicError("workbench/unavailable", this.registryFailure);
    this.validateRegistry?.();
    if (this.managerBootstrapFailure) {
      throw new WorkbenchPublicError("workbench/unavailable", this.managerBootstrapFailure);
    }
    if (this.initializing) throw new WorkbenchPublicError("workbench/unavailable", "The supervisor is still initializing.");
    if (this.maintenanceBlocked) {
      const message = this.shutdownFailure === "final-save"
        ? "Owned processes stopped, but shutdown completion could not be saved. Further changes are blocked."
        : this.shutdownFailure === "before-stop"
          ? "Shutdown failed before stopping began. Further changes are blocked."
          : "Stop failed; new maintenance is refused.";
      throw new WorkbenchPublicError("workbench/unavailable", message);
    }
    if (this.sealing && !this.relinquishKind) throw new WorkbenchPublicError("workbench/unavailable");
  }

  admitSubmission(): void {
    if (this.closed || this.sealing || this.relinquishKind) {
      throw new WorkbenchPublicError("workbench/unavailable", "The supervisor is releasing run rights.");
    }
    this.assertWritable();
  }

  endRelinquish(): void {
    this.relinquishKind = null;
    this.relinquishJobId = null;
  }

  availability(env: { cli: boolean; managerUsable: boolean; unmanaged: number }): WorkbenchState["availability"] {
    if (!this.handle || this.closed || this.sealing) return "unavailable";
    if (this.blocked || this.maintenanceBlocked || env.unmanaged > 0 || !env.cli) return "limited";
    if (!env.managerUsable) return "limited";
    if (this.derivedReasons.size > 0) return "limited";
    return "ready";
  }

  applyDerivedReasons(extra: string[], latchBlock: boolean): void {
    this.reasons = [...new Set([
      ...this.reasons.filter(reason => !this.derivedReasons.has(reason)),
      ...extra,
    ])];
    this.derivedReasons = new Set(extra);
    if (latchBlock && extra.length > 0) this.blocked = true;
  }
}
