import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { lstatSync } from "../../../shared/node/filesystem";
import { join } from "node:path";
import {
  CREATOR_CHANNEL_PREFIX,
  CREATOR_ERROR,
  CREATOR_OPS,
  CREATOR_PROTOCOL_VERSION,
  CreatorPublicError,
  parseCreatorCreateSpec,
  parseCreatorExecuteInput,
  parseCreatorIssueInput,
  parseCreatorJobInput,
  parseCreatorUnregisterInput,
  type CreatorContext,
  type CreatorCreateSpec,
  type CreatorIssueInput,
  type CreatorIssueResult,
  type CreatorOperation,
  type CreatorPlan,
  type CreatorPlanPlugin,
  type CreatorPlanStep,
} from "../../../shared/creator";
import type { WorkbenchCommand, WorkbenchJob, WorkbenchJobResult, WorkbenchJobStep } from "../../../shared/workbench";
import { WorkbenchPublicError } from "./errors";
import { redactPublicReason } from "../../../shared/public-reason";
import { sanitizeLogText } from "../diagnostics/diagnostics";
import type { SupervisorLifecycle } from "./lifecycle";
import type { HomeOperationLock } from "../home/home-operation-lock";
import type { ProfileRegistry } from "../profile/profile-registry";
import type { WorkbenchJobContext, WorkbenchJobStore } from "../maintenance/workbench-jobs";
import type { SpaceBaseCreation } from "./base-creation";
import type { NodeSpacesService } from "../products/spaces-service";
import type { SpaceRunRegistry } from "./space-runs";
import { assertOwnedProfilePath } from "../profile/profile-settings";
import { describeModelSync, type ModelSyncSummary } from "../llm/main-model-sync";
import { listProfilePlugins } from "../products/plugin-ops";
import { parseIcon } from "./input";
import type { BoundCli } from "./types";
import type { SpacesComponent } from "../payload/dev-checkout";
import type { DiagnosticLogger } from "../diagnostics/rotating-log";
import { admitNativeRequest, ChannelBodyRejection, readChannelJsonBody } from "./native-request";
import {
  installSpecFor,
  pendingBuildKeys,
  pinDetailFor,
  verifyExactInstall,
  writeBuildPolicy,
} from "../products/plugin-exact-source";

const PLAN_TTL_MS = 5 * 60_000;
const PLAN_LIMIT = 64;
const IDENTITY_TIMEOUT_MS = 5_000;
const ISSUE_OPS = new Set<CreatorOperation>(["issue", "unregister"]);

/**
 * One live main registration. The Creator and Control channels mint one
 * scope each; only scope digests are retained and neither scope ever reaches
 * logs, jobs or durable state. The loopback identity bearer is memory-only
 * for dead-host proof and is never logged or persisted.
 */
export const RECLAIM_PROBE_TIMEOUT_MS = 1_500;

export interface MainChannelRegistration {
  registrationId: string;
  profile: string;
  serviceEpoch: string;
  creatorScopeDigest: Buffer;
  controlScopeDigest: Buffer;
  /** In-memory-only loopback proof credentials; never logged or persisted. */
  identityOrigin: string;
  identityBearer: string;
}

interface StoredCreatorPlan {
  plan: CreatorPlan;
  registrationId: string;
  consumed: boolean;
  /** Why consumption failed after the plan was marked used. */
  submissionFailed?: string;
}

export interface SupervisorCreatorPorts {
  diagnosticLog?: DiagnosticLogger;
  home: string;
  origin(): string;
  now(): Date;
  fetch: typeof fetch;
  lifecycle: SupervisorLifecycle;
  lock: HomeOperationLock;
  registry: ProfileRegistry;
  runs: SpaceRunRegistry;
  jobs(): WorkbenchJobStore | undefined;
  managerId(): string | null;
  cli(): BoundCli | null;
  spaces(): NodeSpacesService | undefined;
  bases: SpaceBaseCreation;
  /** The existing Host bearer (endpoint.json) — the issuer credential only. */
  hostBearerEquals(value: string): boolean;
  /** Run-rights ownership and liveness, same assertion the LLM registration uses. */
  assertOwner(): void;
  currentServiceEpoch(): string;
  stateRevision(): string;
  /** All registered spaces (the managed children), plus no implicit extras. */
  registeredSpaceIds(): string[];
  maintenance(): boolean;
  hasComponent(component: SpacesComponent): boolean;
  ensureViewBridge(profileId: string): Promise<void>;
  /** One copy of the main space's models into the new, not yet started space. */
  syncMainModels(spaceId: string): Promise<ModelSyncSummary>;
  installedRuntimeBin(version: string): string | undefined;
  /** Optional space start for `startAfterCreate`; wired to the real lifecycle in production. */
  startSpace?(spaceId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"]>;
  /** Shared-channel cleanup after one registration is retired or reclaimed. */
  onRegistrationRetired?(registrationId: string): void;
  pluginAdd(home: string, profile: string, spec: string): Promise<void>;
  observeChildWork<T>(action: () => T): T;
  setActiveJob(id: string | undefined): void;
}

const scopeDigest = (value: string): Buffer => createHash("sha256").update(value).digest();

function creatorError(error: unknown): CreatorPublicError {
  if (error instanceof CreatorPublicError) return error;
  if (error instanceof WorkbenchPublicError) {
    const map: Record<string, keyof typeof CREATOR_ERROR> = {
      "workbench/read-only": "creator/read-only",
      "workbench/unavailable": "creator/unavailable",
      "workbench/invalid-input": "creator/invalid-input",
      "workbench/not-found": "creator/not-found",
      "workbench/conflict": "creator/request-conflict",
      "workbench/protected": "creator/unsupported",
      "workbench/unsupported": "creator/unsupported",
      "workbench/busy": "creator/unavailable",
      "workbench/incompatible": "creator/unavailable",
      "workbench/maintenance": "creator/unavailable",
    };
    return new CreatorPublicError(map[error.code] ?? "creator/unavailable", publicReasonOf(error));
  }
  if (error instanceof Error) return new CreatorPublicError("creator/failed", publicReasonOf(error));
  return new CreatorPublicError("creator/failed");
}

/** Public-safe error text: credentials and raw payloads never reach the wire. */
function publicReasonOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = redactPublicReason(sanitizeLogText(raw));
  if (!cleaned || cleaned === "[omitted credential material]" || cleaned === "[omitted chat payload]") {
    return "The creator request failed.";
  }
  return cleaned;
}

/**
 * The Creator (制作空间) channel: a scoped channel for the trusted main-space
 * identity, independent of managerApi and LLM enablement. Issuance reuses the
 * existing main-registration proof (Host bearer + owned profile assertion +
 * loopback /identity nonce challenge) bound to this service epoch; the issued
 * scope alone authorizes context/preview/execute/job. This verifies a
 * controlled main registration; it is not an isolation boundary against a
 * hostile process on the same OS account.
 */
export class SupervisorCreator {
  private registration: MainChannelRegistration | undefined;
  private readonly plans = new Map<string, StoredCreatorPlan>();
  private closed = false;

  constructor(private readonly ports: SupervisorCreatorPorts) {}

  /** Whether a presented token is the live Creator scope for this epoch. */
  scopeEquals(value: string): boolean {
    const registration = this.registration;
    if (!registration || registration.serviceEpoch !== this.ports.currentServiceEpoch()) return false;
    return value.length > 0 && timingSafeEqual(scopeDigest(value), registration.creatorScopeDigest);
  }

  /** Whether a presented token is the live Control scope for this epoch. */
  controlScopeEquals(value: string): boolean {
    const registration = this.registration;
    if (!registration || registration.serviceEpoch !== this.ports.currentServiceEpoch()) return false;
    return value.length > 0 && timingSafeEqual(scopeDigest(value), registration.controlScopeDigest);
  }

  /**
   * The registration shared with the control channel. This is a liveness
   * view only — it does not assert run rights, so read-only projections can
   * keep serving while the caller reports writability itself.
   */
  registrationView(): MainChannelRegistration | undefined {
    const registration = this.registration;
    if (!registration || this.closed) return undefined;
    if (registration.serviceEpoch !== this.ports.currentServiceEpoch()) return undefined;
    return registration;
  }

  private requireRegistration(): MainChannelRegistration {
    this.ports.assertOwner();
    const registration = this.registration;
    if (!registration || registration.serviceEpoch !== this.ports.currentServiceEpoch()) {
      throw new CreatorPublicError("creator/unavailable", "The creator registration is not active.");
    }
    return registration;
  }

  /**
   * Issue a Creator scope. The caller proves it is the trusted main identity:
   * Host bearer (checked by the HTTP layer) + a declared loopback identity
   * endpoint that answers a server-issued nonce with its real home/profile.
   * One live registration per service epoch; a second issue conflicts and
   * nothing is rotated implicitly.
   */
  async issue(input: CreatorIssueInput): Promise<CreatorIssueResult> {
    this.ports.assertOwner();
    if (this.closed) throw new CreatorPublicError("creator/unavailable");
    if (input.home !== this.ports.home) throw new CreatorPublicError("creator/invalid-input", "The claimed Home does not match this supervisor.");
    this.assertMainProfile(input.profile);
    const origin = this.cleanIdentityOrigin(input.origin);
    const nonce = randomBytes(32).toString("hex");
    let proof: Record<string, unknown> = {};
    let ok = false;
    try {
      // A one-shot identity probe: never reuse a pooled socket that an older,
      // already-retired identity listener may still hold.
      const response = await this.ports.fetch(`${origin}/identity`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
        headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ nonce }),
      });
      try {
        proof = (await response.json()) as Record<string, unknown>;
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
      ok = response.ok;
    } catch {
      throw new CreatorPublicError("creator/unavailable", "The identity endpoint did not prove the claimed main identity.");
    }
    if (!ok || proof.nonce !== nonce || proof.home !== input.home || proof.profile !== input.profile) {
      throw new CreatorPublicError("creator/unavailable", "The identity endpoint did not prove the claimed main identity.");
    }
    // Ownership and registration exclusivity are re-checked after the outbound
    // challenge: the lease or a concurrent registration may have changed.
    this.ports.assertOwner();
    if (this.closed) throw new CreatorPublicError("creator/unavailable");
    let reclaimedPrevious: MainChannelRegistration | undefined;
    if (this.registration) {
      const previous = this.registration;
      const verdict = await this.probePrevious(previous);
      this.ports.assertOwner();
      if (this.closed) throw new CreatorPublicError("creator/unavailable");
      const current = this.registration;
      if (current === previous) {
        if (verdict !== "dead") {
          throw new CreatorPublicError("creator/conflict", "A creator registration is already active for this service epoch.");
        }
        this.retireRegistration(previous);
        reclaimedPrevious = previous;
      } else if (current !== undefined) {
        throw new CreatorPublicError("creator/conflict", "A creator registration is already active for this service epoch.");
      }
    }
    const creatorScope = randomBytes(32).toString("hex");
    const controlScope = randomBytes(32).toString("hex");
    const registration: MainChannelRegistration = {
      registrationId: randomUUID(),
      profile: input.profile,
      serviceEpoch: this.ports.currentServiceEpoch(),
      creatorScopeDigest: scopeDigest(creatorScope),
      controlScopeDigest: scopeDigest(controlScope),
      identityOrigin: origin,
      identityBearer: input.bearer,
    };
    this.registration = registration;
    this.ports.diagnosticLog?.info("creator.registered", "The main space registered its Creator and Control channels.", { main: input.profile, registration: registration.registrationId });
    if (reclaimedPrevious) {
      this.ports.diagnosticLog?.info("creator.reclaimed-dead-host", "A dead main registration was reclaimed after its loopback identity proof failed.", {
        previousRegistration: reclaimedPrevious.registrationId,
        registration: registration.registrationId,
      });
    }
    return { registrationId: registration.registrationId, scopes: { creator: creatorScope, control: controlScope }, serviceEpoch: registration.serviceEpoch };
  }

  /** Probe the previous main identity. Only refusal or a failed fresh-nonce proof is dead. */
  private async probePrevious(previous: MainChannelRegistration): Promise<"dead" | "alive" | "unknown"> {
    const nonce = randomBytes(24).toString("hex");
    let response: Response;
    try {
      response = await this.ports.fetch(`${previous.identityOrigin}/identity`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(RECLAIM_PROBE_TIMEOUT_MS),
        headers: { authorization: `Bearer ${previous.identityBearer}`, "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ nonce }),
      });
    } catch (error) {
      return hasConnectionRefused(error) ? "dead" : "unknown";
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return response.status >= 400 && response.status < 500 ? "dead" : "unknown";
    }
    let proof: Record<string, unknown>;
    try {
      proof = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SyntaxError) return "dead";
      return "unknown";
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
    const record = proof && typeof proof === "object" && !Array.isArray(proof) ? proof : {};
    return record.nonce === nonce && record.home === this.ports.home && record.profile === previous.profile ? "alive" : "dead";
  }

  /** Explicitly retire the live registration; matching id is mandatory. */
  unregister(registrationId: string): { unregistered: true } {
    this.ports.assertOwner();
    const registration = this.registration;
    if (!registration || registration.registrationId !== registrationId) {
      throw new CreatorPublicError("creator/unregistered");
    }
    this.retireRegistration(registration);
    this.ports.diagnosticLog?.info("creator.unregistered", "The main-space registration was retired.", { registration: registrationId });
    return { unregistered: true };
  }

  async context(): Promise<CreatorContext> {
    const registration = this.requireRegistration();
    const jobs = this.ports.jobs();
    const createBusy = Boolean(
      jobs?.list().some((job) => job.status === "queued" || job.status === "running"),
    );
    return {
      protocolVersion: CREATOR_PROTOCOL_VERSION,
      serviceEpoch: registration.serviceEpoch,
      revision: this.ports.stateRevision(),
      writable: Boolean(this.ports.lifecycle.handle),
      maintenance: this.ports.maintenance(),
      createBusy,
      dshVersion: this.ports.cli()?.version ?? null,
      modelSources: ["main", "local"],
    };
  }

  /** Validate input, freeze a single-use preview bound to this registration. */
  async createPreview(rawInput: unknown): Promise<CreatorPlan> {
    const registration = this.requireRegistration();
    try {
      this.ports.lifecycle.admitSubmission();
    } catch (error) {
      throw creatorError(error);
    }
    const spec = parseCreatorCreateSpec(rawInput);
    const cli = this.ports.cli();
    if (!cli) throw new CreatorPublicError("creator/unavailable", "A compatible DSH CLI is required before previewing a space.");
    // The frozen plan always pins an exact base: an omitted baseVersion binds
    // the current host CLI version and can never drift at execute time.
    const input: CreatorCreateSpec = { ...spec, baseVersion: spec.baseVersion ?? cli.version };
    const steps: CreatorPlanStep[] = [{ step: "prepare" }];
    if (!this.ports.installedRuntimeBin(input.baseVersion!)) steps.push({ step: "install-runtime" });
    steps.push({ step: "create" });
    if (this.ports.hasComponent("view-bridge")) steps.push({ step: "view-bridge" });
    // "main" copies the main space's models once; "local" leaves the new space's models to the user.
    if (input.modelSource === "main") steps.push({ step: "models-sync" });
    for (const plugin of input.plugins) steps.push({ step: "plugin", packageName: plugin.packageName });
    if (input.startAfterCreate) steps.push({ step: "start" });
    steps.push({ step: "result" });
    const serviceEpoch = registration.serviceEpoch;
    const stateRevision = this.ports.stateRevision();
    const plan: CreatorPlan = {
      id: `${registration.registrationId}-${randomUUID()}`,
      kind: "creator.create",
      serviceEpoch,
      stateRevision,
      expiresAt: new Date(this.ports.now().getTime() + PLAN_TTL_MS).toISOString(),
      fingerprint: JSON.stringify({ input, serviceEpoch, stateRevision }),
      input,
      steps,
    };
    this.evictExpiredPlans();
    if (this.plans.size >= PLAN_LIMIT) throw new CreatorPublicError("creator/unavailable", "Too many open previews; execute or wait for expiry.");
    this.plans.set(plan.id, { plan, registrationId: registration.registrationId, consumed: false });
    this.ports.diagnosticLog?.info("creator.preview", "A space-creation plan was frozen.", { plan: plan.id, steps: plan.steps.length, modelSource: input.modelSource, startAfterCreate: input.startAfterCreate });
    return plan;
  }

  /**
   * Submit a frozen plan as one serialized job. requestId idempotency is
   * checked against the job store first: an identical replay returns the
   * original job even after the plan was consumed or expired.
   */
  async createExecute(input: { planId: string; requestId: string }): Promise<WorkbenchJob> {
    const registration = this.requireRegistration();
    const jobs = this.ports.jobs();
    if (!jobs) throw new CreatorPublicError("creator/read-only");
    try {
      this.ports.lifecycle.admitSubmission();
    } catch (error) {
      throw creatorError(error);
    }
    const existing = jobs.commandOf(input.requestId);
    if (existing) {
      if (existing.kind === "creator.create" && existing.planId === input.planId && this.ownsPlanId(registration, existing.planId)) {
        return jobs.job(input.requestId);
      }
      throw new CreatorPublicError("creator/request-conflict");
    }
    const stored = this.plans.get(input.planId);
    if (!stored || !this.ownsPlanId(registration, input.planId)) {
      throw new CreatorPublicError("creator/not-found", "That preview was not found.");
    }
    if (stored.registrationId !== registration.registrationId) {
      throw new CreatorPublicError("creator/not-found", "That preview was not found.");
    }
    if (stored.consumed) {
      throw stored.submissionFailed
        ? new CreatorPublicError("creator/plan-consumed", stored.submissionFailed)
        : new CreatorPublicError("creator/plan-consumed");
    }
    if (Date.parse(stored.plan.expiresAt) <= this.ports.now().getTime()) {
      // A submitted plan reads back as consumed, not merely expired.
      stored.consumed = true;
      throw new CreatorPublicError("creator/plan-expired");
    }
    if (stored.plan.serviceEpoch !== this.ports.currentServiceEpoch() || stored.plan.stateRevision !== this.ports.stateRevision()) {
      throw new CreatorPublicError("creator/request-conflict", "The preview target changed. Request a new preview.");
    }
    const expected = JSON.stringify({ input: stored.plan.input, serviceEpoch: stored.plan.serviceEpoch, stateRevision: stored.plan.stateRevision });
    if (expected !== stored.plan.fingerprint) {
      throw new CreatorPublicError("creator/request-conflict", "The preview target changed. Request a new preview.");
    }
    // Consume then submit synchronously: accept() is synchronous, so no job
    // can interleave between the two. A submit failure is recorded on the
    // plan so a later execute reports the real reason instead of a bare
    // "already consumed" — nothing is replayed.
    stored.consumed = true;
    const spec = stored.plan.input;
    const command: WorkbenchCommand = {
      kind: "creator.create",
      planId: stored.plan.id,
      name: spec.name,
      ...(spec.displayName !== undefined ? { displayName: spec.displayName } : {}),
      ...(spec.icon !== undefined ? { icon: spec.icon } : {}),
    };
    try {
      return await jobs.submit(command, input.requestId, (ctx) => {
        this.ports.setActiveJob(input.requestId);
        return this.ports.observeChildWork(async () => {
          try {
            this.ports.lifecycle.assertWritable();
            if (stored.plan.serviceEpoch !== this.ports.currentServiceEpoch()) {
              throw new CreatorPublicError("creator/request-conflict", "The preview belongs to another service epoch.");
            }
            if (stored.plan.stateRevision !== this.ports.stateRevision()) {
              throw new CreatorPublicError("creator/request-conflict", "The preview target changed. Request a new preview.");
            }
            return await this.runCreate(stored.plan, ctx);
          } finally {
            this.ports.setActiveJob(undefined);
          }
        });
      });
    } catch (error) {
      stored.submissionFailed = `The preview was consumed but its job could not be submitted: ${publicReasonOf(error)}`;
      throw creatorError(error);
    }
  }

  /** Read only creator.create jobs owned by the active registration. */
  async job(jobId: string): Promise<WorkbenchJob> {
    const registration = this.requireRegistration();
    const jobs = this.ports.jobs();
    if (!jobs) throw new CreatorPublicError("creator/read-only");
    const command = jobs.commandOf(jobId);
    if (!command || command.kind !== "creator.create" || !this.ownsPlanId(registration, command.planId)) {
      throw new CreatorPublicError("creator/not-found");
    }
    return jobs.job(jobId);
  }

  private ownsPlanId(registration: MainChannelRegistration, planId: string): boolean {
    return planId.startsWith(`${registration.registrationId}-`);
  }

  private evictExpiredPlans(): void {
    const now = this.ports.now().getTime();
    for (const [id, stored] of this.plans) {
      if (stored.consumed || Date.parse(stored.plan.expiresAt) <= now) this.plans.delete(id);
    }
  }

  /** The caller's profile must be a real main profile: never the manager and
   *  never a managed/registered child space, running or stopped. */
  private assertMainProfile(profile: string): void {
    const forbidden = (): never => {
      throw new CreatorPublicError("creator/unsupported", "That profile is not a creator main identity.");
    };
    if (profile === this.ports.managerId()) forbidden();
    if (this.ports.runs.spawned.has(profile)) forbidden();
    if (this.ports.registeredSpaceIds().includes(profile)) forbidden();
    const directory = join(this.ports.home, "profiles", profile);
    assertOwnedProfilePath(this.ports.home, join(directory, "package.json"));
    const stat = lstatSync(directory);
    const manifest = lstatSync(join(directory, "package.json"));
    if (!stat.isDirectory() || stat.isSymbolicLink() || !manifest.isFile() || manifest.isSymbolicLink()) {
      forbidden();
    }
  }

  private cleanIdentityOrigin(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new CreatorPublicError("creator/invalid-input", "The identity endpoint is not a clean loopback origin.");
    }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new CreatorPublicError("creator/invalid-input", "The identity endpoint is not a clean loopback origin.");
    }
    if (url.origin === this.ports.origin()) {
      throw new CreatorPublicError("creator/invalid-input", "The identity endpoint must not be the supervisor.");
    }
    return url.origin;
  }

  /**
   * The single composed job: prepare/runtime → space create → view bridge →
   * LLM policy → ordered plugin installs with read-back → optional start.
   * The first failure stops the pipeline; partial progress is reported
   * truthfully via result.steps and nothing is rolled back or retried.
   */
  private async runCreate(plan: CreatorPlan, ctx: WorkbenchJobContext): Promise<WorkbenchJobResult> {
    const input = plan.input;
    const steps: WorkbenchJobStep[] = plan.steps.map((row) => ({
      step: row.step,
      status: "not-run",
      ...(row.packageName ? { packageName: row.packageName } : {}),
      ...(row.step === "plugin"
        ? { detail: pinDetailFor(input.plugins.find((plugin) => plugin.packageName === row.packageName)!) }
        : {}),
    }));
    let spaceId = "";
    const publish = (): void => {
      ctx.result({ ...(spaceId ? { spaceId } : {}), steps: steps.map((row) => ({ ...row })) });
    };
    const stepIndex = (kind: string, packageName?: string): number =>
      steps.findIndex((row) => row.step === kind && (packageName === undefined || row.packageName === packageName));
    const fail = (kind: string, packageName: string | undefined, error: unknown): never => {
      const index = stepIndex(kind, packageName);
      if (index >= 0) steps[index].status = "failed";
      publish();
      this.ports.diagnosticLog?.error("creator.step-failed", "A space-creation step failed; no later step is attempted.", error, { plan: plan.id, space: spaceId || null, step: kind, package: packageName ?? null });
      throw creatorError(error);
    };
    const done = (kind: string, packageName?: string): void => {
      const index = stepIndex(kind, packageName);
      if (index >= 0) steps[index].status = "done";
      publish();
      this.ports.diagnosticLog?.info("creator.step", "A space-creation step completed.", { plan: plan.id, space: spaceId || null, step: kind, package: packageName ?? null });
    };
    try {
      await this.ports.lock.run("creator.create", async () => {
        ctx.phase("prepare");
        ctx.cancellable(false);
        const recipe = await (async () => {
          try {
            return await this.ports.bases.prepare("web", input.baseVersion, (version) => {
              ctx.phase("install");
              ctx.message(`DSH ${version}`);
            });
          } catch (error) {
            fail("prepare", undefined, error);
          }
        })();
        // Component availability is decided while the job is still in
        // prepare: an unusable linked component source fails here with the
        // component named rather than after the profile exists.
        let components: { viewBridge: boolean };
        try {
          components = { viewBridge: this.ports.hasComponent("view-bridge") };
        } catch (error) {
          fail("prepare", undefined, error);
        }
        done("prepare");
        done("install-runtime");
        ctx.phase("create");
        ctx.message("");
        const spaces = this.ports.spaces() ?? fail("create", undefined, new CreatorPublicError("creator/unavailable"));
        try {
          spaceId = (await spaces.create({ name: input.name, displayName: input.displayName }, recipe)).id;
          if (input.icon !== undefined) this.ports.registry.updateMeta(spaceId, { icon: parseIcon(input.icon) });
        } catch (error) {
          fail("create", undefined, error);
        }
        done("create");
        publish();
        if (components!.viewBridge) {
          ctx.phase("view-bridge");
          try {
            await this.ports.ensureViewBridge(spaceId);
          } catch (error) {
            fail("view-bridge", undefined, error);
          }
          done("view-bridge");
        }
        if (input.modelSource === "main") {
          ctx.phase("models-sync");
          let summary: ModelSyncSummary;
          try {
            summary = await this.ports.syncMainModels(spaceId);
          } catch (error) {
            fail("models-sync", undefined, error);
          }
          const index = stepIndex("models-sync");
          if (index >= 0) steps[index].detail = describeModelSync(summary!);
          done("models-sync");
        }
        if (input.plugins.length) {
          ctx.phase("plugins");
          // Deny-by-default is explicit channel policy: pnpm blocks git
          // prepare and ignored build scripts unless named, and we also pin
          // dangerouslyAllowAllBuilds:false so ambient host config cannot
          // widen the boundary this channel declares.
          const approvals = [...new Set(input.plugins.flatMap((plugin) => plugin.approvedBuilds))];
          writeBuildPolicy(join(this.ports.home, "profiles", spaceId), approvals);
        }
        for (const plugin of input.plugins) {
          ctx.message(plugin.packageName);
          try {
            await this.ports.pluginAdd(this.ports.home, spaceId, installSpecFor(plugin));
            this.verifyInstalled(spaceId, plugin);
          } catch (error) {
            const pending = pendingBuildKeys(error instanceof Error ? error.message : String(error));
            fail(
              "plugin",
              plugin.packageName,
              pending.length
                ? new CreatorPublicError(
                    "creator/failed",
                    `${publicReasonOf(error)} Pending builds awaiting approval: ${pending.join(", ")}`,
                  )
                : error,
            );
          }
          done("plugin", plugin.packageName);
        }
      });
      if (input.startAfterCreate) {
        const startSpace = this.ports.startSpace;
        if (!startSpace) {
          const index = stepIndex("start");
          if (index >= 0) steps[index].status = "failed";
          publish();
          throw new CreatorPublicError("creator/unavailable", "Space start is unavailable.");
        }
        ctx.phase("start");
        // The composed job is never cancellable; the space lifecycle must not
        // re-enable cancellation on the shared job context.
        const constrained: WorkbenchJobContext = {
          signal: ctx.signal,
          phase: (phase) => ctx.phase(phase),
          message: (message) => ctx.message(message),
          cancellable: () => undefined,
          result: (value) => ctx.result(value),
        };
        try {
          await startSpace(spaceId, constrained);
        } catch (error) {
          fail("start", undefined, error);
        }
        done("start");
      }
      done("result");
      return { spaceId, steps };
    } catch (error) {
      publish();
      throw error;
    }
  }

  private verifyInstalled(spaceId: string, plugin: CreatorPlanPlugin): void {
    try {
      verifyExactInstall(listProfilePlugins(this.ports.home, spaceId), this.ports.home, spaceId, plugin);
    } catch (error) {
      throw new CreatorPublicError(
        "creator/failed",
        error instanceof Error ? error.message : "The plugin read-back failed.",
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.registration = undefined;
    this.plans.clear();
  }

  /** Run rights dropped or one dead/unregistered main retired: shared state dies with it. */
  retireRegistration(registration: MainChannelRegistration | undefined = this.registration): void {
    if (!registration) return;
    if (this.registration === registration) this.registration = undefined;
    for (const [id, plan] of this.plans) {
      if (plan.registrationId === registration.registrationId) this.plans.delete(id);
    }
    try {
      this.ports.onRegistrationRetired?.(registration.registrationId);
    } catch (error) {
      this.ports.diagnosticLog?.error("creator.retire-cleanup-failed", "Shared registration cleanup failed after retirement.", error, { registration: registration.registrationId });
    }
  }

  /**
   * HTTP boundary on the supervisor loopback listener. `issue`/`unregister`
   * require the Host bearer; the business operations require the issued
   * Creator scope. Session cookies and workspace origins are never accepted.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!req.url?.startsWith(CREATOR_CHANNEL_PREFIX)) return false;
    const op = req.url.slice(CREATOR_CHANNEL_PREFIX.length) as CreatorOperation;
    const reply = (status: number, body: unknown): void => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(`${JSON.stringify(body)}\n`);
    };
    const deny = (status: number, code: string, message: string): void =>
      reply(status, { ok: false, error: { code, message } });
    const failOp = (error: unknown): void => {
      const mapped = error instanceof CreatorPublicError ? error : creatorError(error);
      this.ports.diagnosticLog?.error("creator.request-failed", "A main-space Creator request failed.", error, { operation: op });
      deny(200, mapped.code, mapped.message);
    };
    try {
      if (!CREATOR_OPS.includes(op)) {
        deny(404, "workbench/not-found", "Unknown creator operation.");
        return true;
      }
      const admission = admitNativeRequest(req, this.ports.origin(), "creator");
      if (!admission.ok) {
        deny(admission.status, admission.code, admission.message);
        return true;
      }
      const token = admission.token!;
      let input: unknown;
      try {
        input = await readChannelJsonBody(req, "creator");
      } catch (error) {
        if (error instanceof ChannelBodyRejection) {
          deny(200, "creator/invalid-input", error.message);
        } else {
          deny(400, "workbench/invalid-input", "The request is not valid JSON.");
        }
        return true;
      }
      if (ISSUE_OPS.has(op)) {
        if (!this.ports.hostBearerEquals(token)) {
          deny(401, "workbench/unauthorized", "The creator issuer requires the Host bearer.");
          return true;
        }
        if (op === "issue") {
          try {
            const result = await this.issue(parseCreatorIssueInput(input));
            reply(200, { ok: true, value: result });
          } catch (error) {
            failOp(error);
          }
        } else {
          try {
            const result = this.unregister(parseCreatorUnregisterInput(input).registrationId);
            reply(200, { ok: true, value: result });
          } catch (error) {
            failOp(error);
          }
        }
        return true;
      }
      if (!this.scopeEquals(token)) {
        deny(401, "workbench/unauthorized", "The creator scope is required.");
        return true;
      }
      switch (op) {
        case "context":
          try {
            reply(200, { ok: true, value: await this.context() });
          } catch (error) {
            failOp(error);
          }
          return true;
        case "createPreview": {
          const body = input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>) : {};
          if (Object.keys(body).some((key) => key !== "input")) {
            deny(200, "creator/invalid-input", "createPreview accepts only { input }.");
            return true;
          }
          try {
            reply(200, { ok: true, value: await this.createPreview(body.input) });
          } catch (error) {
            failOp(error);
          }
          return true;
        }
        case "createExecute":
          try {
            reply(200, { ok: true, value: await this.createExecute(parseCreatorExecuteInput(input)) });
          } catch (error) {
            failOp(error);
          }
          return true;
        case "job":
          try {
            reply(200, { ok: true, value: await this.job(parseCreatorJobInput(input).jobId) });
          } catch (error) {
            failOp(error);
          }
          return true;
        default:
          deny(404, "workbench/not-found", "Unknown creator operation.");
          return true;
      }
    } catch (error) {
      deny(500, "workbench/failed", "The creator request failed.");
      return true;
    }
  }
}


function hasConnectionRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (row.code === "ECONNREFUSED") return true;
  if (Array.isArray(row.errors) && row.errors.some(hasConnectionRefused)) return true;
  return hasConnectionRefused(row.cause);
}
