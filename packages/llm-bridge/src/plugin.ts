import { Context } from "@deepseek-ai/cordis";
import { deepFreeze } from "@deepseek-ai/dsh-util-values";
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
  assertNoManagedUserSection,
  type LlmBridgeStatus,
  type SpacesFileSettingsProvider,
} from "./settings-provider";
import { sharedReadOnlyError } from "./errors";

export const name = "dsh-spaces-llm-bridge";
export const inject = ["settings", "credentials", "llm"];

const MANAGED_NAMESPACES = [LLM_PI_AI_NAMESPACE, AGENT_DEFAULT_MODEL_NAMESPACE] as const;
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

type OfficialRegistration = {
  ns: string;
  schema: (value: unknown) => unknown;
  base?: unknown;
  validate?: (value: unknown) => void;
};

type OfficialSettingsSeam = {
  registrations: Map<string, OfficialRegistration>;
  section: (ns: string) => unknown;
  resolve: (
    schema: OfficialRegistration["schema"],
    base: unknown,
    section: unknown,
    validate?: (value: unknown) => void,
  ) => unknown;
  commit: (registration: OfficialRegistration, next: unknown, source: "provider" | "update") => void;
  register?: (ns: string, schema: unknown, options?: { base?: object }) => unknown;
  update?: (ns: string, patch: object, expected?: number) => Promise<void>;
  replace?: (ns: string, section: object, expected?: number) => Promise<void>;
  mutate?: (ns: string, ops: readonly unknown[], expected?: number) => Promise<void>;
};

type TouchedRegistration = {
  ns: string;
  registration: OfficialRegistration;
  originalBase: unknown;
};

type HostSettings = SpacesFileSettingsProvider & {
  register?: (...args: never[]) => unknown;
  update?: (ns: string, patch: object, expected?: number) => Promise<void>;
  replace?: (ns: string, section: object, expected?: number) => Promise<void>;
  mutate?: (ns: string, ops: readonly unknown[], expected?: number) => Promise<void>;
  get?: (ns: string) => unknown;
  replaceSharedSnapshot?: (next: LlmSharedSnapshot | null) => void;
  bridgeStatus?: () => LlmBridgeStatus;
};

export function apply(ctx: Context, _config?: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const snapshotPath = env[LLM_SNAPSHOT_ENV.snapshot];
  if (!snapshotPath) return;
  if (!existsSync(snapshotPath)) {
    throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "llm launch snapshot path is missing");
  }
  const file = readLaunchSnapshotFile(snapshotPath);
  const snapshot = file.snapshot;
  if (!snapshot) return;
  const settings = ctx.settings as HostSettings;
  if (typeof settings.replaceSharedSnapshot === "function") {
    settings.replaceSharedSnapshot(snapshot);
  } else {
    wrapOfficialSettings(ctx, settings, snapshot);
  }
  const home = env[LLM_SNAPSHOT_ENV.home] ?? env.DSH_HOME;
  const credentials = ctx.credentials as CredentialService | undefined;
  if (home && credentials) {
    attachSharedCredentials(ctx, home, snapshot, credentials);
  }
  if (ctx.llm) {
    installManagedRequestGuard(ctx, {
      bridgeStatus: () => liveBridgeStatus(settings, snapshot),
    });
  }
}

function wrapOfficialSettings(ctx: Context, settings: object, snapshot: LlmSharedSnapshot): void {
  const seam = requireOfficialSettingsSeam(settings);
  assertNoManagedUserSection(seam.section(LLM_PI_AI_NAMESPACE));
  ctx.effect(() => {
    const touched: TouchedRegistration[] = [];
    try {
      projectExistingManaged(seam, snapshot, touched);
      const restoreMethods = installSettingsGuards(seam, snapshot, touched);
      return () => {
        restoreMethods();
        restoreTouched(seam, touched);
      };
    } catch (error) {
      restoreTouched(seam, touched);
      throw error;
    }
  });
}

function requireOfficialSettingsSeam(settings: object): OfficialSettingsSeam {
  const candidate = settings as Partial<OfficialSettingsSeam>;
  if (
    !(candidate.registrations instanceof Map) ||
    typeof candidate.section !== "function" ||
    typeof candidate.resolve !== "function" ||
    typeof candidate.commit !== "function"
  ) {
    throw new LlmConfigError(
      LLM_ERROR.UNSUPPORTED_RUNTIME,
      "official settings provider is missing the in-memory registration commit seam required to project shared LLM connections",
    );
  }
  return candidate as OfficialSettingsSeam;
}

function liveBridgeStatus(settings: HostSettings, snapshot: LlmSharedSnapshot): LlmBridgeStatus {
  if (typeof settings.bridgeStatus === "function") return settings.bridgeStatus();
  const seam = requireOfficialSettingsSeam(settings);
  const conflictRouteIds = collectManagedWritePaths(seam.section(LLM_PI_AI_NAMESPACE));
  return {
    source: snapshot.connections.length > 0 ? "spaces-shared" : "local-only",
    catalogRevision: snapshot.catalogRevision,
    policyRevision: snapshot.policyRevision,
    connectionRevisions: Object.fromEntries(snapshot.connections.map((item) => [item.id, item.revision])),
    adapterVersion: snapshot.adapterVersion,
    managedRouteConflict: conflictRouteIds.length > 0,
    conflictRouteIds,
  };
}

function projectExistingManaged(
  seam: OfficialSettingsSeam,
  snapshot: LlmSharedSnapshot,
  touched: TouchedRegistration[],
): void {
  for (const ns of MANAGED_NAMESPACES) {
    const registration = seam.registrations.get(ns);
    if (!registration) continue;
    if (typeof registration.schema !== "function") {
      throw new LlmConfigError(
        LLM_ERROR.UNSUPPORTED_RUNTIME,
        `official settings registration for ${ns} is missing a schema for in-memory projection`,
      );
    }
    if (ns === LLM_PI_AI_NAMESPACE) assertNoManagedUserSection(seam.section(ns));
    const originalBase = registration.base;
    rememberTouched(touched, ns, registration, originalBase);
    registration.base = sharedBaseForNamespace(ns, originalBase, snapshot);
    commitResolved(seam, registration, ns);
  }
}

function rememberTouched(
  touched: TouchedRegistration[],
  ns: string,
  registration: OfficialRegistration,
  originalBase: unknown,
): void {
  if (touched.some((item) => item.registration === registration)) return;
  touched.push({ ns, registration, originalBase });
}

function restoreTouched(seam: OfficialSettingsSeam, touched: readonly TouchedRegistration[]): void {
  for (const item of [...touched].reverse()) {
    if (seam.registrations.get(item.ns) !== item.registration) continue;
    item.registration.base = item.originalBase;
    commitResolved(seam, item.registration, item.ns);
  }
}

function commitResolved(seam: OfficialSettingsSeam, registration: OfficialRegistration, ns: string): void {
  const next = deepFreeze(
    seam.resolve(registration.schema, registration.base, seam.section(ns), registration.validate),
  );
  seam.commit(registration, next, "provider");
}

function installSettingsGuards(
  settings: OfficialSettingsSeam,
  snapshot: LlmSharedSnapshot,
  touched: TouchedRegistration[],
): () => void {
  const restorers: Array<() => void> = [];
  patchMethod(settings, "register", restorers, (original) =>
    function (this: OfficialSettingsSeam, ns: string, schema: unknown, options?: { base?: object }) {
      if (ns === LLM_PI_AI_NAMESPACE) assertNoManagedUserSection(settings.section(ns));
      const originalBase = options?.base;
      const result = original.apply(this, [ns, schema, withSharedBase(ns, options, snapshot)]);
      if (ns === LLM_PI_AI_NAMESPACE || ns === AGENT_DEFAULT_MODEL_NAMESPACE) {
        const registration = settings.registrations.get(ns);
        if (registration) rememberTouched(touched, ns, registration, originalBase);
      }
      return result;
    },
  );
  patchMethod(settings, "update", restorers, (original) =>
    function (this: OfficialSettingsSeam, ns: string, patch: object, expected?: number) {
      assertUserWrite(ns, patch);
      return original.apply(this, [ns, patch, expected]);
    },
  );
  patchMethod(settings, "replace", restorers, (original) =>
    function (this: OfficialSettingsSeam, ns: string, section: object, expected?: number) {
      assertUserWrite(ns, section);
      return original.apply(this, [ns, section, expected]);
    },
  );
  patchMethod(settings, "mutate", restorers, (original) =>
    function (this: OfficialSettingsSeam, ns: string, ops: readonly unknown[], expected?: number) {
      assertManagedMutate(ns, ops);
      return original.apply(this, [ns, ops, expected]);
    },
  );
  return () => {
    for (const restore of restorers.reverse()) restore();
  };
}

function patchMethod<K extends "register" | "update" | "replace" | "mutate">(
  target: OfficialSettingsSeam,
  name: K,
  restorers: Array<() => void>,
  wrap: (original: NonNullable<OfficialSettingsSeam[K]>) => NonNullable<OfficialSettingsSeam[K]>,
): void {
  const current = target[name];
  if (typeof current !== "function") return;
  const own = Object.prototype.hasOwnProperty.call(target, name);
  target[name] = wrap(current);
  restorers.push(() => {
    if (own) target[name] = current;
    else delete target[name];
  });
}

function withSharedBase(
  ns: string,
  options: { base?: object } | undefined,
  snapshot: LlmSharedSnapshot,
): { base?: object } | undefined {
  if (ns === LLM_PI_AI_NAMESPACE || ns === AGENT_DEFAULT_MODEL_NAMESPACE) {
    return { ...options, base: sharedBaseForNamespace(ns, options?.base, snapshot) };
  }
  return options;
}

function sharedBaseForNamespace(ns: string, base: unknown, snapshot: LlmSharedSnapshot): Record<string, unknown> {
  const record = asRecord(base);
  if (ns === LLM_PI_AI_NAMESPACE) return mergeSharedProvidersIntoBase(record, snapshot.connections);
  return mergeGlobalDefaultIntoBase(record, snapshot);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertUserWrite(ns: string, section: object): void {
  if (ns !== LLM_PI_AI_NAMESPACE) return;
  const routes = collectManagedWritePaths(section);
  if (routes.length > 0) throw sharedReadOnlyError(routes[0]);
}

function assertManagedMutate(ns: string, ops: readonly unknown[]): void {
  if (ns !== LLM_PI_AI_NAMESPACE) return;
  for (const op of ops) {
    if (!op || typeof op !== "object" || !("path" in op) || !Array.isArray(op.path)) continue;
    const path = op.path;
    const value = "value" in op ? op.value : undefined;
    if (path.length === 0) {
      if (value && typeof value === "object") assertUserWrite(ns, value as object);
      continue;
    }
    if (path[0] !== "providers") continue;
    if (path.length === 1) {
      if (value !== undefined) assertUserWrite(ns, { providers: value });
      continue;
    }
    if (typeof path[1] === "string" && isManagedRouteId(path[1])) {
      throw sharedReadOnlyError(path[1]);
    }
  }
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
