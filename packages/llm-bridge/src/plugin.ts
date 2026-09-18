import type { Context } from "@deepseek-ai/cordis";
import { existsSync } from "node:fs";
import { FileLlmCredentialStore } from "../../../src/adapters/node/llm-credential-store";
import {
  LLM_ERROR,
  LlmConfigError,
  isManagedRouteId,
} from "../../../src/core/domain/llm-connections";
import {
  collectManagedWritePaths,
  mergeGlobalDefaultIntoBase,
  mergeSharedProvidersIntoBase,
} from "../../../src/core/domain/llm-resolution";
import type { LlmSharedSnapshot } from "../../../src/core/domain/llm-connections";
import { LLM_SNAPSHOT_ENV, readLaunchSnapshotFile } from "../../../src/adapters/node/llm-snapshot";
import { SpacesCredentialsProvider } from "./credentials-provider";
import { installManagedRequestGuard } from "./request-guard";
import {
  AGENT_DEFAULT_MODEL_NAMESPACE,
  LLM_PI_AI_NAMESPACE,
  type LlmBridgeStatus,
  type SpacesFileSettingsProvider,
} from "./settings-provider";
import { sharedReadOnlyError } from "./errors";

export const name = "dsh-spaces-llm-bridge";
export const inject = ["settings"];

export function apply(ctx: Context, _config?: unknown, env: NodeJS.ProcessEnv = process.env): LlmBridgeStatus | null {
  const snapshotPath = env[LLM_SNAPSHOT_ENV.snapshot];
  if (!snapshotPath) return null;
  if (!existsSync(snapshotPath)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm launch snapshot path is missing");
  }
  const file = readLaunchSnapshotFile(snapshotPath);
  const snapshot = file.snapshot;
  if (!snapshot) return null;
  const settings = ctx.settings as SpacesFileSettingsProvider & {
    register?: (...args: never[]) => unknown;
    update?: (ns: string, patch: object, expected?: number) => Promise<void>;
    replace?: (ns: string, section: object, expected?: number) => Promise<void>;
    mutate?: (ns: string, ops: readonly unknown[], expected?: number) => Promise<void>;
    get?: (ns: string) => unknown;
    replaceSharedSnapshot?: (next: LlmSharedSnapshot | null) => void;
  };
  if (typeof settings.replaceSharedSnapshot === "function") {
    settings.replaceSharedSnapshot(snapshot);
  } else {
    wrapOfficialSettings(settings as never, snapshot);
  }
  const home = env[LLM_SNAPSHOT_ENV.home] ?? env.DSH_HOME;
  if (home && ctx.credentials) {
    attachSharedCredentials(ctx, home, snapshot);
  }
  if (ctx.llm) {
    installManagedRequestGuard(ctx, {
      bridgeStatus: () =>
        typeof settings.bridgeStatus === "function"
          ? settings.bridgeStatus()
          : {
              source: snapshot.connections.length > 0 ? "spaces-shared" : "local-only",
              catalogRevision: snapshot.catalogRevision,
              policyRevision: snapshot.policyRevision,
              connectionRevisions: Object.fromEntries(snapshot.connections.map((item) => [item.id, item.revision])),
              adapterVersion: snapshot.adapterVersion,
              managedRouteConflict: false,
              conflictRouteIds: [],
            },
    });
  }
  return typeof settings.bridgeStatus === "function" ? settings.bridgeStatus() : null;
}

function wrapOfficialSettings(
  settings: {
    register?: (ns: string, schema: unknown, options?: { base?: object }) => unknown;
    update?: (ns: string, patch: object, expected?: number) => Promise<void>;
    replace?: (ns: string, section: object, expected?: number) => Promise<void>;
    mutate?: (ns: string, ops: readonly unknown[], expected?: number) => Promise<void>;
    get?: (ns: string) => unknown;
  },
  snapshot: LlmSharedSnapshot,
): void {
  if (typeof settings.register === "function") {
    const register = settings.register.bind(settings);
    settings.register = (ns, schema, options) => register(ns, schema, withSharedBase(ns, options, snapshot));
  }
  if (typeof settings.update === "function") {
    const update = settings.update.bind(settings);
    settings.update = (ns, patch, expected) => {
      assertUserWrite(ns, patch);
      return update(ns, patch, expected);
    };
  }
  if (typeof settings.replace === "function") {
    const replace = settings.replace.bind(settings);
    settings.replace = (ns, section, expected) => {
      assertUserWrite(ns, section);
      return replace(ns, section, expected);
    };
  }
  if (typeof settings.mutate === "function") {
    const mutate = settings.mutate.bind(settings);
    settings.mutate = (ns, ops, expected) => {
      if (ns === LLM_PI_AI_NAMESPACE) {
        for (const op of ops) {
          if (
            op &&
            typeof op === "object" &&
            "path" in op &&
            Array.isArray(op.path) &&
            op.path[0] === "providers" &&
            typeof op.path[1] === "string" &&
            isManagedRouteId(op.path[1])
          ) {
            throw sharedReadOnlyError(op.path[1]);
          }
        }
      }
      return mutate(ns, ops, expected);
    };
  }
  if (typeof settings.get === "function") {
    const get = settings.get.bind(settings);
    settings.get = (ns) => mergeOnRead(ns, get(ns), snapshot);
  }
}

function withSharedBase(
  ns: string,
  options: { base?: object } | undefined,
  snapshot: LlmSharedSnapshot,
): { base?: object } | undefined {
  const base = options?.base && typeof options.base === "object" ? (options.base as Record<string, unknown>) : undefined;
  if (ns === LLM_PI_AI_NAMESPACE) {
    return { ...options, base: mergeSharedProvidersIntoBase(base, snapshot.connections) };
  }
  if (ns === AGENT_DEFAULT_MODEL_NAMESPACE) {
    return { ...options, base: mergeGlobalDefaultIntoBase(base, snapshot) };
  }
  return options;
}

function mergeOnRead(ns: string, value: unknown, snapshot: LlmSharedSnapshot): unknown {
  if (ns === LLM_PI_AI_NAMESPACE && value && typeof value === "object") {
    return mergeSharedProvidersIntoBase(value as Record<string, unknown>, snapshot.connections);
  }
  if (ns === AGENT_DEFAULT_MODEL_NAMESPACE && value && typeof value === "object") {
    return mergeGlobalDefaultIntoBase(value as Record<string, unknown>, snapshot);
  }
  return value;
}

function assertUserWrite(ns: string, section: object): void {
  if (ns !== LLM_PI_AI_NAMESPACE) return;
  const routes = collectManagedWritePaths(section);
  if (routes.length > 0) throw sharedReadOnlyError(routes[0]);
}

function attachSharedCredentials(ctx: Context, home: string, snapshot: LlmSharedSnapshot): void {
  const store = new FileLlmCredentialStore(home);
  const wrapped = new SpacesCredentialsProvider(
    ctx,
    ctx.credentials as never,
    {
      describe: (recordId) => store.describe(recordId),
      readSecret: (recordId) => store.readSecret(recordId),
    },
    snapshot,
  );
  Object.assign(ctx.credentials, {
    resolve: wrapped.resolve.bind(wrapped),
    describe: wrapped.describe.bind(wrapped),
    set: wrapped.set.bind(wrapped),
    unset: wrapped.unset.bind(wrapped),
    describeRecord: wrapped.describeRecord.bind(wrapped),
    modifyRecord: wrapped.modifyRecord.bind(wrapped),
    deleteRecord: wrapped.deleteRecord.bind(wrapped),
  });
}

export default { name, inject, apply };
