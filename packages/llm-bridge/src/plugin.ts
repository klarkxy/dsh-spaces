import { Context, type Fiber } from "@deepseek-ai/cordis";
import { deepEqualJson } from "@deepseek-ai/dsh-util-values";
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
  asRecord,
  assertManagedMutate,
  assertUserWrite,
  snapshotBridgeStatus,
  type LlmBridgeStatus,
} from "./settings-provider";
import { sharedReadOnlyError } from "./errors";

export const name = "dsh-spaces-llm-bridge";
export const SNAPSHOT_SERVICE = "spacesLlmSnapshot";
export const inject = ["loader", "configEditor", "settings", "credentials", "llm"];

const CREDENTIAL_METHODS = [
  "resolve",
  "describe",
  "set",
  "unset",
  "readRecord",
  "describeRecord",
  "listRecords",
  "modifyRecord",
  "deleteRecord",
] as const;
const WRAPPED_CREDENTIAL_METHODS = [
  "resolve",
  "describe",
  "set",
  "unset",
  "describeRecord",
  "modifyRecord",
  "deleteRecord",
] as const;

type CredentialService = {
  resolve: (...args: never[]) => unknown;
  describe: (...args: never[]) => unknown;
  set: (...args: never[]) => unknown;
  unset: (...args: never[]) => unknown;
  readRecord: (...args: never[]) => unknown;
  describeRecord: (...args: never[]) => unknown;
  listRecords: (...args: never[]) => unknown;
  modifyRecord: (...args: never[]) => unknown;
  deleteRecord: (...args: never[]) => unknown;
};

type LoaderEntry = {
  options: { id?: string; name?: string; config?: Record<string, unknown> };
};

type ConfigFiber = {
  entry?: LoaderEntry;
};

type ConfigEditorSeam = {
  edit(
    entry: LoaderEntry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>;
  configuration(): Array<{ entry: LoaderEntry; inherited: Record<string, unknown>; override: Record<string, unknown> }>;
};

type NativeSettingsSeam = {
  update(ns: string, patch: object, expected?: number): Promise<void>;
  replace(ns: string, section: object, expected?: number): Promise<void>;
  mutate(ns: string, ops: readonly unknown[], expected?: number): Promise<void>;
  describe?(options?: { redactSecrets?: boolean }): Array<{ ns: string; user?: unknown; value?: unknown }>;
  register?: unknown;
  registrations?: unknown;
  section?: unknown;
  resolve?: unknown;
  commit?: unknown;
  bridgeStatus?: () => LlmBridgeStatus;
};

export function apply(ctx: Context, _config?: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const snapshot = readSnapshot(env);
  const settings = requireNativeSettings(ctx);
  const editor = requireConfigEditor(ctx);
  const restorers: Array<() => void> = [];
  ctx.effect(() => () => {
    for (const restore of restorers.reverse()) restore();
  });
  ctx.on(
    "internal/config",
    function (this: Fiber, config: unknown, next: () => unknown) {
      return projectInternalConfig(this as ConfigFiber, config, next, snapshot, editor);
    },
    { global: true, prepend: true },
  );
  installSettingsGuards(settings, restorers);
  installConfigEditorGuard(editor, restorers);
  const status = () => snapshotBridgeStatus(snapshot, conflictRouteIds(settings, editor));
  const previousStatus = settings.bridgeStatus;
  const ownStatus = Object.prototype.hasOwnProperty.call(settings, "bridgeStatus");
  settings.bridgeStatus = status;
  restorers.push(() => {
    if (ownStatus) settings.bridgeStatus = previousStatus;
    else delete settings.bridgeStatus;
  });
  installManagedRequestGuard(ctx, { bridgeStatus: status });
  const home = env[LLM_SNAPSHOT_ENV.home] ?? env.DSH_HOME;
  const credentials = ctx.credentials as CredentialService | undefined;
  if (snapshot && home && credentials) {
    attachSharedCredentials(ctx, home, snapshot, credentials);
  }
  ctx.provide(SNAPSHOT_SERVICE, snapshot ?? true);
}

function readSnapshot(env: NodeJS.ProcessEnv): LlmSharedSnapshot | null {
  const snapshotPath = env[LLM_SNAPSHOT_ENV.snapshot];
  if (!snapshotPath) return null;
  if (!existsSync(snapshotPath)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm launch snapshot path is missing");
  }
  return readLaunchSnapshotFile(snapshotPath).snapshot;
}

function projectInternalConfig(
  fiber: ConfigFiber,
  config: unknown,
  next: () => unknown,
  snapshot: LlmSharedSnapshot | null,
  editor: ConfigEditorSeam,
): unknown {
  const id = fiber.entry?.options.id;
  if (id !== LLM_PI_AI_NAMESPACE && id !== AGENT_DEFAULT_MODEL_NAMESPACE) return next();
  if (!snapshot) return next();
  if (id === LLM_PI_AI_NAMESPACE) {
    const raw = asRecord(config) ?? {};
    collectManagedWritePaths(raw);
    const resolved = asRecord(next()) ?? raw;
    return mergeSharedProvidersIntoBase(resolved, snapshot.connections);
  }
  const resolved = asRecord(next()) ?? asRecord(config) ?? {};
  const override = editor.configuration().find((row) => row.entry.options.id === AGENT_DEFAULT_MODEL_NAMESPACE)?.override;
  if (hasPersistedDefault(override)) return resolved;
  return mergeGlobalDefaultIntoBase(resolved, snapshot);
}

function requireNativeSettings(ctx: Context): NativeSettingsSeam {
  const settings = ctx.settings as NativeSettingsSeam | undefined;
  if (
    !settings ||
    typeof settings.update !== "function" ||
    typeof settings.replace !== "function" ||
    typeof settings.mutate !== "function"
  ) {
    throw new LlmConfigError(
      LLM_ERROR.UNSUPPORTED_RUNTIME,
      "official settings service is missing SettingsForms update/replace/mutate",
    );
  }
  if (
    settings.registrations instanceof Map ||
    typeof settings.section === "function" ||
    typeof settings.resolve === "function" ||
    typeof settings.commit === "function" ||
    typeof settings.register === "function"
  ) {
    throw new LlmConfigError(
      LLM_ERROR.UNSUPPORTED_RUNTIME,
      "official settings provider still exposes the removed rc2 register/section/commit seam",
    );
  }
  return settings;
}

function requireConfigEditor(ctx: Context): ConfigEditorSeam {
  const editor = (ctx as Context & { configEditor?: ConfigEditorSeam }).configEditor;
  if (!editor || typeof editor.edit !== "function" || typeof editor.configuration !== "function") {
    throw new LlmConfigError(
      LLM_ERROR.UNSUPPORTED_RUNTIME,
      "official configEditor.edit is required to persist local LLM config without writing shared routes",
    );
  }
  return editor;
}

function hasPersistedDefault(override: Record<string, unknown> | undefined): boolean {
  return (
    typeof override?.provider === "string" &&
    override.provider.trim() !== "" &&
    typeof override?.model === "string" &&
    override.model.trim() !== ""
  );
}

function installSettingsGuards(settings: NativeSettingsSeam, restorers: Array<() => void>): void {
  patchMethod(settings, "update", restorers, (original) =>
    function (this: NativeSettingsSeam, ns: string, patch: object, expected?: number) {
      assertUserWrite(ns, patch);
      return original.call(this, ns, patch, expected);
    },
  );
  patchMethod(settings, "replace", restorers, (original) =>
    function (this: NativeSettingsSeam, ns: string, section: object, expected?: number) {
      assertUserWrite(ns, section);
      return original.call(this, ns, section, expected);
    },
  );
  patchMethod(settings, "mutate", restorers, (original) =>
    function (this: NativeSettingsSeam, ns: string, ops: readonly unknown[], expected?: number) {
      assertManagedMutate(ns, ops);
      return original.call(this, ns, ops, expected);
    },
  );
}

function installConfigEditorGuard(editor: ConfigEditorSeam, restorers: Array<() => void>): void {
  const original = editor.edit.bind(editor);
  const own = Object.prototype.hasOwnProperty.call(editor, "edit");
  editor.edit = async (entry, change) => {
    await original(entry, (current, inherited) => {
      const next = change(current, inherited);
      if (entry.options.id === LLM_PI_AI_NAMESPACE) {
        refuseManagedConfigMutation(current, next);
      }
      return next;
    });
  };
  restorers.push(() => {
    if (own) editor.edit = original;
    else delete (editor as { edit?: ConfigEditorSeam["edit"] }).edit;
  });
}

function refuseManagedConfigMutation(current: Record<string, unknown>, next: Record<string, unknown>): void {
  const currentProviders = asRecord(current.providers) ?? {};
  const nextProviders = asRecord(next.providers) ?? {};
  const keys = new Set([...Object.keys(currentProviders), ...Object.keys(nextProviders)]);
  for (const key of keys) {
    if (!isManagedRouteId(key)) continue;
    if (!deepEqualJson(nextProviders[key], currentProviders[key])) throw sharedReadOnlyError(key);
  }
}

function conflictRouteIds(settings: NativeSettingsSeam, editor: ConfigEditorSeam | undefined): string[] {
  if (editor) {
    const row = editor.configuration().find((item) => item.entry.options.id === LLM_PI_AI_NAMESPACE);
    return collectManagedWritePaths(row?.override);
  }
  const described = settings.describe?.()?.find((row) => row.ns === LLM_PI_AI_NAMESPACE);
  return collectManagedWritePaths(described?.user);
}

function patchMethod<K extends "update" | "replace" | "mutate">(
  target: NativeSettingsSeam,
  method: K,
  restorers: Array<() => void>,
  wrap: (original: NativeSettingsSeam[K]) => NativeSettingsSeam[K],
): void {
  const current = target[method];
  if (typeof current !== "function") return;
  const own = Object.prototype.hasOwnProperty.call(target, method);
  target[method] = wrap(current);
  restorers.push(() => {
    if (own) target[method] = current;
    else delete target[method];
  });
}

function captureLocalCredentials(existing: CredentialService): { local: CredentialService; restore(): void } {
  const originals = {} as CredentialService;
  const own: Partial<Record<(typeof CREDENTIAL_METHODS)[number], boolean>> = {};
  for (const key of CREDENTIAL_METHODS) {
    if (typeof existing[key] !== "function") continue;
    own[key] = Object.prototype.hasOwnProperty.call(existing, key);
    originals[key] = existing[key];
  }
  const delegate = new Proxy(existing, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in originals) {
        return originals[prop as keyof CredentialService];
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const local = {} as CredentialService;
  for (const key of CREDENTIAL_METHODS) {
    const original = originals[key];
    if (typeof original !== "function") continue;
    local[key] = (...args: never[]) => original.apply(delegate, args);
  }
  return {
    local,
    restore() {
      for (const key of WRAPPED_CREDENTIAL_METHODS) {
        if (typeof originals[key] !== "function") continue;
        if (own[key]) existing[key] = originals[key];
        else delete existing[key];
      }
    },
  };
}

function attachSharedCredentials(
  ctx: Context,
  home: string,
  snapshot: LlmSharedSnapshot,
  existing: CredentialService,
): void {
  const captured = captureLocalCredentials(existing);
  ctx.effect(() => {
    const isolated = new Context();
    const store = new FileLlmCredentialStore(home);
    const wrapped = new SpacesCredentialsProvider(
      isolated,
      captured.local as never,
      {
        describe: (recordId) => store.describe(recordId),
        readSecret: (recordId) => store.readSecret(recordId),
      },
      snapshot,
    );
    Object.assign(existing, {
      resolve: wrapped.resolve.bind(wrapped),
      describe: wrapped.describe.bind(wrapped),
      set: wrapped.set.bind(wrapped),
      unset: wrapped.unset.bind(wrapped),
      describeRecord: wrapped.describeRecord.bind(wrapped),
      modifyRecord: wrapped.modifyRecord.bind(wrapped),
      deleteRecord: wrapped.deleteRecord.bind(wrapped),
    });
    return async () => {
      captured.restore();
      await isolated.fiber.dispose();
    };
  });
}

export default { name, inject, apply };
