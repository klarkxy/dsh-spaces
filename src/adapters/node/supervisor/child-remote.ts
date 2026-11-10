/**
 * ChildRemoteClient: the Supervisor-side unary caller for a running child
 * space's official `/api` Remote surface (path B in
 * docs/space-control-extensions.md). The child's own `pluginManager`
 * writes its profile under the official manifest lock and applies changes
 * through its declared reload lifecycle; the Supervisor never writes a
 * live profile itself.
 *
 * Wire contract, verified against DSH 0.2.2-rc.1 sources:
 *   POST http://127.0.0.1:<port>/api/<namespace>/<method>
 *   headers: content-type: application/json, origin: http://127.0.0.1:<port>,
 *            cookie: <dsh-auth-* session cookie>, connection: close
 *   body:    { type: 'client-request', rpcId, method: '<namespace>/<method>',
 *              payload: { args: { <named wire args> } } }
 *   reply:   { type: 'server-response', rpcId, result:
 *              { ok: true, value } | { ok: false, error: {code,message,details} } }
 * (node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:888-969,
 *  dsh-api-gateway/lib/index.js:907-914,1191-1254,1491-1504;
 *  args wire names: dsh-plugin-manager/lib/typert.remote-client.js)
 *
 * Every call re-exchanges the launch URL for a fresh session cookie held
 * only in memory — no retry, no reconnect, no second exchange — and the
 * cookie, the launch token and the child origin never reach return values,
 * job records or error text (each secret is redacted like the UI session).
 * A non-JSON response, an envelope that does not match the contract, or an
 * endpoint outside the closed whitelist fails honestly.
 */
import { randomUUID } from "node:crypto";
import {
  CONTROL_LIVE_PLUGIN_LIMIT,
  ControlPublicError,
  type ControlInspectLive,
} from "../../../shared/control";
import type { WorkbenchJob, WorkbenchPlanRequest } from "../../../shared/workbench";
import { parsePluginSource, PluginSourceError } from "../../../shared/plugin-source";
import { PROTECTED_PLUGIN_PACKAGES } from "../../../shared/types";
import { FULL_SPACES_PACKAGE, isFullSpacesManagerSpec } from "../../../shared/plugin-spec";
import { installSpecFor, parseGitDependencySource } from "../products/plugin-exact-source";
import { dshSessionCookie } from "../runtime/dsh-endpoint";
import { redactCredentials } from "./ui-shared";
import { redactPublicReason } from "../../../shared/public-reason";
import { sanitizeLogText } from "../diagnostics/diagnostics";
import type { WorkbenchJobContext } from "../maintenance/workbench-jobs";

const REMOTE_REQUEST_MAX_BYTES = 64 * 1024;
const REMOTE_RESPONSE_MAX_BYTES = 512 * 1024;
const REMOTE_CALL_TIMEOUT_MS = 60_000;
const REMOTE_MUTATE_TIMEOUT_MS = 10 * 60_000;
const COOKIE_EXCHANGE_TIMEOUT_MS = 15_000;

const STRING_FIELD_MAX = 512;

/** Closed pluginManager whitelist; nothing else is ever dispatched. */
type PluginManagerMethod =
  | "pluginManager/listPlugins"
  | "pluginManager/listBundles"
  | "pluginManager/listVersions"
  | "pluginManager/registries"
  | "pluginManager/inspect"
  | "pluginManager/readBundleDetail"
  | "pluginManager/listVersionExemptions"
  | "pluginManager/installBundle"
  | "pluginManager/waitForInstall"
  | "pluginManager/updateBundle"
  | "pluginManager/removeBundle"
  | "pluginManager/setPluginEnabled";

type RemoteMethod = PluginManagerMethod;

const REMOTE_METHODS = new Set<RemoteMethod>([
  "pluginManager/listPlugins",
  "pluginManager/listBundles",
  "pluginManager/listVersions",
  "pluginManager/registries",
  "pluginManager/inspect",
  "pluginManager/readBundleDetail",
  "pluginManager/listVersionExemptions",
  "pluginManager/installBundle",
  "pluginManager/waitForInstall",
  "pluginManager/updateBundle",
  "pluginManager/removeBundle",
  "pluginManager/setPluginEnabled",
]);

/** Exact args fields each endpoint may carry — extras are refused locally. */
const ARGS_FIELDS: Record<RemoteMethod, readonly string[]> = {
  "pluginManager/listPlugins": [],
  "pluginManager/listBundles": [],
  "pluginManager/listVersions": ["name", "options"],
  "pluginManager/registries": [],
  "pluginManager/inspect": ["spec", "options"],
  "pluginManager/readBundleDetail": ["name", "language", "options"],
  "pluginManager/listVersionExemptions": [],
  "pluginManager/installBundle": ["spec", "options"],
  "pluginManager/waitForInstall": ["requestId"],
  "pluginManager/updateBundle": ["name", "version", "options"],
  "pluginManager/removeBundle": ["name"],
  "pluginManager/setPluginEnabled": ["id", "enabled"],
};

/** Packages that may never be changed through the child's own manager. */
const LIVE_PROTECTED_PACKAGES = new Set<string>([
  ...PROTECTED_PLUGIN_PACKAGES,
  FULL_SPACES_PACKAGE,
  "@dsh-spaces/view-bridge",
  "@klarkxy/dsh-dev-index",
]);

/** A package or any module specifier below it (subpath entries). */
function isLiveProtectedModule(moduleName: string): boolean {
  const value = moduleName.trim().toLowerCase();
  if (!value) return true;
  if (isFullSpacesManagerSpec(value)) return true;
  for (const name of LIVE_PROTECTED_PACKAGES) {
    if (value === name.toLowerCase() || value.startsWith(`${name.toLowerCase()}/`)) return true;
  }
  return false;
}

export interface ChildRemotePorts {
  statusOf(id: string): "running" | "starting" | "stopping" | "stopped" | "crashed" | "unknown";
  generationOf(id: string): number;
  /** The supervisor-owned child record; absent when the child is foreign. */
  spawned(id: string): boolean;
  urlOf(id: string): string | undefined;
  portOf(id: string): number | undefined;
  currentServiceEpoch(): string;
  fetch: typeof fetch;
}

/** Raw remote rows, kept structural so tests need no official types. */
interface LivePluginRow {
  entryId: string;
  moduleName: string;
  enabled: boolean;
  fiberPhase?: "pending" | "loading" | "active" | "failed" | "unloading" | null;
  diagnostic?: string;
  patchId?: string;
  readOnlyReason?: string;
  [key: string]: unknown;
}

interface LiveBundleRow {
  name: string;
  enabled: boolean;
  installed: boolean;
  version?: string;
  official?: boolean;
  updatable?: boolean;
  removable?: boolean;
  source?: string;
  error?: { code?: string; diagnostic?: string };
  [key: string]: unknown;
}

interface RemoteChangeResult {
  changed?: boolean;
  application?: string;
  restartReason?: string;
  stage?: string;
  target?: string;
  enabled?: boolean;
  error?: { code?: string; diagnostic?: string };
  warnings?: string[];
  pendingBuilds?: string[];
  approvedBuilds?: string[];
  bundle?: string;
  version?: string;
  failedAt?: string;
  [key: string]: unknown;
}

interface RemoteUpdateResult {
  from?: string;
  to?: string;
  step?: string;
  result?: RemoteChangeResult;
  restore?: RemoteChangeResult;
}

export class ChildRemoteClient {
  constructor(
    private readonly ports: ChildRemotePorts,
    private readonly spaceId: string,
    private readonly generation: number,
    private readonly serviceEpoch: string,
  ) {}

  /** The child must still be the same owned, running generation of this epoch. */
  private requireRunning(): void {
    if (this.ports.currentServiceEpoch() !== this.serviceEpoch ||
        this.ports.statusOf(this.spaceId) !== "running" ||
        this.ports.generationOf(this.spaceId) !== this.generation ||
        !this.ports.spawned(this.spaceId)) {
      throw new ControlPublicError(
        "control/not-running",
        `The space ${this.spaceId} is not the running generation this request was authorized for.`,
      );
    }
  }

  /** One fresh session cookie per call; a failed exchange is terminal. */
  private async session(signal: AbortSignal): Promise<{ port: number; cookie: string; secrets: string[] }> {
    this.requireRunning();
    const launch = this.ports.urlOf(this.spaceId);
    const port = this.ports.portOf(this.spaceId);
    if (!launch || !port) {
      throw new ControlPublicError("control/unavailable", "The child endpoint is not available for this space.");
    }
    let cookie: string | undefined;
    try {
      cookie = await dshSessionCookie(launch, this.ports.fetch, signal);
    } catch (error) {
      throw new ControlPublicError("control/unavailable", this.safeReason(error, "The child authentication exchange failed."));
    }
    if (!cookie) {
      throw new ControlPublicError("control/unavailable", "The child authentication exchange produced no session cookie.");
    }
    const token = (() => { try { return new URL(launch).searchParams.get("token") ?? ""; } catch { return ""; } })();
    const separator = cookie.indexOf("=");
    const cookieValue = separator > 0 ? cookie.slice(separator + 1) : "";
    return { port, cookie, secrets: [cookieValue, token] };
  }

  private safeReason(error: unknown, fallback: string, secrets: readonly string[] = []): string {
    try {
      const raw = error instanceof Error ? error.message : String(error ?? "");
      const cleaned = redactCredentials(redactPublicReason(sanitizeLogText(raw)), secrets);
      return cleaned || fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * One unary Remote call against the child's `/api`. The endpoint is a
   * closed whitelist; the args carry only the declared fields of that
   * endpoint and the response must be the server-response envelope inside
   * the byte caps. An `ok:false` result is a gateway/business failure and
   * is reported with its own code and sanitized message — never retried.
   */
  async call(method: RemoteMethod, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!REMOTE_METHODS.has(method)) {
      throw new ControlPublicError("control/unsupported", `The remote method ${method} is not in the control whitelist.`);
    }
    const allowed = ARGS_FIELDS[method];
    for (const key of Object.keys(args)) {
      if (!allowed.includes(key)) {
        throw new ControlPublicError("control/invalid-input", `Remote method ${method} takes no argument "${key}".`);
      }
    }
    const payload = { args };
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > REMOTE_REQUEST_MAX_BYTES) {
      throw new ControlPublicError("control/invalid-input", "The remote request exceeds the byte limit.");
    }
    const timeoutMs = method === "pluginManager/installBundle" || method === "pluginManager/updateBundle"
      ? REMOTE_MUTATE_TIMEOUT_MS
      : REMOTE_CALL_TIMEOUT_MS;
    const exchangeSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(COOKIE_EXCHANGE_TIMEOUT_MS)])
      : AbortSignal.timeout(COOKIE_EXCHANGE_TIMEOUT_MS);
    const session = await this.session(exchangeSignal);
    this.requireRunning();
    const rpcId = randomUUID();
    const callSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const origin = `http://127.0.0.1:${session.port}`;
    let response: Response;
    try {
      response = await this.ports.fetch(`${origin}/api/${method}`, {
        method: "POST",
        redirect: "error",
        signal: callSignal,
        headers: {
          "content-type": "application/json",
          origin,
          connection: "close",
          cookie: session.cookie,
        },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      });
    } catch (error) {
      throw new ControlPublicError("control/unavailable", this.safeReason(error, "The child request failed.", session.secrets));
    }
    if (response.status === 401 || response.status === 403) {
      throw new ControlPublicError("control/unavailable", `The child refused the request (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new ControlPublicError("control/unavailable", `The child request failed (HTTP ${response.status}).`);
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ControlPublicError("control/failed", "The child returned a non-JSON response.");
    }
    const text = await this.readBounded(response, session.secrets);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ControlPublicError("control/failed", "The child returned a malformed response.");
    }
    const row = parsed as {
      type?: unknown; rpcId?: unknown;
      result?: { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown; details?: unknown } };
    };
    // A failure envelope is surfaced even on a mismatched rpcId: the call
    // failed either way, and the remote's own reason is more honest than a
    // generic envelope error. A success value is only accepted on the
    // request's own rpcId.
    const result = row && typeof row === "object" ? row.result : undefined;
    if (row && typeof row === "object" && row.type === "server-response" &&
        result && typeof result === "object" && result.ok === false) {
      const code = typeof result.error?.code === "string" ? result.error.code : "gateway/internal";
      const message = typeof result.error?.message === "string" ? result.error.message : "";
      throw new ControlPublicError(
        "control/failed",
        this.safeReason(`${code}: ${message}`, "The child remote call failed.", session.secrets).slice(0, 500),
      );
    }
    if (!row || typeof row !== "object" || row.type !== "server-response" ||
        typeof row.rpcId !== "string" || row.rpcId !== rpcId ||
        !result || typeof result !== "object" || result.ok !== true) {
      throw new ControlPublicError("control/failed", "The child returned an unexpected response envelope.");
    }
    if (Buffer.byteLength(JSON.stringify(result.value), "utf8") > REMOTE_RESPONSE_MAX_BYTES) {
      throw new ControlPublicError("control/failed", "The child response exceeds the byte limit.");
    }
    return result.value;
  }

  private async readBounded(response: Response, secrets: readonly string[]): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > REMOTE_RESPONSE_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new ControlPublicError("control/failed", "The child response exceeds the byte limit.");
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof ControlPublicError) throw error;
      throw new ControlPublicError("control/unavailable", this.safeReason(error, "The child response could not be read.", secrets));
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

/* ---------------------------------------------------------------------------
 * Live view + live ops runner. Both go through the serialized control job
 * lane or the read path of SupervisorControl; the client re-checks the
 * (spaceId, generation, epoch) binding before every exchange.
 * ------------------------------------------------------------------------ */

function trimText(value: unknown, max = STRING_FIELD_MAX): string | undefined {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

function livePluginRow(row: LivePluginRow): ControlInspectLive["plugins"][number] {
  return {
    entryId: String(row.entryId ?? ""),
    moduleName: trimText(row.moduleName, 300) ?? "",
    enabled: row.enabled === true,
    fiberPhase: row.fiberPhase ?? null,
    ...(trimText(row.diagnostic) ? { diagnostic: trimText(row.diagnostic)! } : {}),
    ...(trimText(row.patchId) ? { patchId: trimText(row.patchId)! } : {}),
    ...(trimText(row.readOnlyReason) ? { readOnlyReason: trimText(row.readOnlyReason)! } : {}),
  };
}

function liveBundleRow(row: LiveBundleRow): ControlInspectLive["bundles"][number] {
  return {
    name: trimText(row.name, 214) ?? "",
    version: trimText(row.version, 64),
    enabled: row.enabled === true,
    installed: row.installed === true,
    ...(typeof row.official === "boolean" ? { official: row.official } : {}),
    ...(typeof row.updatable === "boolean" ? { updatable: row.updatable } : {}),
    ...(trimText(row.source, 300) ? { source: trimText(row.source, 300)! } : {}),
    ...(row.error && typeof row.error === "object" && typeof row.error.code === "string"
      ? { error: { code: String(row.error.code).slice(0, 80), ...(trimText(row.error.diagnostic) ? { diagnostic: trimText(row.error.diagnostic)! } : {}) } }
      : {}),
  };
}

function isLivePluginRow(value: unknown): value is LivePluginRow {
  const row = value as LivePluginRow;
  return !!row && typeof row === "object" && typeof row.entryId === "string" && typeof row.moduleName === "string";
}

function isLiveBundleRow(value: unknown): value is LiveBundleRow {
  const row = value as LiveBundleRow;
  return !!row && typeof row === "object" && typeof row.name === "string";
}

/**
 * Read the running child's runtime plugin view: `pluginManager/listPlugins`
 * gives Loader entries in load order and `pluginManager/listBundles` the
 * manifest's `dsh.profile.bundles` rows in declaration order — the two
 * @Remote surfaces the 0.2.2-rc.1 runtime confirmed mounted. A space that
 * is not running answers control/not-running; a remote failure surfaces
 * as that failure, never as an empty or substituted list.
 */
export async function readLivePluginView(client: ChildRemoteClient): Promise<ControlInspectLive> {
  const pluginValue = await client.call("pluginManager/listPlugins", {});
  if (!Array.isArray(pluginValue)) {
    throw new ControlPublicError("control/failed", "pluginManager/listPlugins returned a malformed result.");
  }
  const pluginRows = pluginValue.filter(isLivePluginRow);
  const bundleRows = await client.call("pluginManager/listBundles", {});
  if (!Array.isArray(bundleRows)) {
    throw new ControlPublicError("control/failed", "pluginManager/listBundles returned a malformed result.");
  }
  const bundles = bundleRows.filter(isLiveBundleRow);
  const truncated = pluginRows.length > CONTROL_LIVE_PLUGIN_LIMIT || bundles.length > CONTROL_LIVE_PLUGIN_LIMIT;
  return {
    running: true,
    plugins: pluginRows.slice(0, CONTROL_LIVE_PLUGIN_LIMIT).map(livePluginRow),
    bundles: bundles.slice(0, CONTROL_LIVE_PLUGIN_LIMIT).map(liveBundleRow),
    truncated,
  };
}

function asChangeResult(value: unknown, what: string): RemoteChangeResult {
  const row = value as RemoteChangeResult;
  if (!row || typeof row !== "object" || typeof row.changed !== "boolean" || typeof row.application !== "string") {
    throw new ControlPublicError("control/failed", `${what} returned a malformed result.`);
  }
  return row;
}

function assertNoProtectedPackage(name: string): void {
  if (isLiveProtectedModule(name)) {
    throw new ControlPublicError("control/protected", `The package ${name} cannot be changed through the child plugin manager.`);
  }
}

function managementReason(change: RemoteChangeResult): string {
  const code = change.error?.code ? ` (${change.error.code})` : "";
  const diagnostic = change.error?.diagnostic ? `: ${trimText(change.error.diagnostic)}` : "";
  return `The child plugin manager reported application=${change.application ?? "?"}${code}${diagnostic}`;
}

/** The four supervisor-local live plan kinds; anything else is refused. */
export type LivePlanRequest = Extract<
  WorkbenchPlanRequest,
  { kind: 'plugin.live.install' | 'plugin.live.update' | 'plugin.live.entry' | 'plugin.live.remove' }
>;

/**
 * Run one frozen `plugin.live.*` plan inside the serialized control job.
 * Steps: official method → optional waitForInstall settlement → read-back
 * verification. A read-back mismatch fails honestly; nothing is rolled
 * back and no second install is attempted.
 */
export async function runLivePlan(
  client: ChildRemoteClient,
  request: LivePlanRequest,
  ctx: WorkbenchJobContext,
): Promise<WorkbenchJob["result"] | void> {
  const steps: Array<{ step: string; status: "done" | "failed" | "not-run"; packageName?: string; detail?: string }> = [];
  const signal = ctx.signal;
  const spaceId = request.spaceId;
  switch (request.kind) {
    case "plugin.live.install": {
      let plugin;
      try {
        plugin = parsePluginSource(request.source);
      } catch (error) {
        if (error instanceof PluginSourceError) {
          throw new ControlPublicError("control/invalid-input", error.message);
        }
        throw error;
      }
      assertNoProtectedPackage(plugin.packageName);
      const spec = installSpecFor(plugin);
      const requestId = `control-${randomUUID()}`;
      ctx.phase("install");
      ctx.cancellable(false);
      ctx.message(`Installing ${plugin.packageName} inside ${spaceId} through its own plugin manager.`);
      const options: Record<string, unknown> = {
        saveExact: true,
        requestId,
        ...(plugin.approvedBuilds.length ? { approvedBuilds: [...plugin.approvedBuilds] } : {}),
      };
      let change = asChangeResult(
        await client.call("pluginManager/installBundle", { spec, options }, signal),
        "installBundle",
      );
      {
        // Settle the same request through the official two-step protocol:
        // a retained outcome replaces the call's answer, while a null wait
        // (already settled) does not overturn it — null carries no verdict.
        const settled = await client.call("pluginManager/waitForInstall", { requestId }, signal);
        if (settled !== null && settled !== undefined) {
          change = asChangeResult(settled, "waitForInstall");
        }
      }
      steps.push({
        step: "install",
        status: change.error || change.application === "failed" || change.application === "cancelled" ? "failed" : "done",
        packageName: plugin.packageName,
        detail: `application=${change.application ?? "?"}`,
      });
      if (Array.isArray(change.pendingBuilds) && change.pendingBuilds.length) {
        const pending = change.pendingBuilds.filter((k): k is string => typeof k === "string").slice(0, 32);
        throw new ControlPublicError(
          "control/failed",
          `The install reported build scripts awaiting approval: ${pending.join(", ")}. Plan plugin.live.install again with those exact keys in approvedBuilds.`,
        );
      }
      if (change.error || change.application === "failed" || change.application === "cancelled" ||
          (change.changed !== true)) {
        throw new ControlPublicError("control/failed", `The install did not apply: ${managementReason(change)}`);
      }
      ctx.phase("verify");
      const bundles = await listInstalledBundles(client);
      const row = bundles.find((item) => item.name.toLowerCase() === plugin.packageName.toLowerCase());
      if (!row || row.installed !== true) {
        throw new ControlPublicError(
          "control/failed",
          `Plugin ${plugin.packageName} was not read back as installed after the live install.`,
        );
      }
      if (plugin.kind === "npm" && row.version !== plugin.version) {
        throw new ControlPublicError(
          "control/failed",
          `Plugin ${plugin.packageName} read back version ${row.version ?? "?"} instead of ${plugin.version}.`,
        );
      }
      if (plugin.kind === "github") {
        const declared = parseGitDependencySource(row.source ?? "");
        const expectedRepo = `${plugin.owner}/${plugin.repo}`;
        const expectedPath = plugin.path ? `/${plugin.path}` : undefined;
        if (!declared || declared.repo !== expectedRepo || declared.commit !== plugin.commit || declared.path !== expectedPath) {
          throw new ControlPublicError(
            "control/failed",
            `Plugin ${plugin.packageName} was not read back from the pinned source ${expectedRepo}${expectedPath ?? ""}#${plugin.commit}.`,
          );
        }
      }
      steps.push({ step: "verify", status: "done", packageName: plugin.packageName });
      ctx.message(`Installed ${plugin.packageName}${plugin.kind === "npm" ? `@${plugin.version}` : ""} in ${spaceId} (application=${change.application ?? "?"}).`);
      return { spaceId, steps };
    }
    case "plugin.live.update": {
      const packageName = request.packageName;
      const version = request.version;
      assertNoProtectedPackage(packageName);
      const requestId = `control-${randomUUID()}`;
      ctx.phase("update");
      ctx.cancellable(false);
      ctx.message(`Updating ${packageName} to ${version} inside ${spaceId} through its own plugin manager.`);
      const updated = await client.call("pluginManager/updateBundle", { name: packageName, version, options: { requestId } }, signal);
      const outcome = updated as RemoteUpdateResult;
      const change = outcome?.result;
      if (!outcome || typeof outcome !== "object" || !change || typeof change !== "object") {
        throw new ControlPublicError("control/failed", "updateBundle returned a malformed result.");
      }
      const failed =
        change.error ||
        outcome.restore !== undefined ||
        change.application === "failed" || change.application === "cancelled" ||
        outcome.step !== "install" ||
        change.changed !== true;
      steps.push({
        step: outcome.step === "check" ? "update-check" : "update",
        status: failed ? "failed" : "done",
        packageName,
        detail: outcome.restore ? `restored: ${managementReason(outcome.restore as RemoteChangeResult)}` : `application=${change.application ?? "?"}`,
      });
      if (failed) {
        throw new ControlPublicError(
          "control/failed",
          `The update did not apply (step=${outcome.step ?? "?"}): ${managementReason(change)}${outcome.restore ? "; the child reinstalled the previous version." : ""}`,
        );
      }
      ctx.phase("verify");
      const bundles = await listInstalledBundles(client);
      const row = bundles.find((item) => item.name.toLowerCase() === packageName.toLowerCase());
      if (!row || row.installed !== true || row.version !== version) {
        throw new ControlPublicError(
          "control/failed",
          `Plugin ${packageName} read back version ${row?.version ?? "?"} instead of ${version}.`,
        );
      }
      steps.push({ step: "verify", status: "done", packageName });
      ctx.message(`Updated ${packageName} to ${version} in ${spaceId} (application=${change.application ?? "?"}).`);
      return { spaceId, steps };
    }
    case "plugin.live.entry": {
      const entryId = request.entryId;
      const enabled = request.enabled;
      const plugins = await listLivePlugins(client);
      const row = plugins.find((item) => item.entryId === entryId);
      if (!row) {
        throw new ControlPublicError("control/not-found", `No loader entry ${entryId} was reported by the running space.`);
      }
      if (isLiveProtectedModule(row.moduleName)) {
        throw new ControlPublicError("control/protected", `The entry ${entryId} (${row.moduleName}) cannot be changed through this channel.`);
      }
      ctx.phase(enabled ? "enable" : "disable");
      ctx.cancellable(false);
      ctx.message(`${enabled ? "Enabling" : "Disabling"} ${row.moduleName} (${entryId}) inside ${spaceId}.`);
      const change = asChangeResult(
        await client.call("pluginManager/setPluginEnabled", { id: entryId, enabled }, signal),
        "setPluginEnabled",
      );
      steps.push({
        step: enabled ? "enable" : "disable",
        status: change.error || change.application === "failed" ? "failed" : "done",
        packageName: row.moduleName,
        detail: `application=${change.application ?? "?"}`,
      });
      if (change.error || change.application === "failed" || change.changed !== true) {
        throw new ControlPublicError("control/failed", `The entry change did not apply: ${managementReason(change)}`);
      }
      ctx.phase("verify");
      const after = await listLivePlugins(client);
      const readBack = after.find((item) => item.entryId === entryId);
      if (!readBack) {
        throw new ControlPublicError("control/failed", `The entry ${entryId} no longer appears in the plugin inventory.`);
      }
      if (change.application === "applied" && readBack.enabled !== enabled) {
        throw new ControlPublicError(
          "control/failed",
          `The entry ${entryId} reads back enabled=${readBack.enabled} after an applied change to ${enabled}.`,
        );
      }
      steps.push({ step: "verify", status: "done", packageName: row.moduleName });
      ctx.message(`${enabled ? "Enabled" : "Disabled"} ${row.moduleName} (${entryId}) in ${spaceId} (application=${change.application ?? "?"}).`);
      return { spaceId, steps };
    }
    case "plugin.live.remove": {
      const packageName = request.packageName;
      assertNoProtectedPackage(packageName);
      ctx.phase("remove");
      ctx.cancellable(false);
      ctx.message(`Removing ${packageName} inside ${spaceId} through its own plugin manager.`);
      const change = asChangeResult(
        await client.call("pluginManager/removeBundle", { name: packageName }, signal),
        "removeBundle",
      );
      steps.push({
        step: "remove",
        status: change.error || change.application === "failed" ? "failed" : "done",
        packageName,
        detail: `application=${change.application ?? "?"}`,
      });
      if (change.error || change.application === "failed" || change.changed !== true) {
        throw new ControlPublicError("control/failed", `The removal did not apply: ${managementReason(change)}`);
      }
      ctx.phase("verify");
      const bundles = await listInstalledBundles(client);
      const still = bundles.find((item) => item.name.toLowerCase() === packageName.toLowerCase());
      if (still && still.installed === true) {
        throw new ControlPublicError(
          "control/failed",
          `Plugin ${packageName} is still installed after the live removal.`,
        );
      }
      steps.push({ step: "verify", status: "done", packageName });
      ctx.message(`Removed ${packageName} from ${spaceId} (application=${change.application ?? "?"}).`);
      return { spaceId, steps };
    }
  }
}

async function listLivePlugins(client: ChildRemoteClient): Promise<LivePluginRow[]> {
  const rows = await client.call("pluginManager/listPlugins", {});
  if (!Array.isArray(rows)) throw new ControlPublicError("control/failed", "pluginManager/listPlugins returned a malformed result.");
  return rows.filter(isLivePluginRow);
}

async function listInstalledBundles(client: ChildRemoteClient): Promise<LiveBundleRow[]> {
  const rows = await client.call("pluginManager/listBundles", {});
  if (!Array.isArray(rows)) throw new ControlPublicError("control/failed", "pluginManager/listBundles returned a malformed result.");
  return rows.filter(isLiveBundleRow).filter((row) => row.installed === true || row.enabled === true || row.source !== undefined);
}
