import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import { homedir } from "node:os";
import { join } from "node:path";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import {
  NodeSpacesControl,
  SpacesPublicError,
  type SpacesErrorCode,
  type SpacesLoaderView,
} from "../../../../src/adapters/node/spaces-control";
import type {
  CreateSpaceInput,
  SpaceDetail,
  SpaceSummary,
  SpacesOverview,
  VerifySpaceResult,
} from "../../../../src/shared/spaces-control";
import { SPACES_REMOTE_CODES, type SpacesRemoteCode } from "./remote-errors";

export interface SpacesHostConfig {
  snapshotRoot?: string;
}

/** Remote-only Host service. Namespace and Cordis key are both `spaces`. */
export class SpacesHost extends TypertRemoteService {
  static inject = ["loader"];

  private readonly control: NodeSpacesControl;

  constructor(ctx: Context, config: SpacesHostConfig = {}) {
    super(ctx, "spaces");
    const snapshotRoot = typeof config.snapshotRoot === "string" ? config.snapshotRoot : undefined;
    this.control = new NodeSpacesControl({
      home: process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"),
      allowRealHome: true,
      argv: process.argv,
      env: process.env,
      execPath: process.execPath,
      baseUrl: typeof ctx.baseUrl === "string" ? ctx.baseUrl : undefined,
      loader: ctx.loader as unknown as SpacesLoaderView,
      snapshotRoot,
    });
  }

  @Remote("overview")
  async overview(): Promise<SpacesOverview> {
    return this.guard(() => this.control.overview());
  }

  @Remote("detail")
  async detail(id: string): Promise<SpaceDetail> {
    return this.guard(() => this.control.detail(id));
  }

  @Remote("create")
  async create(input: CreateSpaceInput): Promise<SpaceSummary> {
    return this.guard(() => this.control.create(input));
  }

  @Remote("verify")
  async verify(id: string): Promise<VerifySpaceResult> {
    return this.guard(() => this.control.verify(id));
  }

  private async guard<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof SpacesPublicError) {
        throw new RemoteError(asRemoteCode(error.code), error.message, {});
      }
      throw new RemoteError("spaces/unavailable", "The space operation could not be completed.", {});
    }
  }
}

function asRemoteCode(code: SpacesErrorCode): SpacesRemoteCode {
  return (SPACES_REMOTE_CODES as readonly string[]).includes(code) ? (code as SpacesRemoteCode) : "spaces/unavailable";
}

export default SpacesHost;
