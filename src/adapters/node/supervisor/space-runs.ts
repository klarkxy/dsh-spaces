import { randomBytes } from "node:crypto";
import type { ChildView } from "./types";

const VIEW_ENV = {
  parent: "DSH_SPACES_VIEW_PARENT_ORIGIN",
  id: "DSH_SPACES_VIEW_ID",
  generation: "DSH_SPACES_VIEW_GENERATION",
  channel: "DSH_SPACES_VIEW_CHANNEL",
  epoch: "DSH_SPACES_VIEW_SERVICE_EPOCH",
} as const;

export class SpaceRunRegistry {
  readonly generations = new Map<string, number>();
  readonly views = new Map<string, ChildView>();
  readonly workspaceOrigins = new Set<string>();
  readonly spawned = new Map<string, { pid: number; startedAt: string }>();
  readonly unmanaged = new Set<string>();
  readonly llmApplied = new Map<string, number>();

  generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  nextGeneration(id: string): number {
    const gen = this.generation(id) + 1;
    this.generations.set(id, gen);
    return gen;
  }

  issueView(id: string, port: number, epoch: string): ChildView {
    const generation = this.generation(id);
    let current = this.views.get(id);
    if (!current || current.generation !== generation || current.serviceEpoch !== epoch) {
      current = {
        spaceId: id,
        generation,
        origin: `http://127.0.0.1:${port}`,
        channel: randomBytes(8).toString("hex"),
        serviceEpoch: epoch,
        issued: true,
      };
      this.views.set(id, current);
    }
    current.issued = true;
    return current;
  }

  childViewEnv(profile: string, ctx: { managerId: string | null; origin: string; managerOrigin: string | null; currentEpoch: string }): NodeJS.ProcessEnv {
    const generation = String(this.generation(profile));
    const view = this.views.get(profile);
    const parent =
      profile === ctx.managerId ? ctx.origin : ctx.managerOrigin ?? ctx.origin;
    return {
      DSH_SPACES_SUPERVISOR_ORIGIN: ctx.origin,
      [VIEW_ENV.parent]: parent,
      [VIEW_ENV.id]: profile,
      [VIEW_ENV.generation]: generation,
      [VIEW_ENV.channel]: view?.channel ?? "",
      [VIEW_ENV.epoch]: view?.serviceEpoch ?? ctx.currentEpoch,
    };
  }
}
