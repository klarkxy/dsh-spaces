import type { WorkbenchJob, WorkbenchJobStep } from "../../../shared/workbench";
import { isDeepStrictEqual } from "node:util";
import { ControlPublicError } from "../../../shared/control";
import { redactPublicReason } from "../../../shared/public-reason";
import { sanitizeLogText } from "../diagnostics/diagnostics";
import { currentDiagnosticLogger } from "../diagnostics/operation-log";
import type { WorkbenchJobContext } from "../maintenance/workbench-jobs";
import type { ChildRemoteClient } from "../supervisor/child-remote";
import { redactCredentials } from "../supervisor/ui-shared";
import {
  DEFAULT_MODEL_ROW,
  DEEPSEEK_ROW,
  PI_AI_ROW,
  describeModelSync,
  type MainModelSnapshot,
  type PreparedMainModelSync,
} from "./main-model-sync";

interface NamespaceView {
  ns: string;
  value?: unknown;
  revision: number;
}

interface SettingsView {
  writable: boolean;
  namespaces: NamespaceView[];
}

interface CredentialInfo {
  configured: boolean;
  writable: boolean;
}

type Step = WorkbenchJobStep & { name: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeReason(error: unknown, snapshot: MainModelSnapshot): string {
  const secrets = [
    ...Object.values(snapshot.refs),
    ...Object.values(snapshot.records).flatMap((row) => {
      const value = record(row);
      return [
        typeof value?.key === "string" ? value.key : "",
        ...Object.values(record(value?.env) ?? {}).filter((item): item is string => typeof item === "string"),
      ];
    }),
  ].filter(Boolean);
  try {
    const raw = error instanceof Error ? error.message : String(error ?? "");
    return redactCredentials(redactPublicReason(sanitizeLogText(raw)), secrets).slice(0, 500) || "The running space refused the model sync.";
  } catch {
    return "The running space refused the model sync.";
  }
}

function settingsView(value: unknown): SettingsView {
  const root = record(value);
  if (!root || typeof root.writable !== "boolean" || !Array.isArray(root.namespaces)) {
    throw new ControlPublicError("control/failed", "settings/describe returned a malformed result.");
  }
  const namespaces = root.namespaces.map((candidate) => {
    const row = record(candidate);
    if (!row || typeof row.ns !== "string" || typeof row.revision !== "number") {
      throw new ControlPublicError("control/failed", "settings/describe returned a malformed namespace.");
    }
    return { ns: row.ns, value: row.value, revision: row.revision };
  });
  return { writable: root.writable, namespaces };
}

function credentialsView(value: unknown): Record<string, CredentialInfo> {
  const root = record(value);
  if (!root) throw new ControlPublicError("control/failed", "credentials/describe returned a malformed result.");
  return Object.fromEntries(Object.entries(root).map(([ref, candidate]) => {
    const row = record(candidate);
    if (!row || typeof row.configured !== "boolean" || typeof row.writable !== "boolean") {
      throw new ControlPublicError("control/failed", `credentials/describe returned malformed information for ${ref}.`);
    }
    return [ref, { configured: row.configured, writable: row.writable }];
  }));
}

function namespaceOf(settings: SettingsView, ...candidates: string[]): NamespaceView {
  for (const candidate of candidates) {
    const found = settings.namespaces.find((row) => row.ns === candidate);
    if (found) return found;
  }
  throw new ControlPublicError(
    "control/unavailable",
    `The running space has no configurable model namespace ${candidates.join(" or ")}. No model settings were written.`,
  );
}

function matchesWrittenFields(actual: unknown, expected: unknown): boolean {
  const fields = record(expected);
  if (!fields) return isDeepStrictEqual(actual, expected);
  const received = record(actual);
  return Boolean(received) && Object.entries(fields).every(([key, value]) =>
    Object.hasOwn(received!, key) && matchesWrittenFields(received![key], value));
}

function verifySettings(view: SettingsView, ns: string, snapshot: MainModelSnapshot): void {
  const current = namespaceOf(view, ns);
  if (ns === PI_AI_ROW) {
    const providers = record(record(current.value)?.providers);
    for (const route of Object.keys(snapshot.providers)) {
      if (!providers || !Object.hasOwn(providers, route) || !matchesWrittenFields(providers[route], snapshot.providers[route])) {
        throw new ControlPublicError("control/failed", `The running space did not read back model route ${route}.`);
      }
    }
    return;
  }
  if (ns === DEFAULT_MODEL_ROW) {
    const expected = snapshot.defaultModel;
    const value = record(current.value);
    if (!expected || value?.provider !== expected.provider || value.model !== expected.model ||
        (expected.reasoningEffort !== undefined && value.reasoningEffort !== expected.reasoningEffort)) {
      throw new ControlPublicError("control/failed", "The running space did not read back the default model selection.");
    }
    return;
  }
  for (const key of Object.keys(snapshot.deepseekConfig ?? {})) {
    if (!matchesWrittenFields(record(current.value)?.[key], snapshot.deepseekConfig?.[key])) {
      throw new ControlPublicError("control/failed", `The running space did not read back DeepSeek setting ${key}.`);
    }
  }
}

/**
 * Apply one approved snapshot through the running child's own settings and
 * credentials controllers. The snapshot and Key values remain in memory;
 * public steps and errors contain only names and redacted reasons.
 */
export async function runLiveModelSync(
  client: ChildRemoteClient,
  prepared: PreparedMainModelSync,
  spaceId: string,
  ctx: WorkbenchJobContext,
): Promise<WorkbenchJob["result"]> {
  const log = currentDiagnosticLogger();
  const { snapshot } = prepared;
  const steps: Step[] = [
    ...Object.keys(snapshot.refs).map((ref) => ({ step: `credential:${ref}`, name: `credential:${ref}`, status: "not-run" as const })),
    ...(Object.keys(snapshot.providers).length ? [{ step: `settings:${PI_AI_ROW}`, name: `settings:${PI_AI_ROW}`, status: "not-run" as const }] : []),
    ...(snapshot.deepseekConfig ? [{ step: `settings:${DEEPSEEK_ROW}`, name: `settings:${DEEPSEEK_ROW}`, status: "not-run" as const }] : []),
    ...(snapshot.defaultModel ? [{ step: `settings:${DEFAULT_MODEL_ROW}`, name: `settings:${DEFAULT_MODEL_ROW}`, status: "not-run" as const }] : []),
  ];
  if (steps.length > 64) {
    throw new ControlPublicError("control/invalid-input", "The model sync has too many entries to report individually. Sync while the space is stopped.");
  }
  const publish = () => ctx.result({ spaceId, steps: steps.map(({ name: _name, ...step }) => ({ ...step })) });
  let current: Step | undefined;
  ctx.cancellable(false);
  ctx.phase("models-sync");
  try {
    if (Object.keys(snapshot.records).length) {
      throw new ControlPublicError(
        "control/unsupported",
        "The main space has provider credential records that the running settings API cannot copy. Stop the space and sync while stopped.",
      );
    }
    const settings = settingsView(await client.call("settings/describe", {}, ctx.signal));
    if (!settings.writable) throw new ControlPublicError("control/unavailable", "The running space's model settings are read-only.");
    const namespaces = new Map<string, NamespaceView>();
    if (Object.keys(snapshot.providers).length) namespaces.set(PI_AI_ROW, namespaceOf(settings, PI_AI_ROW));
    if (snapshot.deepseekConfig) namespaces.set(DEEPSEEK_ROW, namespaceOf(settings, DEEPSEEK_ROW, "llm-deepseek-api-key"));
    if (snapshot.defaultModel) namespaces.set(DEFAULT_MODEL_ROW, namespaceOf(settings, DEFAULT_MODEL_ROW));
    log?.info("models.live-preflight", "The running-space model settings preflight completed.", { space: spaceId, namespaces: [...namespaces.keys()].join(","), writable: settings.writable });
    const refs = Object.keys(snapshot.refs);
    if (refs.length) {
      const before = credentialsView(await client.call("credentials/describe", { refs }, ctx.signal));
      for (const ref of refs) {
        if (before[ref]?.writable !== true) {
          throw new ControlPublicError("control/unavailable", `The running space cannot write credential ${ref}. No model settings were written.`);
        }
      }
    }
    for (const step of steps) {
      current = step;
      ctx.message(`Writing ${step.name} inside the running space.`);
      if (step.name.startsWith("credential:")) {
        const ref = step.name.slice("credential:".length);
        const value = snapshot.refs[ref];
        if (value === undefined) throw new ControlPublicError("control/failed", `Credential ${ref} is absent from the prepared snapshot.`);
        await client.call("credentials/set", { ref, value }, ctx.signal);
        const readback = credentialsView(await client.call("credentials/describe", { refs: [ref] }, ctx.signal));
        if (readback[ref]?.configured !== true) {
          throw new ControlPublicError("control/failed", `Credential ${ref} was not read back as configured.`);
        }
      } else {
        const ns = step.name.slice("settings:".length);
        const before = namespaces.get(ns);
        if (!before) throw new ControlPublicError("control/failed", `The namespace ${ns} was not prepared.`);
        if (ns === PI_AI_ROW) {
          // Replace each selected route in one atomic settings edit. A deep
          // merge would retain stale per-route headers or model mappings.
          await client.call("settings/mutate", {
            ns,
            ops: Object.entries(snapshot.providers).map(([route, value]) => ({ op: "set", path: ["providers", route], value })),
            expectedRevision: before.revision,
          }, ctx.signal);
        } else if (ns === DEEPSEEK_ROW) {
          const actual = before.ns;
          await client.call("settings/update", { ns: actual, patch: snapshot.deepseekConfig ?? {}, expectedRevision: before.revision }, ctx.signal);
        } else {
          const selection = snapshot.defaultModel;
          if (!selection) throw new ControlPublicError("control/failed", "The default model is absent from the prepared snapshot.");
          await client.call("settings/replace", { ns, section: selection, expectedRevision: before.revision }, ctx.signal);
        }
        const readback = settingsView(await client.call("settings/describe", {}, ctx.signal));
        const actual = ns === DEEPSEEK_ROW ? before.ns : ns;
        verifySettings(readback, actual, snapshot);
      }
      step.status = "done";
      publish();
      log?.info("models.live-step", "A running-space model sync step was written and verified.", { space: spaceId, step: step.name });
    }
    ctx.message(describeModelSync(prepared.summary));
    return { spaceId, steps: steps.map(({ name: _name, ...step }) => ({ ...step })) };
  } catch (error) {
    if (current) current.status = "failed";
    publish();
    const reason = safeReason(error, snapshot);
    const written = steps.filter((step) => step.status === "done").map((step) => step.name);
    const unwritten = steps.filter((step) => step.status !== "done").map((step) => step.name);
    const message = `Model sync failed at ${current?.name ?? "preflight"}; written: ${written.join(", ") || "none"}; not written: ${unwritten.join(", ") || "none"}; reason: ${reason}`;
    ctx.message(message);
    log?.error("models.live-failed", "Running-space model synchronization failed; no further writes are attempted.", new Error(reason), { space: spaceId, step: current?.name ?? "preflight", written: written.join(","), notWritten: unwritten.join(",") });
    throw new ControlPublicError(error instanceof ControlPublicError ? error.code : "control/failed", message);
  }
}
