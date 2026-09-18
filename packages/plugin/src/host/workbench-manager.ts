import type { Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type {
  WorkbenchBackup,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchPackageRelease,
  WorkbenchSnapshot,
  WorkbenchState,
  WorkbenchView,
} from "../../../../src/shared/workbench";
import type { SpaceDetail } from "../../../../src/shared/spaces-control";
import { LLM_PUBLIC_ERROR, WORKBENCH_PUBLIC_ERROR, type LlmRemoteCode, type WorkbenchRemoteCode } from "./remote-errors";
import type { LlmApiRequest, LlmApiResult, LlmCredentialRequest } from "../../../../src/shared/llm-api";
import type { WorkbenchHostRuntime } from "./runtime";

/**
 * Manager-only WorkbenchApi Remote. Proxies the supervisor over a Node bearer.
 * Browser callers never receive the bearer, disk paths, commands, or launch tokens.
 */
export class WorkbenchManagerHost extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly runtime: WorkbenchHostRuntime,
  ) {
    super(ctx, "workbench");
  }

  @Remote("state")
  async state(): Promise<WorkbenchState> {
    return this.guard((api) => api.state());
  }

  @Remote("detail")
  async detail(spaceId: string): Promise<SpaceDetail> {
    return this.guard((api) => api.detail(spaceId));
  }

  @Remote("submit")
  async submit(command: WorkbenchCommand, requestId: string): Promise<WorkbenchJob> {
    return this.guard((api) => api.submit(command, requestId));
  }

  @Remote("job")
  async job(id: string): Promise<WorkbenchJob> {
    return this.guard((api) => api.job(id));
  }

  @Remote("cancel")
  async cancel(id: string): Promise<WorkbenchJob> {
    return this.guard((api) => api.cancel(id));
  }

  @Remote("view")
  async view(spaceId: string): Promise<WorkbenchView> {
    return this.guard((api) => api.view(spaceId));
  }

  @Remote("preview")
  async preview(request: WorkbenchPlanRequest): Promise<WorkbenchPlan> {
    return this.guard((api) => api.preview(request));
  }

  @Remote("plugins")
  async plugins(query: string): Promise<WorkbenchPlugin[]> {
    return this.guard((api) => api.plugins(query));
  }

  @Remote("snapshots")
  async snapshots(): Promise<WorkbenchSnapshot[]> {
    return this.guard((api) => api.snapshots());
  }

  @Remote("snapshot")
  async snapshot(id: string): Promise<WorkbenchSnapshot> {
    return this.guard((api) => api.snapshot(id));
  }

  @Remote("runtimes")
  async runtimes(): Promise<WorkbenchRuntime[]> {
    return this.guard((api) => api.runtimes());
  }

  @Remote("backups")
  async backups(spaceId: string): Promise<WorkbenchBackup[]> {
    return this.guard((api) => api.backups(spaceId));
  }

  @Remote("workbenchPackage")
  async workbenchPackage(): Promise<WorkbenchPackageRelease | null> {
    return this.guard((api) => api.workbenchPackage?.() ?? Promise.resolve(null));
  }

  @Remote("llm")
  async llm(request: LlmApiRequest): Promise<LlmApiResult> {
    return this.guard((api) => {
      if (!api.llm) throw new Error("workbench/unsupported");
      return api.llm(request);
    });
  }

  @Remote("llmCredential")
  async llmCredential(request: LlmCredentialRequest): Promise<LlmApiResult> {
    return this.guard((api) => {
      if (!api.llmCredential) throw new Error("workbench/unsupported");
      return api.llmCredential(request);
    });
  }

  private async guard<T>(action: (api: Awaited<ReturnType<WorkbenchHostRuntime["managerApi"]>>) => Promise<T>): Promise<T> {
    try {
      const api = await this.runtime.managerApi();
      return await action(api);
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      const code = error instanceof Error && (error.message.startsWith("workbench/") || error.message.startsWith("LLM_"))
        ? error.message
        : "";
      if (code in WORKBENCH_PUBLIC_ERROR) {
        throw new RemoteError(code as WorkbenchRemoteCode, WORKBENCH_PUBLIC_ERROR[code as WorkbenchRemoteCode], {});
      }
      if (code in LLM_PUBLIC_ERROR) {
        throw new RemoteError(code as LlmRemoteCode, LLM_PUBLIC_ERROR[code as LlmRemoteCode], {});
      }
      throw new RemoteError("workbench/unavailable", WORKBENCH_PUBLIC_ERROR["workbench/unavailable"], {});
    }
  }
}
