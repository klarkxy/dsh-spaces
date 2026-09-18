import type { Context } from "@deepseek-ai/cordis";
import { FileSettingsProvider, type Config as FileSettingsConfig } from "@deepseek-ai/dsh-settings-file";
import type { SettingsPathOp, SettingsRegisterOptions, SettingsUpdateSource } from "@deepseek-ai/dsh-settings";
import type { LlmSharedSnapshot } from "../../../src/core/domain/llm-connections";
import { LLM_ERROR, isManagedRouteId } from "../../../src/core/domain/llm-connections";
import {
  collectManagedWritePaths,
  mergeGlobalDefaultIntoBase,
  mergeSharedProvidersIntoBase,
  stripManagedRoutesFromUserSection,
  userSectionHasManagedRoutes,
} from "../../../src/core/domain/llm-resolution";
import { managedRouteConflictError, sharedReadOnlyError } from "./errors";

export const LLM_PI_AI_NAMESPACE = "llm-pi-ai";
export const AGENT_DEFAULT_MODEL_NAMESPACE = "agent-default-model";

export interface SpacesFileSettingsConfig extends FileSettingsConfig {
  shared?: LlmSharedSnapshot;
}

export interface LlmBridgeStatus {
  source: "spaces-shared" | "local-only";
  catalogRevision: number | null;
  policyRevision: number | null;
  connectionRevisions: Record<string, number>;
  adapterVersion: string | null;
  managedRouteConflict: boolean;
  conflictRouteIds: string[];
}

export class SpacesFileSettingsProvider extends FileSettingsProvider {
  declare config: SpacesFileSettingsConfig;
  private shared: LlmSharedSnapshot | null;
  private conflictRouteIds: string[] = [];

  constructor(ctx: Context, config: SpacesFileSettingsConfig) {
    super(ctx, config);
    this.shared = config.shared ?? null;
    const inheritedRegister = super.register.bind(this) as FileSettingsProvider["register"];
    this.register = ((ns, schema, options) =>
      inheritedRegister(ns, schema, this.withSharedBase(String(ns), options))) as FileSettingsProvider["register"];
  }

  replaceSharedSnapshot(snapshot: LlmSharedSnapshot | null): void {
    this.shared = snapshot;
  }

  bridgeStatus(): LlmBridgeStatus {
    const connections = this.shared?.connections ?? [];
    return {
      source: this.shared && this.shared.connections.length > 0 ? "spaces-shared" : "local-only",
      catalogRevision: this.shared?.catalogRevision ?? null,
      policyRevision: this.shared?.policyRevision ?? null,
      connectionRevisions: Object.fromEntries(connections.map((item) => [item.id, item.revision])),
      adapterVersion: this.shared?.adapterVersion ?? null,
      managedRouteConflict: this.conflictRouteIds.length > 0,
      conflictRouteIds: [...this.conflictRouteIds],
    };
  }

  update(ns: string, patch: object, expectedRevision?: number): Promise<void> {
    this.assertUserWrite(ns, patch);
    return super.update(ns as never, patch, expectedRevision);
  }

  replace(ns: string, section: object, expectedRevision?: number): Promise<void> {
    this.assertUserWrite(ns, section);
    return super.replace(ns as never, section, expectedRevision);
  }

  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> {
    if (ns === LLM_PI_AI_NAMESPACE) {
      for (const op of ops) {
        if (op.path[0] === "providers" && typeof op.path[1] === "string" && isManagedRouteId(op.path[1])) {
          throw sharedReadOnlyError(op.path[1]);
        }
      }
    }
    return super.mutate(ns as never, ops, expectedRevision);
  }

  protected override async load(): Promise<Record<string, unknown>> {
    return this.sanitizeDocument(await super.load());
  }

  protected override publish(doc: Record<string, unknown>, source?: SettingsUpdateSource): void {
    super.publish(this.sanitizeDocument(doc), source);
  }

  private withSharedBase<T>(ns: string, options?: SettingsRegisterOptions<T>): SettingsRegisterOptions<T> | undefined {
    if (!this.shared) return options;
    if (ns === LLM_PI_AI_NAMESPACE) {
      const base = mergeSharedProvidersIntoBase(
        asRecord(options?.base),
        this.shared.connections,
      ) as Partial<T>;
      return { ...options, base };
    }
    if (ns === AGENT_DEFAULT_MODEL_NAMESPACE) {
      const base = mergeGlobalDefaultIntoBase(asRecord(options?.base), this.shared) as Partial<T>;
      return { ...options, base };
    }
    return options;
  }

  private assertUserWrite(ns: string, section: object): void {
    if (ns !== LLM_PI_AI_NAMESPACE) return;
    const routes = collectManagedWritePaths(section);
    if (routes.length > 0) throw sharedReadOnlyError(routes[0]);
  }

  private sanitizeDocument(doc: Record<string, unknown>): Record<string, unknown> {
    const section = doc[LLM_PI_AI_NAMESPACE];
    const routes = collectManagedWritePaths(section);
    this.conflictRouteIds = routes;
    if (routes.length === 0 || !asRecord(section)) return doc;
    return {
      ...doc,
      [LLM_PI_AI_NAMESPACE]: stripManagedRoutesFromUserSection(asRecord(section)!),
    };
  }
}

export function assertNoManagedUserSection(section: unknown): void {
  if (userSectionHasManagedRoutes(section)) {
    throw managedRouteConflictError(collectManagedWritePaths(section));
  }
}

export function refuseManagedCall(status: LlmBridgeStatus): void {
  if (!status.managedRouteConflict) return;
  throw new (class extends Error {
    readonly code = LLM_ERROR.MANAGED_ROUTE_CONFLICT;
    constructor() {
      super("managed LLM routes are blocked while local settings occupy a reserved prefix");
    }
  })();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

