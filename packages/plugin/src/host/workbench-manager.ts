import type { Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, remoteMethods, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { WORKBENCH_API_METHODS, type WorkbenchApi } from "../../../../src/shared/workbench";
import type {
  WorkbenchBackup,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchMutationContext,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchSnapshot,
  WorkbenchStartupStatus,
  WorkbenchState,
  WorkbenchView,
} from "../../../../src/shared/workbench";
import type { WorkbenchProductRequest, WorkbenchProductResult } from "../../../../src/shared/workbench-product";
import type { SpaceDetail } from "../../../../src/shared/spaces-control";
import { reportedOrFallback } from "../../../../src/shared/public-reason";
import {
  SPACES_PUBLIC_ERROR,
  WORKBENCH_PUBLIC_ERROR,
  type SpacesRemoteCode,
  type WorkbenchRemoteCode,
} from "./remote-errors";
import type { WorkbenchHostRuntime } from "./runtime";

/**
 * Manager-only WorkbenchApi Remote. Proxies the supervisor over a Node bearer.
 * Browser callers never receive the bearer, disk paths, commands, or launch tokens.
 */
export class WorkbenchManagerHost extends TypertRemoteService implements WorkbenchApi {
  constructor(
    ctx: Context,
    private readonly runtime: WorkbenchHostRuntime,
  ) {
    super(ctx, "workbench");
    registerWorkbenchRemoteMethods(this);
  }

  async state(): Promise<WorkbenchState> {
    return this.guard((api) => api.state());
  }

  async startupStatus(): Promise<WorkbenchStartupStatus> {
    return this.guard((api) => api.startupStatus());
  }

  async detail(spaceId: string): Promise<SpaceDetail> {
    return this.guard((api) => api.detail(spaceId));
  }

  async submit(command: WorkbenchCommand, requestId: string, context: WorkbenchMutationContext): Promise<WorkbenchJob> {
    return this.guard((api) => api.submit(command, requestId, context));
  }

  async job(id: string): Promise<WorkbenchJob> {
    return this.guard((api) => api.job(id));
  }

  async cancel(id: string): Promise<WorkbenchJob> {
    return this.guard((api) => api.cancel(id));
  }

  async view(spaceId: string): Promise<WorkbenchView> {
    return this.guard((api) => api.view(spaceId));
  }

  async preview(request: WorkbenchPlanRequest, context: WorkbenchMutationContext): Promise<WorkbenchPlan> {
    return this.guard((api) => api.preview(request, context));
  }

  async product(request: WorkbenchProductRequest): Promise<WorkbenchProductResult> {
    return this.guard((api) => api.product(request));
  }

  async plugins(query: string): Promise<WorkbenchPlugin[]> {
    return this.guard((api) => api.plugins(query));
  }

  async snapshots(): Promise<WorkbenchSnapshot[]> {
    return this.guard((api) => api.snapshots());
  }

  async snapshot(id: string): Promise<WorkbenchSnapshot> {
    return this.guard((api) => api.snapshot(id));
  }

  async runtimes(): Promise<WorkbenchRuntime[]> {
    return this.guard((api) => api.runtimes());
  }

  async backups(spaceId: string): Promise<WorkbenchBackup[]> {
    return this.guard((api) => api.backups(spaceId));
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
      const reported = error instanceof Error ? error.message : undefined;
      if (code in WORKBENCH_PUBLIC_ERROR) {
        const known = code as WorkbenchRemoteCode;
        throw new RemoteError(known, reportedOrFallback(reported, WORKBENCH_PUBLIC_ERROR[known]), {});
      }
      if (code in SPACES_PUBLIC_ERROR) {
        const known = code as SpacesRemoteCode;
        throw new RemoteError(known, reportedOrFallback(reported, SPACES_PUBLIC_ERROR[known]), {});
      }
      throw new RemoteError(
        "workbench/unavailable",
        reportedOrFallback(reported, WORKBENCH_PUBLIC_ERROR["workbench/unavailable"]),
        {},
      );
    }
  }
}

/**
 * Mark every canonical management method as a Typert Remote.
 *
 * `Remote` records its marker through the standard decorator context, so
 * driving that contract directly records the same marker a `@Remote`
 * decorator would. The registered set is therefore the canonical definition
 * itself, never a second hand-written list, and the recorded markers are
 * verified against it before the service is used.
 */
function registerWorkbenchRemoteMethods(host: WorkbenchManagerHost): void {
  for (const method of WORKBENCH_API_METHODS) {
    const implementation = Reflect.get(host, method);
    if (typeof implementation !== "function") {
      throw new Error(`workbench/unsupported: the manager Remote does not implement ${method}.`);
    }
    const decorator = Remote(method) as unknown as (
      target: unknown,
      context: ClassMethodDecoratorContext,
    ) => void;
    decorator(implementation, {
      kind: "method",
      name: method,
      private: false,
      static: false,
      addInitializer(initializer: () => void) {
        initializer.call(host);
      },
    } as unknown as ClassMethodDecoratorContext);
  }
  const registered = remoteMethods(host).map((row) => row.exportName ?? row.method);
  const expected = WORKBENCH_API_METHODS as readonly string[];
  if (registered.length !== expected.length || expected.some((name, index) => registered[index] !== name)) {
    throw new Error("workbench/unsupported: the manager Remote does not match the canonical API surface.");
  }
}
