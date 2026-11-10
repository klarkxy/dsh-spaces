import { assertBrowserRelease, profileBase } from '../profile/space-base';
import { SPACES_BROWSER_SEALED } from '../../../shared/browser-sealed';
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { lt as semverLt } from "semver";
import { SPACES_MIN_DSH_VERSION } from "../../../shared/runtime";
import type { ProfileStatus } from "../../../shared/types";
import type { WorkbenchJob, WorkbenchView } from "../../../shared/workbench";
import type { HomeOperationLock } from "../home/home-operation-lock";
import type { WorkbenchJobContext } from "../maintenance/workbench-jobs";
import { cliLoadError, unmetProfileDshRequirements } from "../payload/component-cli";
import type { SpacesComponent } from "../payload/dev-checkout";
import { alignProfileComponents } from "../profile/profile-component-alignment";
import type { ProcessManager } from "../runtime/process-manager";
import { STOP_KEPT_REASON, STOP_NOT_FORCED, WorkbenchPublicError } from "./errors";
import type { SupervisorInstanceRecords } from "./instance-records";
import type { SupervisorLifecycle } from "./lifecycle";
import type { SpaceRunRegistry } from "./space-runs";
import type { WorkbenchSupervisorOptions } from "./types";

export interface SupervisorSpaceLifecycleHost {
  home: string;
  origin: () => string;
  managerId: () => string | null;
  lifecycle: SupervisorLifecycle;
  runs: SpaceRunRegistry;
  instances: () => SupervisorInstanceRecords;
  processes: () => ProcessManager | undefined;
  options: WorkbenchSupervisorOptions;
  lock: HomeOperationLock;
  statusOf: (name: string) => ProfileStatus;
  requireSpace: (spaceId: string) => string;
  view: (spaceId: string) => Promise<WorkbenchView>;
  requireServiceEpoch: () => string;
  ensureViewBridge: (profileId: string) => Promise<void>;
  ensureBundledDeps: (profileId: string) => Promise<void>;
  installComponent: (profileId: string, component: SpacesComponent) => Promise<void>;
  removePlugin: (profileId: string, packageName: string) => Promise<void>;
  componentAligned: (profileId: string, component: SpacesComponent) => boolean;
  readDump: (profile: string) => Promise<string | undefined>;
  pinnedDshVersion: (spaceId: string) => string | undefined;
  resolveSpaceRuntime: (spaceId: string) => { bin: string; version: string };
}

/**
 * Start/stop orchestration for spaces this supervisor owns. The owned set is
 * the run registry; an unmanaged leftover is never adopted or stopped here.
 */
export class SupervisorSpaceLifecycle {
  constructor(private readonly host: SupervisorSpaceLifecycleHost) {}

  async startSpace(spaceId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"]> {
    ctx.phase("start");
    ctx.cancellable(true);
    const id = this.host.requireSpace(spaceId);
    if (id === this.host.managerId() && this.host.lifecycle.managerStartFailure) {
      throw new WorkbenchPublicError("workbench/unavailable", this.host.lifecycle.managerStartFailure);
    }
    if (id === "web" || id === "desktop") throw new WorkbenchPublicError("workbench/protected");
    if (this.host.runs.unmanaged.has(id)) throw new WorkbenchPublicError("workbench/unmanaged");
    if (this.host.statusOf(id) === "running") {
      if (!this.host.runs.views.has(id)) throw new WorkbenchPublicError("workbench/unavailable");
      return { spaceId: id, view: await this.host.view(id) };
    }
    if (SPACES_BROWSER_SEALED && profileBase(this.host.home, id) === 'browser') throw new WorkbenchPublicError('workbench/unsupported');
    if (id !== this.host.managerId()) await this.host.ensureViewBridge(id);
    const gen = this.host.runs.nextGeneration(id);
    const channel = randomBytes(8).toString("hex");
    const epoch = this.host.requireServiceEpoch();
    this.host.runs.views.set(id, {
      spaceId: id,
      generation: gen,
      origin: this.host.origin(),
      channel,
      serviceEpoch: epoch,
      issued: false,
    });
    await this.startOwned(id);
    if (this.host.lifecycle.maintenanceBlocked) throw new WorkbenchPublicError("workbench/unavailable");
    const port = this.host.processes()?.portOf(id);
    if (!port) throw new WorkbenchPublicError("workbench/failed");
    const childOrigin = `http://127.0.0.1:${port}`;
    const current = this.host.runs.views.get(id);
    if (!current || current.generation !== gen) {
      throw new WorkbenchPublicError("workbench/failed");
    }
    current.origin = childOrigin;
    if (id !== this.host.managerId()) this.host.runs.workspaceOrigins.add(childOrigin);
    this.host.instances().writeInstanceRecord(id, port, gen);
    return {
      spaceId: id,
      view: {
        serviceEpoch: epoch,
        spaceId: id,
        generation: gen,
        origin: childOrigin,
        entryOrigin: this.host.origin(),
        entryPath: `/view/${encodeURIComponent(id)}/${gen}`,
        channel,
      },
    };
  }

  async startOwned(spaceId: string): Promise<void> {
    this.host.lifecycle.assertWritable();
    if (!this.host.processes()) throw new WorkbenchPublicError("workbench/read-only");
    if (this.host.runs.unmanaged.has(spaceId)) throw new WorkbenchPublicError("workbench/unmanaged");
    if (spaceId === "web") throw new WorkbenchPublicError("workbench/protected");
    const pinned = spaceId === this.host.managerId() ? undefined : this.host.pinnedDshVersion(spaceId);
    if (pinned && semverLt(pinned, SPACES_MIN_DSH_VERSION)) {
      throw new WorkbenchPublicError(
        "workbench/incompatible",
        `This space uses DSH ${pinned}, below the minimum ${SPACES_MIN_DSH_VERSION} supported by this Spaces version. Upgrade it in the space settings.`,
      );
    }
    const spaceRuntime = this.host.resolveSpaceRuntime(spaceId);
    if (profileBase(this.host.home, spaceId) === 'browser') {
      if (SPACES_BROWSER_SEALED) throw new WorkbenchPublicError('workbench/unsupported');
      assertBrowserRelease(this.host.home, spaceId, spaceRuntime.version);
      const incompatible = unmetProfileDshRequirements(join(this.host.home, 'profiles', spaceId), spaceRuntime.version);
      if (incompatible.length) throw new WorkbenchPublicError('workbench/incompatible', cliLoadError(spaceRuntime.version, incompatible));
    } else if (this.host.options.componentPayloadRoot) {
      if (!["stopped", "crashed"].includes(this.host.statusOf(spaceId))) throw new WorkbenchPublicError("workbench/conflict");
      await this.host.lock.run("space.components-align", async () => {
        // Bundled dependencies become profile-level bundle entries; they must
        // exist before alignment reads the profile's bundle membership.
        await this.host.ensureBundledDeps(spaceId);
        return alignProfileComponents({
          home: this.host.home, profileId: spaceId, payloadRoot: this.host.options.componentPayloadRoot!,
          bin: spaceRuntime.bin, cliVersion: spaceRuntime.version,
          install: (bridge) => this.host.installComponent(spaceId, bridge),
          remove: (packageName) => this.host.removePlugin(spaceId, packageName),
          // A linked checkout matches by link identity; packaged installs keep byte comparison.
          ...(this.host.options.devCheckoutRoot !== undefined
            ? { matches: (component: SpacesComponent) => this.host.componentAligned(spaceId, component) }
            : {}),
          dump: async () => {
            const dump = await this.host.readDump(spaceId);
            if (!dump) throw new Error("Could not inspect profile configuration.");
            return dump;
          },
        });
      });
    } else {
      const cliBlock = unmetProfileDshRequirements(join(this.host.home, "profiles", spaceId), spaceRuntime.version);
      if (cliBlock.length) {
        throw new WorkbenchPublicError("workbench/incompatible", cliLoadError(spaceRuntime.version, cliBlock));
      }
    }
    await this.host.processes()!.start(spaceId);
  }

  async stopOwned(spaceId: string): Promise<void> {
    if (!this.host.processes()) return;
    if (this.host.runs.unmanaged.has(spaceId)) return;
    await this.host.processes()!.stop(spaceId);
    this.host.runs.nextGeneration(spaceId);
    this.host.runs.views.delete(spaceId);
    this.host.instances().removeInstanceRecord(spaceId);
  }

  async stopOwnedAll(): Promise<void> {
    if (!this.host.processes()) return;
    const names = [...new Set([...this.host.runs.spawned.keys(), ...this.host.runs.views.keys()])]
      .filter((id) => !this.host.runs.unmanaged.has(id));
    for (const name of names) {
      try {
        await this.stopOwned(name);
      } catch (error) {
        if (!this.host.lifecycle.reasons.some((row) => row.includes("could not be stopped"))) {
          this.host.lifecycle.reasons.push(STOP_KEPT_REASON);
        }
        throw error instanceof Error ? error : new Error(STOP_NOT_FORCED);
      }
    }
  }
}
