import { parseSpaceHostAudience, type SpaceHostAudience } from "../../../../src/shared/space-host";
import type { Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type {
  ClientFailureReport,
  DesktopLaunchState,
  WorkbenchBootstrapResult,
  WorkbenchGuideRole,
  WorkbenchInitializeResult,
  WorkbenchReturnTarget,
  WorkbenchServiceRestartPreview,
} from "../types";
import { reportedOrFallback } from "../../../../src/shared/public-reason";
import { WORKBENCH_PUBLIC_ERROR } from "./remote-errors";
import type { WorkbenchHostRuntime } from "./runtime";
import { validClientFailureReport, validDesktopSpaceAction, type DesktopSpaceAction } from "../types";

/** Presentation and launch Remote; manual service restart is restricted to the confirmed Desktop. */
export class WorkbenchGuideHost extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly runtime: WorkbenchHostRuntime,
  ) {
    super(ctx, "workbenchGuide");
  }

  /** Local diagnostic record of a failed guide call; it never changes the thrown result. */
  private logFailure(method: string, error: unknown): void {
    try {
      this.runtime.diagnosticLogger()?.error("host.guide-failed", "A Spaces guide request failed.", error, { method });
    } catch {
      /* Diagnostic logging never changes the thrown result. */
    }
  }

  @Remote("previewServiceRestart")
  async previewServiceRestart(): Promise<WorkbenchServiceRestartPreview> {
    try { return await this.runtime.previewServiceRestart(); }
    catch (error) { this.logFailure("previewServiceRestart", error); throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The restart preview is unavailable."), {}); }
  }

  @Remote("previewServiceStop")
  async previewServiceStop(): Promise<WorkbenchServiceRestartPreview> {
    try { return await this.runtime.previewServiceStop(); }
    catch (error) { this.logFailure("previewServiceStop", error); throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The stop preview is unavailable."), {}); }
  }

  @Remote("stopService")
  async stopService(confirmationId: string): Promise<WorkbenchBootstrapResult> {
    if (typeof confirmationId !== "string" || !/^[a-f0-9]{64}$/.test(confirmationId)) throw new RemoteError("workbench/invalid-input", "A valid stop confirmation is required.", {});
    try { return await this.runtime.stopService(confirmationId); }
    catch (error) { this.logFailure("stopService", error); throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "Service shutdown could not be confirmed."), {}); }
  }

  @Remote("restartService")
  async restartService(confirmationId: string): Promise<WorkbenchBootstrapResult> {
    if (typeof confirmationId !== "string" || !/^[a-f0-9]{64}$/.test(confirmationId)) throw new RemoteError("workbench/invalid-input", "A valid restart confirmation is required.", {});
    try { return await this.runtime.restartService(confirmationId); }
    catch (error) { this.logFailure("restartService", error); throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The manual service restart failed."), {}); }
  }

  @Remote("role")
  async role(): Promise<WorkbenchGuideRole> {
    return this.runtime.guideRole();
  }

  @Remote("spaceAction")
  async spaceAction(request: DesktopSpaceAction): Promise<import("../../../../src/shared/space-host").PortalSnapshot> {
    if (!validDesktopSpaceAction(request)) throw new RemoteError("workbench/invalid-input", "Invalid space action.", {});
    try { return await this.runtime.spaceAction(request); }
    catch (error) { this.logFailure("spaceAction", error); throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The space operation failed."), {}); }
  }

  @Remote("spaceActivity")
  async spaceActivity(spaceId: string, serviceEpoch: string): Promise<{ activity: "idle" | "busy" | "unknown"; generation: number }> {
    if (!validDesktopSpaceAction({ spaceId, serviceEpoch, action: "stop" })) throw new RemoteError("workbench/invalid-input", "Invalid space identity.", {});
    try { return await this.runtime.spaceActivity(spaceId, serviceEpoch); }
    catch (error) { this.logFailure("spaceActivity", error); throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The task state could not be read."), {}); }
  }

  @Remote("presentationSnapshot")
  async presentationSnapshot(): Promise<import("../../../../src/shared/space-host").PortalSnapshot> {
    try { return await this.runtime.presentationSnapshot(); }
    catch (error) { this.logFailure("presentationSnapshot", error); throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The space directory is unavailable."), {}); }
  }

  @Remote("bootstrap")
  async bootstrap(): Promise<WorkbenchBootstrapResult> {
    try {
      return await this.runtime.bootstrap();
    } catch (error) {
      if (error instanceof RemoteError) { this.logFailure("bootstrap", error); throw error; }
      this.logFailure("bootstrap", error);
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
      if (error instanceof RemoteError) { this.logFailure("returnTarget", error); throw error; }
      this.logFailure("returnTarget", error);
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
    catch (error) { this.logFailure("portalTarget", error); throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The in-app workbench entry could not be opened."), {}); }
  }

  @Remote("initialize")
  async initialize(): Promise<WorkbenchInitializeResult> {
    try {
      return await this.runtime.initialize();
    } catch (error) {
      if (error instanceof RemoteError) { this.logFailure("initialize", error); throw error; }
      this.logFailure("initialize", error);
      throw new RemoteError(
        "workbench/unavailable",
        reportedOrFallback(error instanceof Error ? error.message : undefined, WORKBENCH_PUBLIC_ERROR["workbench/unavailable"]),
        {},
      );
    }
  }

  @Remote("beginDesktopLaunch")
  async beginDesktopLaunch(): Promise<DesktopLaunchState> {
    try { return await this.runtime.beginDesktopLaunch(); }
    catch (error) {
      if (error instanceof RemoteError) { this.logFailure("beginDesktopLaunch", error); throw error; }
      this.logFailure("beginDesktopLaunch", error);
      throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The Desktop launch is unavailable."), {});
    }
  }

  /** Read-only. Does not call initialize or beginDesktopLaunch. */
  @Remote("desktopLaunchState")
  async desktopLaunchState(): Promise<DesktopLaunchState> {
    try { return await this.runtime.desktopLaunchState(); }
    catch (error) {
      if (error instanceof RemoteError) { this.logFailure("desktopLaunchState", error); throw error; }
      this.logFailure("desktopLaunchState", error);
      throw new RemoteError("workbench/unavailable", reportedOrFallback(error instanceof Error ? error.message : undefined, "The Desktop launch state is unavailable."), {});
    }
  }

  /** Record a bounded sanitized client-side failure into the host diagnostic log. */
  @Remote("reportClientFailure")
  async reportClientFailure(report: ClientFailureReport): Promise<{ recorded: boolean }> {
    if (!validClientFailureReport(report)) throw new RemoteError("workbench/invalid-input", "Invalid client diagnostic report.", {});
    try { return this.runtime.reportClientFailure(report); }
    catch { return { recorded: false }; }
  }
}
