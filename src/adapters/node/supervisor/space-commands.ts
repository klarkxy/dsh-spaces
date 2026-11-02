import type { SpaceBaseCreation } from './base-creation';
import { SPACES_BROWSER_SEALED } from '../../../shared/browser-sealed';
import type { GlobalLlmHost } from "../../../core/application/global-llm-host";
import type { WorkbenchCommand, WorkbenchJob } from "../../../shared/workbench";
import type { HomeOperationLock } from "../home/home-operation-lock";
import { FileLlmPolicyStore } from "../llm/llm-policy-store";
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
  llmHost: () => GlobalLlmHost;
  requireSpace: (spaceId: string) => string;
  protectSpecial: (id: string, options: { allowManager: boolean }) => void;
  ensureViewBridge: (profileId: string) => Promise<void>;
  ensureLlmBridge: (profileId: string) => Promise<void>;
  hasComponent: (component: SpacesComponent) => boolean;
}

/**
 * Space create/update/reorder commands. The registry is the single writer for
 * space metadata; every mutation runs inside the Home operation lock.
 */
export class SupervisorSpaceCommands {
  constructor(private readonly host: SupervisorSpaceCommandsHost) {}

  async createSpace(
    input: { name: string; displayName?: string; icon?: string; useSharedLlm?: boolean; modelSource?: 'main'|'shared'|'local'; browser?: boolean; base?: 'web'|'browser'; baseVersion?: string },
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchJob["result"]> {
    ctx.phase("create");
    ctx.cancellable(false);
    const name = parseSpaceUserName(input.name);
    const base = input.base ?? (input.browser ? 'browser' : 'web');
    if (SPACES_BROWSER_SEALED && base === 'browser') throw new WorkbenchPublicError('workbench/unsupported');
    if (input.base && input.browser !== undefined && input.browser !== (input.base === 'browser')) throw new WorkbenchPublicError('workbench/invalid-input');
    if (base === 'browser' && (input.modelSource || input.useSharedLlm === true)) throw new WorkbenchPublicError('workbench/invalid-input');
    if (base === 'browser' && (!this.host.hasComponent('browser') || !this.host.hasComponent('view-bridge'))) {
      throw new WorkbenchPublicError("workbench/unavailable", "The bundled Browser or its view bridge is unavailable.");
    }
    let spaceId = "";
    await this.host.lock.run("space.create", async () => {
      const recipe = await this.host.bases.prepare(base, input.baseVersion);
      const spaces = this.host.spaces();
      if (spaces) {
        spaceId = (await spaces.create({ name, displayName: input.displayName }, recipe)).id;
      } else {
        throw new WorkbenchPublicError("workbench/unavailable");
      }
      if (input.icon !== undefined) {
        this.host.registry.updateMeta(spaceId, { icon: parseIcon(input.icon) });
      }
      if (base === 'web' && this.host.hasComponent('view-bridge')) {
        await this.host.ensureViewBridge(spaceId);
      }

    });
    // Spaces inherit shared connections by default; only an explicit choice is persisted.
    // Blueprint/template callers omit the flag so their own policy write keeps revision 0.
    if (base === 'web' && input.modelSource==='main') {
      await new FileLlmPolicyStore(this.host.home).write(spaceId,{schemaVersion:2,revision:1,shared:{mode:'none'},inheritMain:true},0);
      await this.host.ensureLlmBridge(spaceId);
    } else if (base === 'web' && (input.useSharedLlm !== undefined || input.modelSource!==undefined)) {
      ctx.phase("llm-policy");
      await this.host.llmHost().dispatch({
        method: "updateSpacePolicy",
        spaceId,
        shared: input.modelSource==='shared'||input.useSharedLlm ? { mode: "all" } : { mode: "none" },
        expectedRevision: 0,
      });
      if (input.modelSource==='shared'||input.useSharedLlm) await this.host.ensureLlmBridge(spaceId);
    }
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
      const patch: { displayName?: string; icon?: string } = {};
      if (command.displayName !== undefined) patch.displayName = command.displayName;
      if (command.icon !== undefined) patch.icon = parseIcon(command.icon);
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
