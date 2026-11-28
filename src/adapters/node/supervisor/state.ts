import type { WorkbenchHomeSettings } from "../../../shared/workbench-product";
import type { WorkbenchAutoResume, WorkbenchMutationContext, WorkbenchSpace, WorkbenchState } from "../../../shared/workbench";
import type { HomeLease } from "../home/home-lease";
import { readSettings } from "../home/hub-settings";
import type { HomeOperationLock } from "../home/home-operation-lock";
import type { WorkbenchJobStore } from "../maintenance/workbench-jobs";
import type { NodeSpacesService } from "../products/spaces-service";
import {
  WORKBENCH_PROTOCOL_VERSION,
  WorkbenchProtocolConflictError,
  WorkbenchProtocolInputError,
  assertMutationContext,
  computeWorkbenchRevision,
  deriveServiceEpoch,
} from "../server/workbench-protocol";
import { STOP_KEPT_REASON, WORKBENCH_ERROR, WorkbenchPublicError } from "./errors";
import type { SupervisorLifecycle } from "./lifecycle";
import type { SpaceRunRegistry } from "./space-runs";
import type { BoundCli } from "./types";

export interface SupervisorStateHost {
  home: string;
  lease: HomeLease;
  lifecycle: SupervisorLifecycle;
  runs: SpaceRunRegistry;
  lock: HomeOperationLock;
  cli: () => BoundCli | null;
  managerId: () => string | null;
  managerInstall: () => "missing" | "manager" | "ordinary" | "damaged";
  jobs: () => WorkbenchJobStore | undefined;
  spaces: () => NodeSpacesService | undefined;
  listSpaces: () => WorkbenchSpace[];
  publicStatus: (id: string) => WorkbenchSpace["status"];
  hasMaintenanceEvidence: () => boolean;
  homeSettings: () => WorkbenchHomeSettings | undefined;
  setHomeSettings: (settings: WorkbenchHomeSettings) => void;
  autoResume: () => WorkbenchAutoResume | undefined;
}

/**
 * The read model: the assembled workbench state, its revision, and the
 * service epoch that authorises a mutation. Availability is derived here so
 * the facade and the parts observe the same latched reasons.
 */
export class SupervisorState {
  constructor(private readonly host: SupervisorStateHost) {}

  async state(): Promise<WorkbenchState> {
    const lifecycle = this.host.lifecycle;
    if (lifecycle.registryFailure) throw new WorkbenchPublicError("workbench/unavailable", lifecycle.registryFailure);
    this.refreshAvailability(false);
    const owner = lifecycle.maintenanceFlag && lifecycle.handle
      ? { kind: lifecycle.handle.owner.kind, since: lifecycle.handle.owner.startedAt }
      : this.readOwner();
    const inventory = lifecycle.maintenanceFlag ? lifecycle.maintenanceInventory : null;
    const spaces = inventory ? inventory.spaces.map(row => ({
      ...row,
      status: this.host.runs.unmanaged.has(row.id) ? "unknown" as const : this.host.publicStatus(row.id),
      generation: this.host.runs.views.get(row.id)?.generation ?? this.host.runs.generations.get(row.id) ?? row.generation,
      managed: Boolean(lifecycle.handle) && !this.host.runs.unmanaged.has(row.id),
    })) : this.host.listSpaces();
    const service = this.host.spaces();
    const autoResume = this.host.autoResume();
    return {
      protocolVersion: WORKBENCH_PROTOCOL_VERSION,
      serviceEpoch: this.currentServiceEpoch(),
      revision: this.stateRevision(spaces),
      availability: this.availability(),
      role: this.role(),
      managerId: this.host.managerId(),
      owner,
      writable: Boolean(lifecycle.handle),
      mode: inventory?.mode ?? service?.capabilities().mode ?? "unknown-readonly",
      dshVersion: this.host.cli()?.version ?? null,
      maintenance: lifecycle.maintenanceFlag,
      reasons: [...lifecycle.reasons],
      spaces,
      jobs: this.host.jobs()?.list() ?? [],
      ...(autoResume ? { autoResume: { ...autoResume, failedSpaceIds: [...autoResume.failedSpaceIds] } } : {}),
    };
  }

  stateRevision(spaces: WorkbenchSpace[] = this.host.listSpaces()): string {
    return computeWorkbenchRevision({ spaces, settings: this.readHomeSettings() });
  }

  readHomeSettings(): WorkbenchHomeSettings {
    const cached = this.host.homeSettings();
    if (cached) return cached;
    const raw = readSettings(this.host.home);
    const settings: WorkbenchHomeSettings = {
      portStart: raw.portStart,
      portEnd: raw.portEnd,
      packageSource: raw.packageSource,
      catalogUrl: raw.catalogUrl,
      restoreRunningSpacesOnLaunch: raw.restoreRunningSpacesOnLaunch,
    };
    this.host.setHomeSettings(settings);
    return settings;
  }

  availability(): WorkbenchState["availability"] {
    const managerId = this.host.managerId();
    return this.host.lifecycle.availability({
      cli: Boolean(this.host.cli()),
      managerUsable: !(managerId && this.host.managerInstall() !== "manager"),
      unmanaged: this.host.runs.unmanaged.size,
    });
  }

  role(): WorkbenchState["role"] {
    if (!this.host.managerId()) return "uninitialized";
    if (this.host.managerInstall() === "manager") return "manager";
    if (this.host.managerInstall() === "ordinary") return "workspace";
    return "uninitialized";
  }

  productObservation(): { serviceEpoch: string; expectedRevision: string } {
    return { serviceEpoch: this.requireServiceEpoch(), expectedRevision: this.stateRevision() };
  }

  readOwner(): WorkbenchState["owner"] {
    const inspection = this.host.lease.inspect();
    if (!inspection.held || !("owner" in inspection)) return null;
    return { kind: inspection.owner.kind, since: inspection.owner.startedAt };
  }

  assertLiveContext(context: WorkbenchMutationContext): void {
    try {
      assertMutationContext(context, {
        serviceEpoch: this.requireServiceEpoch(),
        revision: this.stateRevision(),
      });
    } catch (error) {
      if (error instanceof WorkbenchProtocolConflictError) {
        throw new WorkbenchPublicError("workbench/conflict", error.message);
      }
      if (error instanceof WorkbenchProtocolInputError) {
        throw new WorkbenchPublicError("workbench/invalid-input", error.message);
      }
      throw error;
    }
  }

  currentServiceEpoch(): string {
    const nonce = this.host.lifecycle.handle?.owner.nonce ?? this.peekOwnerNonce();
    if (!nonce) return "";
    return deriveServiceEpoch(nonce);
  }

  peekOwnerNonce(): string | undefined {
    const inspection = this.host.lease.inspect();
    if (inspection.held && "owner" in inspection) return inspection.owner.nonce;
    return undefined;
  }

  requireServiceEpoch(): string {
    const epoch = this.currentServiceEpoch();
    if (!epoch) throw new WorkbenchPublicError("workbench/unavailable");
    return epoch;
  }

  /** Public `state()` passes false so a first-boot poll cannot latch a transient extra. */
  refreshAvailability(latchBlock = true): void {
    const extra: string[] = [];
    if (!this.host.jobs()?.list().some(job => job.status === "running")) {
      if (this.host.lifecycle.maintenanceFlag || this.host.hasMaintenanceEvidence() || this.host.lock.inspect().held) extra.push("Unfinished Home maintenance journal is present.");
    }

    if (!this.host.cli()) extra.push(WORKBENCH_ERROR["workbench/incompatible"]);
    const managerId = this.host.managerId();
    if (managerId && this.host.managerInstall() !== "manager") {
      extra.push("The manager profile cannot be used.");
    }
    if (this.host.runs.unmanaged.size) extra.push("Leftover processes were not adopted.");
    if (this.host.lifecycle.maintenanceBlocked && !this.host.lifecycle.shutdownFailure) extra.push(STOP_KEPT_REASON);
    this.host.lifecycle.applyDerivedReasons(extra, latchBlock);
  }
}
