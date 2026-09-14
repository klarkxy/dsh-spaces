import type { Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type {
  WorkbenchBootstrapResult,
  WorkbenchGuideRole,
  WorkbenchInitializeResult,
  WorkbenchReturnTarget,
} from "../types";
import { WORKBENCH_PUBLIC_ERROR } from "./remote-errors";
import type { WorkbenchHostRuntime } from "./runtime";

/** Read-only bootstrap / return-to-workbench Remote. Registered for every profile. */
export class WorkbenchGuideHost extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly runtime: WorkbenchHostRuntime,
  ) {
    super(ctx, "workbenchGuide");
  }

  @Remote("role")
  async role(): Promise<WorkbenchGuideRole> {
    return this.runtime.guideRole();
  }

  @Remote("bootstrap")
  async bootstrap(): Promise<WorkbenchBootstrapResult> {
    try {
      return await this.runtime.bootstrap();
    } catch {
      throw new RemoteError("workbench/unavailable", WORKBENCH_PUBLIC_ERROR["workbench/unavailable"], {});
    }
  }

  @Remote("returnTarget")
  async returnTarget(): Promise<WorkbenchReturnTarget> {
    try {
      return await this.runtime.returnTarget();
    } catch {
      throw new RemoteError("workbench/unavailable", WORKBENCH_PUBLIC_ERROR["workbench/unavailable"], {});
    }
  }

  @Remote("initialize")
  async initialize(): Promise<WorkbenchInitializeResult> {
    try {
      return await this.runtime.initialize();
    } catch {
      throw new RemoteError("workbench/unavailable", WORKBENCH_PUBLIC_ERROR["workbench/unavailable"], {});
    }
  }
}
