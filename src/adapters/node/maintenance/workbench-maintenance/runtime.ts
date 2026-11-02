import { profileBase } from '../../profile/space-base';
import { join } from "node:path";
import { lt as semverLt } from "semver";
import { SPACES_MIN_DSH_VERSION } from "../../../../shared/runtime";
import type { WorkbenchPlanRequest } from "../../../../shared/workbench";
import { unmetProfileDshRequirements, unmetInstalledThirdPartyDshPeers } from "../../payload/component-cli";
import type { WorkbenchJobContext, WorkbenchJobResult } from "../workbench-jobs";
import { MaintenanceSnapshots } from "./snapshots";
import { WorkbenchMaintenanceError } from "./errors";
import type { ResolvedCommand, StoredPlan } from "./types";
import { requireExactVersion } from "./validation";

/**
 * Runtime and toolchain switching: pin a space to a DSH version or remove an
 * installed runtime that no space depends on.
 */
export class MaintenanceRuntime extends MaintenanceSnapshots {
  protected async planSpaceRuntimeSet(
    id: string,
    createdAt: string,
    expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "space.runtime.set" }>,
  ): Promise<StoredPlan> {
    const spaceId = this.targetSpace(request.spaceId, false);
    if (profileBase(this.ports.home, spaceId) === 'browser') throw new WorkbenchMaintenanceError('workbench/invalid-input', 'Browser framework versions are fixed by the Browser base release.');
    const version = requireExactVersion(request.version);
    if (semverLt(version, SPACES_MIN_DSH_VERSION)) {
      throw new WorkbenchMaintenanceError(
        "workbench/invalid-input",
        `DSH ${version} is below the minimum ${SPACES_MIN_DSH_VERSION} supported by this Spaces version.`,
      );
    }
    const pin = this.pinnedDshVersionOf(spaceId);
    if (pin && semverLt(version, pin)) {
      throw new WorkbenchMaintenanceError("workbench/invalid-input", "Downgrading a space's DSH version is not allowed.");
    }
    this.rejectUnsupportedRuntimePeers(spaceId, version);
    const runningSpaceIds = this.runningOf([spaceId]);
    const command: ResolvedCommand = { kind: "space.runtime.set", spaceId, version };
    const willDownload = !this.runtimeBinFor(version);
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "space.runtime.set",
      title: pin === version ? `Re-apply DSH ${version} to ${spaceId}` : `Set ${spaceId} to DSH ${version}`,
      scope: "space",
      affectedSpaceIds: [spaceId],
      runningSpaceIds,
      changes: [
        !pin
          ? `Pin ${spaceId} to DSH ${version}.`
          : pin === version
            ? `Re-apply DSH ${version} to ${spaceId}.`
            : `Switch ${spaceId} from DSH ${pin} to DSH ${version}.`,
        willDownload ? `Download and install DSH ${version}.` : `DSH ${version} is already installed.`,
        `Official plugins come from DSH ${version} itself.`,
        "No snapshot is created. Downgrading later is not allowed.",
        runningSpaceIds.length ? `${spaceId} will be stopped and started again.` : `${spaceId} is stopped and stays stopped.`,
      ],
      destructive: false,
      expiresAt,
    });
  }

  protected planRuntimeRemove(id: string, createdAt: string, expiresAt: string, version: string): StoredPlan {
    const exact = requireExactVersion(version);
    const blocked = this.runtimeRemoveBlockReason(exact);
    if (blocked) throw new WorkbenchMaintenanceError("workbench/invalid-input", blocked);
    const command: ResolvedCommand = { kind: "runtime.remove", version: exact };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "runtime.remove",
      title: `Remove runtime ${exact}`,
      scope: "home",
      affectedSpaceIds: this.owned(),
      runningSpaceIds: [],
      changes: [
        `Delete the installed runtime ${exact} from the Spaces runtime store.`,
        "Spaces pinned to other versions are not affected.",
      ],
      destructive: true,
      expiresAt,
    });
  }

  protected async runSpaceRuntimeSet(
    command: Extract<ResolvedCommand, { kind: "space.runtime.set" }>,
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchJobResult> {
    const { spaceId, version } = command;
    this.rejectUnsupportedRuntimePeers(spaceId, version);
    const wasRunning = this.runningOf([spaceId]).length > 0;
    if (wasRunning) {
      ctx.phase("stop");
      ctx.cancellable(true);
      ctx.message(`Stopping ${spaceId}.`);
      this.throwIfAborted(ctx);
      await this.ports.stopSpace(spaceId);
    }
    ctx.cancellable(false);
    if (!this.runtimeBinFor(version)) {
      ctx.phase("runtime");
      ctx.message(`Installing runtime ${version}.`);
      await this.ports.runtimes.install(version);
      if (!this.runtimeBinFor(version)) {
        throw new WorkbenchMaintenanceError("workbench/failed", `DSH ${version} is not installed.`);
      }
    }
    ctx.phase("pin");
    ctx.message(`Pinning ${spaceId} to DSH ${version}.`);
    this.ports.registry.updateMeta(spaceId, { dshVersion: version, base: 'web', baseVersion: version });
    if (wasRunning) {
      ctx.phase("start");
      ctx.message(`Starting ${spaceId}.`);
      await this.ports.startSpace(spaceId);
    }
    ctx.result({ spaceId, dshVersion: version });
    return { spaceId, dshVersion: version };
  }

  protected async runRuntimeRemove(version: string, ctx: WorkbenchJobContext): Promise<WorkbenchJobResult> {
    ctx.phase("remove");
    ctx.cancellable(false);
    const blocked = this.runtimeRemoveBlockReason(version);
    if (blocked) throw new WorkbenchMaintenanceError("workbench/invalid-input", blocked);
    ctx.message(`Removing runtime ${version}.`);
    this.ports.runtimes.remove(version);
    ctx.result({ runtimeVersion: version });
    return { runtimeVersion: version };
  }

  private rejectUnsupportedRuntimePeers(spaceId: string, version: string): void {
    const profileDir = join(this.ports.home, "profiles", spaceId);
    let unmet: string[];
    try {
      unmet = [
        ...unmetProfileDshRequirements(profileDir, version),
        ...unmetInstalledThirdPartyDshPeers(profileDir, version),
      ];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new WorkbenchMaintenanceError("workbench/invalid-input", detail);
    }
    if (unmet.length === 0) return;
    throw new WorkbenchMaintenanceError(
      "workbench/invalid-input",
      `These plugins do not support DSH ${version}: ${unmet.join(", ")}. Remove or upgrade them first.`,
    );
  }

  private pinnedDshVersionOf(spaceId: string): string | undefined {
    return this.ports.registry.scan().find((row) => row.name === spaceId)?.meta.dshVersion;
  }

  private pinnedSpacesOf(version: string): string[] {
    return this.ports.registry
      .scan()
      .filter((row) => row.meta.dshVersion === version)
      .map((row) => row.name)
      .sort();
  }

  private runtimeBinFor(version: string): string | undefined {
    const host = this.ports.hostRuntime();
    if (host && host.version === version) return host.bin;
    const installed = this.ports.runtimes.installedBin(version);
    if (installed) return installed;
    const legacy = this.ports.runtimes.current();
    if (legacy && legacy.version === version) return legacy.bin;
    return undefined;
  }

  private runtimeRemoveBlockReason(version: string): string | undefined {
    const host = this.ports.hostRuntime();
    if (host && host.version === version) return `DSH ${version} is the host runtime.`;
    const legacy = this.ports.runtimes.current();
    if (legacy && legacy.version === version) return `DSH ${version} is the recorded legacy runtime pointer.`;
    const pinnedBy = this.pinnedSpacesOf(version);
    if (pinnedBy.length) return `DSH ${version} is pinned by ${pinnedBy.join(", ")}.`;
    if (!this.ports.runtimes.installedBin(version)) return `DSH ${version} is not installed in the Spaces runtime store.`;
    return undefined;
  }
}
