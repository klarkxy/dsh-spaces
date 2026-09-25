import { parseSpaceHostAudience, type SpaceHostAudience } from "../../../../src/shared/space-host";
import type { Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type {
  WorkbenchBootstrapResult,
  WorkbenchGuideRole,
  WorkbenchInitializeResult,
  WorkbenchReturnTarget,
} from "../types";
import { reportedOrFallback } from "../../../../src/shared/public-reason";
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
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError(
        "workbench/unavailable",
        reportedOrFallback(error instanceof Error ? error.message : undefined, WORKBENCH_PUBLIC_ERROR["workbench/unavailable"]),
        {},
      );
    }
  }

  @Remote("returnTarget")
  async returnTarget(): Promise<WorkbenchReturnTarget> {
    try {
      return await this.runtime.returnTarget();
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError(
        "workbench/unavailable",
        reportedOrFallback(error instanceof Error ? error.message : undefined, WORKBENCH_PUBLIC_ERROR["workbench/unavailable"]),
        {},
      );
    }
  }

  @Remote("portalTarget")
  async portalTarget(audience: SpaceHostAudience): Promise<WorkbenchReturnTarget> {
    if (!parseSpaceHostAudience(audience)) throw new RemoteError("workbench/unsupported", "This host needs a compatible presentation adapter.", {});
    try { return await this.runtime.portalTarget(audience); }
    catch { throw new RemoteError("workbench/unavailable", "The in-app workbench entry could not be opened.", {}); }
  }

  @Remote("initialize")
  async initialize(): Promise<WorkbenchInitializeResult> {
    try {
      return await this.runtime.initialize();
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError(
        "workbench/unavailable",
        reportedOrFallback(error instanceof Error ? error.message : undefined, WORKBENCH_PUBLIC_ERROR["workbench/unavailable"]),
        {},
      );
    }
  }
}
