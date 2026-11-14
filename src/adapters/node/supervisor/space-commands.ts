import type { SpaceBaseCreation } from './base-creation';
import { SPACES_BROWSER_SEALED } from '../../../shared/browser-sealed';
import type { WorkbenchCommand, WorkbenchJob } from "../../../shared/workbench";
import type { HomeOperationLock } from "../home/home-operation-lock";
import type { ModelSyncSummary } from "../llm/main-model-sync";
import type { WorkbenchJobContext } from "../maintenance/workbench-jobs";
import type { ProfileRegistry } from "../profile/profile-registry";
import type { NodeSpacesService } from "../products/spaces-service";
import { WorkbenchPublicError } from "./errors";
import { parseIcon, parseSpaceUserName } from "./input";
import type { SpacesComponent } from "../payload/dev-checkout";
import type { BoundCli, WorkbenchSupervisorOptions } from "./types";

export interface SupervisorSpaceCommandsHost {
  home: string;
  bases: SpaceBaseCreation;
  lock: HomeOperationLock;
  registry: ProfileRegistry;
  options: WorkbenchSupervisorOptions;
  cli: () => BoundCli | null;
  spaces: () => NodeSpacesService | undefined;
  requireSpace: (spaceId: string) => string;
  protectSpecial: (id: string, options: { allowManager: boolean }) => void;
  ensureViewBridge: (profileId: string) => Promise<void>;
  /** Verified main profile of this epoch; throws when the main space is not connected. */
  mainProfile: () => string;
  /** One copy of the main space's models into the (not yet started) space. */
  syncMainModels: (spaceId: string) => Promise<ModelSyncSummary>;
  hasComponent: (component: SpacesComponent) => boolean;
}

/**
 * Space create/update/reorder commands. The registry is the single writer for
 * space metadata; every mutation runs inside the Home operation lock.
 */
export class SupervisorSpaceCommands {
  constructor(private readonly host: SupervisorSpaceCommandsHost) {}

  async createSpace(
    input: { name: string; displayName?: string; icon?: string; modelSource?: 'main'|'local'; browser?: boolean; base?: 'web'|'browser'; baseVersion?: string },
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchJob["result"]> {
    ctx.phase("prepare");
    ctx.cancellable(false);
    const name = parseSpaceUserName(input.name);
    const base = input.base ?? (input.browser ? 'browser' : 'web');
    if (SPACES_BROWSER_SEALED && base === 'browser') throw new WorkbenchPublicError('workbench/unsupported');
    if (input.base && input.browser !== undefined && input.browser !== (input.base === 'browser')) throw new WorkbenchPublicError('workbench/invalid-input');
    if (base === 'browser' && input.modelSource) throw new WorkbenchPublicError('workbench/invalid-input');
    // Component availability is checked before any space exists so a missing
    // component source fails during prepare instead of leaving a registered,
    // partially built profile. In a linked checkout an unusable component
    // directory is a named failure, not "component absent".
    const viewBridge = base === 'web' && this.host.hasComponent('view-bridge');
    // Following the main space needs its verified identity; refuse before any space exists.
    if (base === 'web' && input.modelSource === 'main') this.host.mainProfile();
    if (base === 'browser' && (!this.host.hasComponent('browser') || !this.host.hasComponent('view-bridge'))) {
      throw new WorkbenchPublicError("workbench/unavailable", "The bundled Browser or its view bridge is unavailable.");
    }
    let spaceId = "";
    await this.host.lock.run("space.create", async () => {
      let installing = false;
      const recipe = await this.host.bases.prepare(base, input.baseVersion, (version) => {
        installing = true;
        ctx.phase("install");
        ctx.message(`DSH ${version}`);
      });
      ctx.phase("create");
      if (installing) ctx.message("");
      const spaces = this.host.spaces();
      if (spaces) {
        spaceId = (await spaces.create({ name, displayName: input.displayName }, recipe)).id;
      } else {
        throw new WorkbenchPublicError("workbench/unavailable");
      }
      if (input.icon !== undefined) {
        this.host.registry.updateMeta(spaceId, { icon: parseIcon(input.icon) });
      }
      if (base === 'web' && viewBridge) {
        ctx.phase("view-bridge");
        await this.host.ensureViewBridge(spaceId);
      }
      // "Use the main space's models" is one copy at creation time. A failure
      // leaves the created space as it is and fails this job.
      if (base === 'web' && input.modelSource === 'main') {
        ctx.phase("models-sync");
        await this.host.syncMainModels(spaceId);
      }
    });
    return { spaceId };
  }

  async updateSpace(
    command: Extract<WorkbenchCommand, { kind: "space.update" }>,
    ctx: WorkbenchJobContext,
  ): Promise<void> {
    ctx.phase("update");
    const id = this.host.requireSpace(command.spaceId);
    this.host.protectSpecial(id, { allowManager: true });
    await this.host.lock.run("space.update", async () => {
      const patch: { displayName?: string; icon?: string; startWithDesktop?: boolean } = {};
      if (command.displayName !== undefined) patch.displayName = command.displayName;
      if (command.icon !== undefined) patch.icon = parseIcon(command.icon);
      if (command.startWithDesktop !== undefined) patch.startWithDesktop = command.startWithDesktop;
      this.host.registry.updateMeta(id, patch);
    });
  }

  async reorderSpaces(spaceIds: string[], ctx: WorkbenchJobContext): Promise<void> {
    ctx.phase("reorder");
    for (const id of spaceIds) this.host.requireSpace(id);
    await this.host.lock.run("space.reorder", async () => {
      this.host.registry.reorder(spaceIds);
    });
  }
}
