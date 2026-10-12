import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GlobalLlmHost, LlmApplyCommand } from "../../../core/application/global-llm-host";
import { LLM_ERROR, LlmConfigError } from "../../../core/domain/llm-connections";
import type { LlmInstanceRecord } from "../../../core/ports/llm-runtime";
import { isLlmWriteMethod, type LlmApiResult } from "../../../shared/llm-api";
import type { WorkbenchJob, WorkbenchSpace } from "../../../shared/workbench";
import { llmCatalogPath } from "../llm-paths";
import type { WorkbenchJobContext, WorkbenchJobStore } from "../workbench-jobs";
import { WorkbenchPublicError } from "./errors";
import type { SupervisorLifecycle } from "./lifecycle";
import { profileHasLlmBridge } from "./profile-probe";

export interface SupervisorLlmHost {
  home: string;
  llmHost: () => GlobalLlmHost;
  jobs: () => WorkbenchJobStore | undefined;
  lifecycle: SupervisorLifecycle;
  managerId: () => string | null;
  llmBridgeArtifact: () => string | undefined;
  unmanaged: Set<string>;
  generations: Map<string, number>;
  llmApplied: Map<string, number>;
  observeChildWork: <T>(action: () => T) => T;
  requireManaged: (spaceId: string) => string;
  stopOwned: (spaceId: string) => Promise<void>;
  startSpace: (spaceId: string, ctx: WorkbenchJobContext) => Promise<WorkbenchJob["result"]>;
  installArtifact: (profileId: string, artifact: string, id: string) => Promise<void>;
  homeProfileNames: () => string[];
  publicStatus: (id: string) => WorkbenchSpace["status"];
  currentServiceEpoch: () => string;
}

export class SupervisorLlm {
  private readonly llmBusy = new Set<string>();

  constructor(private readonly host: SupervisorLlmHost) {}

  async dispatchLlm(body: unknown): Promise<unknown> {
    const method = body && typeof body === "object" ? (body as { method?: unknown }).method : undefined;
    const jobs = this.host.jobs();
    if (method === "applyPlan") {
      if (!jobs) throw new WorkbenchPublicError("workbench/read-only");
      return this.host.llmHost().dispatch(body);
    }
    if (typeof method === "string" && isLlmWriteMethod(method)) {
      if (!jobs) throw new WorkbenchPublicError("workbench/read-only");
      return jobs.runExclusive(async () => {
        this.assertLlmMutationAllowed();
        const result = await this.host.llmHost().dispatch(body);
        await this.maybeInstallLlmBridge(body);
        return result;
      });
    }
    const result = await this.host.llmHost().dispatch(body);
    await this.maybeInstallLlmBridge(body);
    return result;
  }

  async dispatchLlmCredential(body: unknown): Promise<unknown> {
    const jobs = this.host.jobs();
    if (!jobs) throw new WorkbenchPublicError("workbench/read-only");
    return jobs.runExclusive(async () => {
      this.assertLlmMutationAllowed();
      return this.host.llmHost().dispatchCredential(body);
    });
  }

  private assertLlmMutationAllowed(): void {
    this.host.lifecycle.assertWritable();
    if (this.host.lifecycle.sealing) {
      throw new WorkbenchPublicError("workbench/unavailable", "The supervisor is releasing run rights.");
    }
    if (!this.host.jobs()) throw new WorkbenchPublicError("workbench/read-only");
  }

  async dispatchLlmAdmitted(body: unknown): Promise<LlmApiResult> {
    const jobs = this.host.jobs();
    if (!jobs) throw new WorkbenchPublicError("workbench/read-only");
    return jobs.runAdmitted(async () => {
      const method = body && typeof body === "object" ? (body as { method?: unknown }).method : undefined;
      if (typeof method === "string" && isLlmWriteMethod(method)) {
        this.assertLlmMutationAllowed();
      }
      const result = await this.host.llmHost().dispatch(body);
      await this.maybeInstallLlmBridge(body);
      return result as LlmApiResult;
    });
  }

  llmCatalogObservation(): { revision: number; digest: string } {
    const path = llmCatalogPath(this.host.home);
    let digest = createHash("sha256").update("").digest("hex");
    let revision = 0;
    try {
      const bytes = readFileSync(path);
      digest = createHash("sha256").update(bytes).digest("hex");
      const parsed = JSON.parse(bytes.toString("utf8")) as { revision?: unknown };
      if (typeof parsed.revision === "number" && Number.isInteger(parsed.revision) && parsed.revision >= 0) {
        revision = parsed.revision;
      }
    } catch {
      /* missing catalog is an empty observation */
    }
    return { revision, digest };
  }

  private async maybeInstallLlmBridge(body: unknown): Promise<void> {
    const request = body as { method?: string; spaceId?: string; shared?: { mode?: string } };
    if (
      typeof request.spaceId === "string" &&
      (request.method === "mapImported" ||
        (request.method === "updateSpacePolicy" && request.shared?.mode && request.shared.mode !== "none"))
    ) {
      await this.ensureLlmBridge(request.spaceId);
    }
  }

  assertLlmWritable(): void {
    if (!this.host.lifecycle.handle) {
      throw new LlmConfigError(LLM_ERROR.WRITE_OWNER_REQUIRED, "Home write owner is required for this change");
    }
    if (this.host.lifecycle.maintenanceBlocked) {
      throw new WorkbenchPublicError("workbench/unavailable", "Stop failed; new maintenance is refused.");
    }
    if (this.host.lifecycle.sealing && !this.host.lifecycle.relinquishKind) throw new WorkbenchPublicError("workbench/unavailable");
  }

  async submitLlmApply(command: LlmApplyCommand, requestId: string): Promise<WorkbenchJob> {
    this.assertLlmMutationAllowed();
    const jobs = this.host.jobs();
    if (!jobs) throw new WorkbenchPublicError("workbench/read-only");
    return jobs.submit(command, requestId, (ctx) =>
      this.host.observeChildWork(() => this.runLlmApply(command, ctx)),
    );
  }

  async runLlmApply(command: LlmApplyCommand, ctx: WorkbenchJobContext): Promise<void> {
    this.assertLlmMutationAllowed();
    ctx.phase("apply");
    await this.host.llmHost().executeApply(command, async (spaceId) => {
      ctx.message(`restart ${spaceId}`);
      const id = this.host.requireManaged(spaceId);
      await this.host.stopOwned(id);
      await this.host.startSpace(id, ctx);
    });
  }

  listLlmInstances(): LlmInstanceRecord[] {
    return this.host.homeProfileNames().map((id) => {
      const leftover = this.host.unmanaged.has(id);
      const status = leftover ? "unknown" : this.host.publicStatus(id);
      return {
        spaceId: id,
        status,
        generation: this.host.generations.get(id) ?? 0,
        catalogRevision: this.host.llmApplied.get(id) ?? null,
        policyRevision: null,
        busy: this.llmBusy.has(id),
        serviceEpoch: this.host.currentServiceEpoch(),
      };
    });
  }

  async ensureLlmBridge(profileId: string): Promise<void> {
    const artifact = this.host.llmBridgeArtifact();
    if (!artifact) return;
    if (profileId === "web" || profileId === this.host.managerId()) return;
    if (profileHasLlmBridge(this.host.home, profileId)) return;
    await this.host.installArtifact(profileId, artifact, "dsh-spaces-llm-bridge");
  }
}
