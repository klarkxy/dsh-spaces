import { parseSpaceHostAudience, type SpaceHostAudience } from "../../../../src/shared/space-host";
import type { Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type {
  WorkbenchBootstrapResult,
  WorkbenchGuideRole,
  WorkbenchInitializeResult,
  WorkbenchReturnTarget,
  WorkbenchServiceRestartPreview,
} from "../types";
import { reportedOrFallback } from "../../../../src/shared/public-reason";
import { WORKBENCH_PUBLIC_ERROR } from "./remote-errors";
import type { WorkbenchHostRuntime } from "./runtime";

/** Presentation and launch Remote; manual service restart is restricted to the confirmed Desktop. */
export class WorkbenchGuideHost extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly runtime: WorkbenchHostRuntime,
  ) {
    super(ctx, "workbenchGuide");
  }

  @Remote("previewServiceRestart")
  async previewServiceRestart(): Promise<WorkbenchServiceRestartPreview> {
    try { return await this.runtime.previewServiceRestart(); }
    catch (error) { throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The restart preview is unavailable."), {}); }
  }

  @Remote("restartService")
  async restartService(confirmationId: string): Promise<WorkbenchBootstrapResult> {
    if (typeof confirmationId !== "string" || !/^[a-f0-9]{64}$/.test(confirmationId)) throw new RemoteError("workbench/invalid-input", "A valid restart confirmation is required.", {});
    try { return await this.runtime.restartService(confirmationId); }
    catch (error) { throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The manual service restart failed."), {}); }
  }

  @Remote("role")
  async role(): Promise<WorkbenchGuideRole> {
    return this.runtime.guideRole();
  }

  @Remote("presentationSnapshot")
  async presentationSnapshot(): Promise<import("../../../../src/shared/space-host").PortalSnapshot> {
    try { return await this.runtime.presentationSnapshot(); }
    catch (error) { throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The space directory is unavailable."), {}); }
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
    catch (error) { throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The in-app workbench entry could not be opened."), {}); }
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
