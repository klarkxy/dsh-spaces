import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { SpaceDetail, SpaceSummary, SpacesOverview } from "../../../../src/shared/spaces-control";
import type { WorkbenchSpace } from "../../../../src/shared/workbench";
import type { WorkbenchHostRuntime } from "./runtime";

export interface SpacesHostConfig {
  snapshotRoot?: string;
}

/**
 * Compatibility read Remote. Never constructs NodeSpacesControl, so it cannot
 * bypass manager-only writes. Overview/detail are supervisor reads with
 * canCreate/canVerify forced false.
 */
export class SpacesHost extends TypertRemoteService {
  static inject = ["loader"];

  constructor(
    ctx: Context,
    private readonly runtime: WorkbenchHostRuntime,
  ) {
    super(ctx, "spaces");
  }

  @Remote("overview")
  async overview(): Promise<SpacesOverview> {
    return this.guard(async () => {
      const api = await this.runtime.managerApi();
      const state = await api.state();
      return {
        capabilities: {
          mode: state.mode,
          hostSpaceId: state.managerId,
          dshVersion: state.dshVersion,
          canCreate: false,
          canVerify: false,
          reasons: state.reasons,
        },
        spaces: state.spaces.map(toSummary),
      };
    });
  }

  @Remote("detail")
  async detail(id: string): Promise<SpaceDetail> {
    return this.guard(async () => {
      const api = await this.runtime.managerApi();
      return api.detail(id);
    });
  }

  private async guard<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError("spaces/unavailable", "The space operation could not be completed.", {});
    }
  }
}

function toSummary(space: WorkbenchSpace): SpaceSummary {
  return {
    id: space.id,
    displayName: space.displayName,
    isHost: space.isHost,
    hasWebApp: space.hasWebApp,
    status: space.status === "running" || space.status === "stopped" ? space.status : "unknown",
    isolation: space.isolation,
  };
}

export default SpacesHost;
