import type { GlobalLlmHost } from "../../../core/application/global-llm-host";
import type { WorkbenchCommand, WorkbenchJob } from "../../../shared/workbench";
import type { HomeOperationLock } from "../home/home-operation-lock";
import { FileLlmPolicyStore } from "../llm/llm-policy-store";
import type { WorkbenchJobContext } from "../maintenance/workbench-jobs";
import type { ProfileRegistry } from "../profile/profile-registry";
import type { NodeSpacesService } from "../products/spaces-service";
import { WorkbenchPublicError } from "./errors";
import { parseIcon, parseSpaceUserName } from "./input";
import type { BoundCli, WorkbenchSupervisorOptions } from "./types";

export interface SupervisorSpaceCommandsHost {
  home: string;
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
  installArtifact: (profileId: string, artifact: string, id: string) => Promise<void>;
  artifactDigest: (artifact: string) => string;
}

/**
 * Space create/update/reorder commands. The registry is the single writer for
 * space metadata; every mutation runs inside the Home operation lock.
 */
export class SupervisorSpaceCommands {
  constructor(private readonly host: SupervisorSpaceCommandsHost) {}

  async createSpace(
    input: { name: string; displayName?: string; icon?: string; useSharedLlm?: boolean; modelSource?: 'main'|'shared'|'local'; browser?: boolean },
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchJob["result"]> {
    ctx.phase("create");
    ctx.cancellable(false);
    const name = parseSpaceUserName(input.name);
    if (input.browser && (!this.host.options.browserArtifact || !this.host.options.viewBridgeArtifact)) {
      throw new WorkbenchPublicError("workbench/unavailable", "The bundled Browser or its view bridge is unavailable.");
    }
    let spaceId = "";
    await this.host.lock.run("space.create", async () => {
      const spaces = this.host.spaces();
      if (spaces) {
        spaceId = (await spaces.create({ name, displayName: input.displayName })).id;
      } else {
        throw new WorkbenchPublicError("workbench/unavailable");
      }
      const cli = this.host.cli();
      if (cli) this.host.registry.updateMeta(spaceId, { dshVersion: cli.version });
      if (input.icon !== undefined) {
        this.host.registry.updateMeta(spaceId, { icon: parseIcon(input.icon) });
      }
      if (this.host.options.viewBridgeArtifact) {
        await this.host.ensureViewBridge(spaceId);
      }
      if (input.browser) {
        await this.host.installArtifact(spaceId, this.host.options.browserArtifact!, `dsh-spaces-browser-${this.host.artifactDigest(this.host.options.browserArtifact!)}`);
      }
    });
    // Spaces inherit shared connections by default; only an explicit choice is persisted.
    // Blueprint/template callers omit the flag so their own policy write keeps revision 0.
    if (!input.browser && input.modelSource==='main') {
      await new FileLlmPolicyStore(this.host.home).write(spaceId,{schemaVersion:2,revision:1,shared:{mode:'none'},inheritMain:true},0);
      await this.host.ensureLlmBridge(spaceId);
    } else if (input.useSharedLlm !== undefined || input.modelSource!==undefined) {
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
