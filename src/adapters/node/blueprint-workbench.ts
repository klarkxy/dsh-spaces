import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument, stringify as stringifyYaml, isMap, isScalar, isSeq, Scalar, YAMLMap } from "yaml";
import {
  bindBlueprintInputs,
  diagnoseBlueprint,
  parseBlueprint,
} from "../../core/domain/blueprint";
import {
  applyIsolationPatch,
  CREDENTIALS_ROW_ID,
  configPathExpr,
  isolationExpr,
  isExpectedIsolationPath,
  isExpectedIsolationRoot,
  patchTextLooksConfigIsolated,
  SESSION_ROW_ID,
  SETTINGS_ROW_ID,
  STORAGE_ROW_ID,
} from "../../core/domain/isolation";
import {
  BLUEPRINT_ARCH,
  BLUEPRINT_CODE,
  BLUEPRINT_FORBIDDEN_SETTINGS,
  BLUEPRINT_HOST_PACKAGES,
  BLUEPRINT_MANAGED_ENTRY_IDS,
  BLUEPRINT_OS,
  BLUEPRINT_SPACES_CONTROL_PACKAGES,
  BlueprintError,
  type Blueprint,
  type BlueprintArch,
  type BlueprintBinding,
  type BlueprintDiagnostic,
  type BlueprintInput,
  type BlueprintInputValues,
  type BlueprintJson,
  type BlueprintJsonObject,
  type BlueprintOs,
  type BlueprintPackage,
  type BlueprintPackageEvidence,
  type BlueprintPatch,
  type BlueprintPatchEntry,
  type BlueprintPatchInsert,
  type BlueprintSettings,
} from "../../shared/blueprint";
import { isGitSpec } from "../../shared/plugin";
import { isExactRuntimeVersion } from "../../shared/runtime";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES } from "../../shared/types";
import { scanShareEntries } from "../../core/domain/llm-share";
import { LLM_ERROR, LlmConfigError } from "../../core/domain/llm-connections";
import type { LlmApiRequest, LlmApiResult, LlmDescribeResult, LlmSpacePolicyResult } from "../../shared/llm-api";
import type { WorkbenchJobResult, WorkbenchSpace } from "../../shared/workbench";
import type { WorkbenchProductObservation } from "../../shared/workbench-product";
import {
  BLUEPRINT_LOCAL_FILE,
  BLUEPRINT_ORIGIN_FILE,
  BLUEPRINT_ORIGIN_SCHEMA_VERSION,
  BLUEPRINT_PLAN_MAX_COUNT,
  BLUEPRINT_PLAN_MAX_TOTAL_BYTES,
  BLUEPRINT_PLAN_TTL_MS,
  type BlueprintApplyStage,
  type BlueprintEligibility,
  type BlueprintGenerateBindingOverride,
  type BlueprintGenerateSelection,
  type BlueprintHostVersions,
  type BlueprintInstalledIdentity,
  type BlueprintLocalObservation,
  type BlueprintOriginRecord,
  type BlueprintPackageResult,
  type BlueprintPreviewInput,
  type BlueprintSourceBundle,
  type BlueprintSourceNamespace,
  type BlueprintSourcePackage,
  type BlueprintSourcePatchInfo,
  type BlueprintWriteKind,
  type BlueprintWriteResult,
  type WorkbenchBlueprintApplyOutcome,
  type WorkbenchBlueprintGeneratePayload,
  type WorkbenchBlueprintInspectPayload,
  type WorkbenchBlueprintPreviewPayload,
  type WorkbenchBlueprintSourcePayload,
} from "../../shared/workbench-blueprint";
import { atomicWrite } from "./atomic";
import { decodeBlueprint, encodeBlueprint, stringifyBlueprint } from "./blueprint-codec";
import {
  prepareBlueprintPackage,
  BlueprintPackageError,
  type PreparedBlueprintPackage,
} from "./blueprint-package";
import { sanitizeLogText } from "./diagnostics";
import { assertNotRealHome, isInsideRealHome, realDshHome } from "./home-guard";
import { settingsPath } from "./hub-settings";
import { spaceDataRoot } from "./llm-policy-store";
import { spaceSettingsPath } from "./llm-space-settings";
import { readProfileSettings, writeProfileSettings } from "./profile-settings";
import { parseNpmNameAndVersion, type PluginFetcher } from "./plugin-ops";
import { isHubPluginArchive, readPluginLibrary } from "./plugin-library";
import type { WorkbenchJobContext } from "./workbench-jobs";

const HOST_PACKAGE_SET = new Set<string>(BLUEPRINT_HOST_PACKAGES);
const CONTROL_PACKAGE_SET = new Set<string>(BLUEPRINT_SPACES_CONTROL_PACKAGES);
const MANAGED_ENTRY_SET = new Set<string>(BLUEPRINT_MANAGED_ENTRY_IDS);
const FORBIDDEN_SETTINGS = new Set<string>(BLUEPRINT_FORBIDDEN_SETTINGS);
const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;
const JS_TAG = "tag:yaml.org,2002:js";
const DSH_HOME_PATH_RE = /^dshHomePath\(\s*(['"])([^'"]+)\1\s*\)$/;
const CREDENTIAL_KEY_RE = /(?:^|[_-])(?:api[_-]?key|password|secret|token|cookie|authorization|credential|private[_-]?key)(?:$|[_-])/i;
const GITHUB_APPLY_MESSAGE = "This version cannot apply blueprints with GitHub sources.";
const INSPECT_RUNTIME_FAILED = "The bound runtime could not be inspected.";

export type BlueprintCreateInput = { name: string; displayName?: string; icon?: string };

export type BlueprintRuntimeOptions = { home: string; bin: string };

export type BlueprintRuntimeInspect = {
  versions: { dsh: string | null; base: string | null; webApp: string | null };
  baseLayers: Array<{ name: string; version: string; packageDir: string; patchPath: string; patches: unknown[] }>;
  baseEntries: unknown[];
  homePatches: unknown[];
  fingerprint: string;
};

export type BlueprintRuntimeLayerIdentity = {
  name: string;
  version: string;
};

export type BlueprintRuntimeCompose = {
  versions: { dsh: string | null; base: string | null; webApp: string | null };
  layers: BlueprintRuntimeLayerIdentity[];
  entries: unknown[];
  warnings: string[];
  fingerprint: string;
};

export type BlueprintRuntimeModule = {
  packageName: string;
  packageVersion: string | null;
  resolvedPath: string | null;
  builtin: boolean;
};

export interface BlueprintWorkbenchPorts {
  home: string;
  observation(): WorkbenchProductObservation;
  managerId(): string | null;
  listSpaces(): WorkbenchSpace[];
  createSpace(input: BlueprintCreateInput, ctx: WorkbenchJobContext): Promise<unknown>;
  installPlugin(spaceId: string, spec: string): Promise<void>;
  llm(request: LlmApiRequest): Promise<LlmApiResult>;
  now?(): Date;
  fetchImpl?: PluginFetcher;
  writePatch?(spaceId: string, patch: string): void;
  dshVersion?(): string | null;
  spacesVersion?(): string | null;
  llmBridgeAvailable?(): boolean;
  llmAdmitted?(request: LlmApiRequest): Promise<LlmApiResult>;
  llmCatalogObservation?(): { revision: number; digest: string };
  runtimeBin?(): string | undefined;
  inspectRuntime?(options: BlueprintRuntimeOptions): Promise<BlueprintRuntimeInspect>;
  composeRuntime?(
    options: BlueprintRuntimeOptions,
    input: { spaceId: string; bundles: string[]; patch: unknown[] },
  ): Promise<BlueprintRuntimeCompose>;
  resolveModule?(
    options: BlueprintRuntimeOptions,
    input: { spaceId: string; specifier: string },
  ): Promise<BlueprintRuntimeModule>;
  prepareBlueprintPackage?(
    home: string,
    pkg: BlueprintPackage,
    options?: { fetchImpl?: PluginFetcher; signal?: AbortSignal },
  ): Promise<PreparedBlueprintPackage>;
}

type PlanObservation = {
  serviceEpoch: string;
  stateRevision: string;
  dshVersion: string | null;
  hostBaseVersion: string | null;
  hostWebAppVersion: string | null;
  homeSettingsDigest: string;
  homePatchDigest: string;
  runtimeFingerprint: string;
  llmCatalogRevision: number;
  llmCatalogDigest: string;
};

type StagedPlan = {
  id: string;
  epoch: string;
  expiresAt: number;
  bytes: number;
  consumed: boolean;
  blueprint: Blueprint;
  name: string;
  displayName?: string;
  values: BlueprintInputValues;
  observation: PlanObservation;
};

const jsTag = {
  tag: JS_TAG,
  identify: () => false,
  default: false,
  resolve(value: string): string {
    return value;
  },
};

export class BlueprintWorkbench {
  private readonly ports: BlueprintWorkbenchPorts;
  private readonly plans = new Map<string, StagedPlan>();
  private totalPlanBytes = 0;

  constructor(ports: BlueprintWorkbenchPorts) {
    assertNotRealHome(ports.home);
    this.ports = ports;
  }

  async source(spaceId: string): Promise<WorkbenchBlueprintSourcePayload> {
    const id = this.requireMutableSpace(spaceId, { mustExist: true });
    const manifest = readProfileManifest(this.ports.home, id);
    const library = readPluginLibrary(this.ports.home);
    const packages = sourcePackages(this.ports.home, id, manifest, library);
    const bundles = sourceBundles(manifest.bundles, packages);
    const patchInfo = describePatch(this.ports.home, id);
    const settingsNamespaces = describeSettings(this.ports.home, id);
    const localObservations = [
      ...patchInfo.observations,
      ...settingsNamespaces.flatMap((row) => row.observations),
    ];
    return {
      method: "blueprint.source",
      spaceId: id,
      packages,
      bundles,
      patch: patchInfo.info,
      settingsNamespaces: settingsNamespaces.map((row) => row.info),
      localObservations,
      host: await this.hostVersions(id),
    };
  }

  async generate(input: {
    spaceId: string;
    selection: BlueprintGenerateSelection;
    metadata: { name: string; version: string; description?: string };
    bindingOverrides?: BlueprintGenerateBindingOverride[];
  }): Promise<WorkbenchBlueprintGeneratePayload> {
    const id = this.requireMutableSpace(input.spaceId, { mustExist: true });
    const before = sourceFingerprint(this.ports.home, id);
    const built = buildGeneratedBlueprint(this.ports.home, id, input);
    const after = sourceFingerprint(this.ports.home, id);
    if (before !== after) {
      throw publicError("The space changed while the blueprint was being generated.");
    }
    const secret = secretFindingsOfBlueprint(built);
    if (secret) {
      throw publicError("The selected configuration contains a secret and cannot be shared.", secret);
    }
    const leftover = findUndeclaredLocals(built.profile.patch, built.profile.settings, built.bindings);
    if (leftover) {
      throw publicError("A local value must be declared as an input.", leftover);
    }
    const blueprint = parseBlueprint(built);
    const diagnostics = diagnoseBlueprint(blueprint, environmentFromHost(await this.hostVersions(id)));
    const json = stringifyBlueprint(blueprint);
    const shareCode = encodeBlueprint(blueprint, "shortest");
    return {
      method: "blueprint.generate",
      fileName: blueprintFileName(blueprint.metadata.name, blueprint.metadata.version),
      json,
      shareCode,
      blueprint,
      diagnostics,
    };
  }

  async inspect(content: string): Promise<WorkbenchBlueprintInspectPayload> {
    const blueprint = decodeContent(content);
    const diagnostics = diagnoseBlueprint(blueprint, environmentFromHost(await this.hostVersions()));
    return { method: "blueprint.inspect", blueprint, diagnostics };
  }

  async preview(input: {
    content: string;
    name: string;
    displayName?: string;
    values: BlueprintInputValues;
  }): Promise<WorkbenchBlueprintPreviewPayload> {
    const blueprint = decodeContent(input.content);
    const name = this.requireNewSpaceName(input.name);
    const packages = blueprint.packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      source: pkg.source.type,
      bundled: blueprint.profile.bundles.includes(pkg.name),
      order: blueprint.profile.bundles.indexOf(pkg.name) >= 0 ? blueprint.profile.bundles.indexOf(pkg.name) : undefined,
    }));
    const inputs = previewInputs(blueprint, input.values);
    const missingInputs = inputs
      .filter((row) => row.origin === "missing" && isRequiredInput(blueprint, row.id))
      .map((row) => row.id);
    try {
      const host = await this.hostVersions();
      const diagnostics = diagnoseBlueprint(
        blueprint,
        environmentFromHost(host, evidenceFromBlueprint(blueprint)),
      );
      const gate = await this.previewGate(blueprint, name, input.values, diagnostics);
      if (!gate.ok || missingInputs.length > 0) {
        return {
          method: "blueprint.preview",
          blueprint,
          packages,
          inputs,
          host,
          diagnostics,
          missingInputs,
        };
      }
      const now = this.nowMs();
      this.prunePlans(now);
      const encoded = JSON.stringify({ blueprint, values: input.values });
      const bytes = Buffer.byteLength(encoded, "utf8");
      if (this.plans.size >= BLUEPRINT_PLAN_MAX_COUNT) {
        throw publicError("Too many pending blueprint previews.");
      }
      if (this.totalPlanBytes + bytes > BLUEPRINT_PLAN_MAX_TOTAL_BYTES) {
        throw publicError("Pending blueprint previews exceed the size limit.");
      }
      const observation = await this.captureObservation();
      const id = randomUUID();
      const expiresAt = now + BLUEPRINT_PLAN_TTL_MS;
      this.plans.set(id, {
        id,
        epoch: observation.serviceEpoch,
        expiresAt,
        bytes,
        consumed: false,
        blueprint,
        name,
        displayName: input.displayName,
        values: { ...input.values },
        observation,
      });
      this.totalPlanBytes += bytes;
      return {
        method: "blueprint.preview",
        blueprint,
        packages,
        inputs,
        host,
        planId: id,
        expiresAt: new Date(expiresAt).toISOString(),
        diagnostics,
        missingInputs,
      };
    } catch (error) {
      if (!isInspectRuntimeFailure(error)) throw error;
      return {
        method: "blueprint.preview",
        blueprint,
        packages,
        inputs,
        host: this.portHostVersions(),
        diagnostics: [
          { code: "blueprint.runtime", message: INSPECT_RUNTIME_FAILED, severity: "error" },
        ],
        missingInputs,
      };
    }
  }

  private async previewGate(
    blueprint: Blueprint,
    spaceName: string,
    values: BlueprintInputValues,
    diagnostics: BlueprintDiagnostic[],
  ): Promise<{ ok: boolean }> {
    const blocking = blockingApplyDiagnostics(blueprint);
    diagnostics.push(...blocking.diagnostics);
    const secret = secretFindingsOfBlueprint(blueprint);
    if (secret) {
      diagnostics.push({
        code: "blueprint.secret",
        message: "The blueprint contains a secret and cannot be applied.",
        severity: "error",
        path: secret,
      });
    }
    let bound: ReturnType<typeof bindBlueprintInputs> | undefined;
    try {
      bound = bindBlueprintInputs(blueprint, values);
    } catch (error) {
      if (error instanceof BlueprintError && error.code === BLUEPRINT_CODE.INPUT_REQUIRED) {
        return { ok: false };
      }
      diagnostics.push({
        code: "blueprint.input",
        message: "A blueprint input is missing or has the wrong type.",
        severity: "error",
        path: error instanceof BlueprintError ? error.path : undefined,
      });
      return { ok: false };
    }
    const boundSecret = secretFindingsOfConfig(bound.patch, bound.settings);
    if (boundSecret) {
      diagnostics.push({
        code: "blueprint.secret",
        message: "The bound configuration contains a secret and cannot be applied.",
        severity: "error",
        path: boundSecret,
      });
    }
    const directoryError = directoryInputError(this.ports.home, blueprint, values);
    if (directoryError) {
      diagnostics.push({
        code: "blueprint.directory.protected",
        message: directoryError,
        severity: "error",
      });
    }
    const modelError = await this.modelAvailabilityError(bound.model);
    if (modelError) {
      diagnostics.push({ code: "blueprint.model", message: modelError, severity: "error" });
    }
    const compositionError = await this.compositionPreflightError(blueprint);
    if (compositionError) {
      diagnostics.push({ code: "blueprint.compose", message: compositionError, severity: "error" });
    } else if (blueprint.profile.patch.length > 0 || blueprint.profile.bundles.length > 0) {
      diagnostics.push({
        code: "blueprint.compose.pending",
        message: "Patch modules and overlays are verified after the selected packages are installed.",
        severity: "info",
      });
    }
    const homePatchError = await this.homePatchOverrideError();
    if (homePatchError) {
      diagnostics.push({ code: "blueprint.home-patch", message: homePatchError, severity: "error" });
    }
    const ok =
      blocking.errors.length === 0 &&
      !secret &&
      !boundSecret &&
      !directoryError &&
      !modelError &&
      !compositionError &&
      !homePatchError;
    return { ok };
  }

  async apply(planId: string, ctx: WorkbenchJobContext): Promise<WorkbenchBlueprintApplyOutcome> {
    const outcome = emptyOutcome(this.portHostVersions(), []);
    const publish = (next: WorkbenchBlueprintApplyOutcome) => {
      const copy = sanitizeOutcome(cloneOutcome(next));
      ctx.result(resultOf(copy));
      return copy;
    };
    const failCreate = (message: string): never => {
      outcome.stages["space-create"] = failStage(message);
      markRemainingPackages(outcome, "not-run");
      markWrites(outcome, "not-run");
      throw afterFailure(publish(outcome), message);
    };

    try {
      throwIfAborted(ctx.signal);
    } catch {
      failCreate("The blueprint apply was cancelled.");
    }

    let staged: StagedPlan;
    try {
      outcome.host = hostOutcome(await this.hostVersions());
      const live = await this.captureObservation();
      staged = this.consumePlan(planId, live);
    } catch (error) {
      if ((error as { outcome?: WorkbenchBlueprintApplyOutcome }).outcome) throw error;
      return failCreate(
        isInspectRuntimeFailure(error) ? INSPECT_RUNTIME_FAILED : durableFailureReason(error, "space-create"),
      );
    }
    outcome.packageResults = staged.blueprint.packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      status: "not-run",
    }));
    const sourceName = safeBlueprintLabel(staged.blueprint.metadata.name);
    if (sourceName) outcome.source = { name: sourceName, version: staged.blueprint.metadata.version };

    const blocking = blockingApplyDiagnostics(staged.blueprint);
    if (blocking.errors.length) failCreate(blocking.errors[0]!);
    const secret = secretFindingsOfBlueprint(staged.blueprint);
    if (secret) failCreate("The blueprint contains a secret and cannot be applied.");

    let bound: ReturnType<typeof bindBlueprintInputs>;
    try {
      bound = bindBlueprintInputs(staged.blueprint, staged.values);
    } catch {
      failCreate("A blueprint input is missing or has the wrong type.");
    }
    bound = bound!;
    if (secretFindingsOfConfig(bound.patch, bound.settings)) {
      failCreate("The bound configuration contains a secret and cannot be applied.");
    }
    const directoryError = directoryInputError(this.ports.home, staged.blueprint, staged.values);
    if (directoryError) failCreate(directoryError);
    const modelError = await this.modelAvailabilityError(bound.model);
    if (modelError) failCreate(modelError);
    let homePatchError: string | undefined;
    try {
      homePatchError = await this.homePatchOverrideError();
    } catch (error) {
      return failCreate(
        isInspectRuntimeFailure(error) ? INSPECT_RUNTIME_FAILED : durableFailureReason(error, "space-create"),
      );
    }
    if (homePatchError) failCreate(homePatchError);

    ctx.phase("space-create");
    try {
      throwIfAborted(ctx.signal);
      await this.ports.createSpace(
        { name: staged.name, displayName: staged.displayName || sourceName || "blueprint" },
        ctx,
      );
      if (!this.ports.listSpaces().some((row) => row.id === staged.name)) {
        failCreate("The space was not created.");
      }
      outcome.spaceId = staged.name;
      outcome.stages["space-create"] = { status: "succeeded" };
      publish(outcome);
    } catch (error) {
      if (this.ports.listSpaces().some((row) => row.id === staged.name)) {
        outcome.spaceId = staged.name;
      }
      if (isAbortError(error)) failCreate("The blueprint apply was cancelled.");
      if ((error as { outcome?: WorkbenchBlueprintApplyOutcome }).outcome) throw error;
      failCreate(durableFailureReason(error, "space-create"));
    }

    ctx.phase("packages");
    const installed: BlueprintInstalledIdentity[] = [];
    try {
      for (const [index, pkg] of staged.blueprint.packages.entries()) {
        throwIfAborted(ctx.signal);
        if (pkg.source.type !== "npm") {
          throw publicError(GITHUB_APPLY_MESSAGE);
        }
        const prepared = await this.preparePackage(pkg, ctx.signal);
        try {
          await this.ports.installPlugin(staged.name, prepared.archivePath);
        } catch (error) {
          throw publicError(durableFailureReason(error, "packages"));
        }
        const actual = readInstalledIdentity(this.ports.home, staged.name, pkg.name);
        if (!actual || actual.name !== prepared.name || actual.version !== prepared.version) {
          throw publicError("Installed package identity does not match the prepared archive.");
        }
        const identity = {
          name: prepared.name,
          version: prepared.version,
          integrity: prepared.integrity,
        };
        installed.push(identity);
        outcome.packageResults[index] = { name: pkg.name, version: pkg.version, status: "succeeded" };
        outcome.installed = [...installed];
        publish(outcome);
      }
      composeBundles(this.ports.home, staged.name, staged.blueprint.profile.bundles, { includeLlmBridge: false });
      const compositionError = await this.compositionError(staged.name, staged.blueprint, bound.patch);
      if (compositionError) throw publicError(compositionError);
      outcome.host = hostOutcome(await this.hostVersions(staged.name));
      outcome.stages.packages = { status: "succeeded" };
      publish(outcome);
    } catch (error) {
      const message = isAbortError(error)
        ? "The blueprint apply was cancelled."
        : durableFailureReason(error, "packages");
      const failedIndex = outcome.packageResults.findIndex((row) => row.status === "not-run");
      if (failedIndex >= 0) {
        outcome.packageResults[failedIndex] = {
          ...outcome.packageResults[failedIndex]!,
          status: "failed",
          error: message,
        };
        for (let index = failedIndex + 1; index < outcome.packageResults.length; index++) {
          outcome.packageResults[index] = { ...outcome.packageResults[index]!, status: "not-run" };
        }
      }
      outcome.installed = installed;
      outcome.stages.packages = failStage(message);
      markWrites(outcome, "not-run");
      throw afterFailure(publish(outcome), message);
    }

    ctx.phase("presets");
    const writes: BlueprintWriteResult[] = [
      { kind: "patch", status: "not-run" },
      { kind: "settings", status: "not-run" },
      { kind: "model", status: "not-run" },
      { kind: "provenance", status: "not-run" },
    ];
    outcome.writes = writes;
    let currentWrite: BlueprintWriteKind | undefined;
    try {
      throwIfAborted(ctx.signal);
      currentWrite = "patch";
      this.writeBoundPatch(staged.name, bound.patch);
      writes[0] = { kind: "patch", status: "succeeded" };
      currentWrite = undefined;
      outcome.writes = [...writes];
      publish(outcome);
      currentWrite = "settings";
      writeBoundSettings(this.ports.home, staged.name, bound.settings);
      writes[1] = { kind: "settings", status: "succeeded" };
      currentWrite = undefined;
      outcome.writes = [...writes];
      publish(outcome);
      if (bound.model) {
        currentWrite = "model";
        await this.bindModel(staged.name, bound.model);
        writes[2] = { kind: "model", status: "succeeded" };
        currentWrite = undefined;
      }
      outcome.writes = [...writes];
      publish(outcome);
      composeBundles(this.ports.home, staged.name, staged.blueprint.profile.bundles, {
        includeLlmBridge: Boolean(bound.model),
      });
      if (bound.model) {
        const lateError = await this.compositionError(staged.name, staged.blueprint, bound.patch, { force: true });
        if (lateError) throw publicError(lateError);
      }
      currentWrite = "provenance";
      writeProvenance(this.ports.home, staged.name, staged.blueprint, staged.values);
      writes[3] = { kind: "provenance", status: "succeeded" };
      currentWrite = undefined;
      outcome.writes = [...writes];
      outcome.host = hostOutcome(await this.hostVersions(staged.name));
      outcome.stages.presets = { status: "succeeded" };
      publish(outcome);
    } catch (error) {
      const message = isAbortError(error)
        ? "The blueprint apply was cancelled."
        : durableFailureReason(error, "presets");
      if (currentWrite) {
        const row = writes.find((item) => item.kind === currentWrite && item.status === "not-run");
        if (row) {
          row.status = "failed";
          row.error = message;
        }
      }
      outcome.writes = [...writes];
      outcome.stages.presets = failStage(message);
      throw afterFailure(publish(outcome), message);
    }

    outcome.stages.start = { status: "not-run" };
    return publish(outcome);
  }

  private consumePlan(planId: string, live: PlanObservation): StagedPlan {
    const now = this.nowMs();
    this.prunePlans(now);
    const staged = this.plans.get(planId);
    if (!staged) throw publicError("This preview is no longer valid. Preview again.");
    if (staged.consumed) throw publicError("This preview is no longer valid. Preview again.");
    if (staged.expiresAt <= now) {
      this.deletePlan(planId);
      throw publicError("This preview is no longer valid. Preview again.");
    }
    if (!observationsMatch(staged.observation, live)) {
      this.deletePlan(planId);
      throw publicError("The target changed. Request a new preview.");
    }
    staged.consumed = true;
    this.deletePlan(planId);
    return staged;
  }

  private deletePlan(planId: string): void {
    const staged = this.plans.get(planId);
    if (!staged) return;
    this.plans.delete(planId);
    this.totalPlanBytes = Math.max(0, this.totalPlanBytes - staged.bytes);
  }

  private prunePlans(now: number): void {
    for (const [id, row] of this.plans) {
      if (row.expiresAt <= now || row.consumed) this.deletePlan(id);
    }
  }

  private async captureObservation(): Promise<PlanObservation> {
    const observation = this.ports.observation();
    const host = await this.hostVersions();
    const catalog = this.ports.llmCatalogObservation?.() ?? { revision: 0, digest: sha256Hex("") };
    const inspected = await this.inspectRuntimeSnapshot();
    return {
      serviceEpoch: observation.serviceEpoch,
      stateRevision: observation.expectedRevision,
      dshVersion: host.dsh,
      hostBaseVersion: host.base,
      hostWebAppVersion: host.webApp,
      homeSettingsDigest: fileDigest(settingsPath(this.ports.home)),
      homePatchDigest: fileDigest(join(this.ports.home, "cordis.patch.yml")),
      runtimeFingerprint: inspected?.fingerprint ?? sha256Hex(`${host.dsh ?? ""}|${host.base ?? ""}|${host.webApp ?? ""}|${fileDigest(join(this.ports.home, "cordis.patch.yml"))}`),
      llmCatalogRevision: catalog.revision,
      llmCatalogDigest: catalog.digest,
    };
  }

  async hostVersions(_spaceId?: string): Promise<BlueprintHostVersions> {
    const inspected = await this.inspectRuntimeSnapshot();
    const ports = this.portHostVersions();
    return {
      ...ports,
      dsh: exactOrNull(inspected?.versions.dsh ?? this.ports.dshVersion?.() ?? null),
      base: exactOrNull(inspected?.versions.base ?? null),
      webApp: exactOrNull(inspected?.versions.webApp ?? null),
    };
  }

  private portHostVersions(): BlueprintHostVersions {
    return {
      dsh: exactOrNull(this.ports.dshVersion?.() ?? null),
      spaces: exactOrNull(this.ports.spacesVersion?.() ?? null),
      node: process.versions.node,
      os: process.platform,
      arch: process.arch,
      base: null,
      webApp: null,
    };
  }

  private runtimeOptions(): BlueprintRuntimeOptions | null {
    const bin = this.ports.runtimeBin?.();
    if (!bin) return null;
    return { home: this.ports.home, bin };
  }

  private async inspectRuntimeSnapshot(): Promise<BlueprintRuntimeInspect | null> {
    const options = this.runtimeOptions();
    if (!options || !this.ports.inspectRuntime) return null;
    try {
      return await this.ports.inspectRuntime(options);
    } catch {
      throw publicError(INSPECT_RUNTIME_FAILED);
    }
  }

  private async modelAvailabilityError(model: { connectionId: string; modelId: string } | undefined): Promise<string | undefined> {
    if (!model) return undefined;
    if (this.ports.llmBridgeAvailable?.() !== true) {
      return "This Home cannot apply a model binding.";
    }
    try {
      const catalog = asDescribe(await (this.ports.llmAdmitted ?? this.ports.llm)({ method: "describe" }));
      const connection = catalog.connections.find((row) => row.id === model.connectionId);
      if (!connection || connection.enabled !== true) return "The selected model connection is not available.";
      const models = Array.isArray(connection.providerConfig.models)
        ? connection.providerConfig.models.flatMap((item) =>
            item && typeof item === "object" && "id" in item && typeof (item as { id?: unknown }).id === "string"
              ? [(item as { id: string }).id]
              : [],
          )
        : [];
      if (!models.includes(model.modelId)) return "The selected model is not available on that connection.";
      return undefined;
    } catch {
      return "The model catalog could not be read.";
    }
  }

  private async homePatchOverrideError(): Promise<string | undefined> {
    const inspected = await this.inspectRuntimeSnapshot();
    if (!inspected) return undefined;
    if (homePatchesOverrideManaged(inspected.homePatches)) {
      return "Home configuration overrides managed isolation or control entries.";
    }
    return undefined;
  }

  private async compositionPreflightError(blueprint: Blueprint): Promise<string | undefined> {
    if (blueprint.profile.patch.length === 0 && blueprint.profile.bundles.length === 0) return undefined;
    const options = this.runtimeOptions();
    if (!options || !this.ports.composeRuntime) {
      return "Blueprint composition cannot be verified.";
    }
    return undefined;
  }

  private async compositionError(
    spaceId: string,
    blueprint: Blueprint,
    patch: BlueprintPatch,
    extra?: { force?: boolean },
  ): Promise<string | undefined> {
    if (!extra?.force && patch.length === 0 && blueprint.profile.bundles.length === 0) return undefined;
    const options = this.runtimeOptions();
    if (!options || !this.ports.composeRuntime) {
      return "Blueprint composition cannot be verified.";
    }

    let composed: BlueprintRuntimeCompose;
    try {
      composed = await this.ports.composeRuntime(options, {
        spaceId,
        bundles: readProfileManifest(this.ports.home, spaceId).bundles,
        patch,
      });
    } catch (error) {
      return compositionFailureReason(error);
    }
    const skipped = officialSkippedBlueprintOverlay(composed.warnings, patch);
    if (skipped) return skipped;
    const identity = selectedBundleIdentityError(blueprint, composed.layers);
    if (identity) return identity;
    const isolation = composedManagedIsolationError(composed.entries, spaceId);
    if (isolation) return isolation;

    const specifiers = patchModuleSpecifiers(patch);
    if (specifiers.length === 0) return undefined;
    if (!this.ports.resolveModule) return "Blueprint composition cannot be verified.";
    let inspected: BlueprintRuntimeInspect | null;
    try {
      inspected = await this.inspectRuntimeSnapshot();
    } catch {
      return INSPECT_RUNTIME_FAILED;
    }
    const evidence = moduleResolutionEvidence(this.ports.home, spaceId, blueprint, composed, inspected);
    for (const specifier of specifiers) {
      let resolved: BlueprintRuntimeModule;
      try {
        resolved = await this.ports.resolveModule(options, { spaceId, specifier });
      } catch (error) {
        return compositionFailureReason(error, "A patch module could not be resolved.");
      }
      if (resolved.builtin) continue;
      if (!resolved.resolvedPath) return "A patch module could not be resolved.";
      const selected = blueprint.packages.find((pkg) => pkg.name === resolved.packageName);
      if (selected) {
        if (!resolved.packageVersion || resolved.packageVersion !== selected.version) {
          return `Package ${selected.name} resolved to a different version than the selected pin.`;
        }
        continue;
      }
      if (!resolvedIdentityAllowed(resolved, evidence)) {
        return "A patch module does not resolve to a selected, transitive, or host package.";
      }
    }
    return undefined;
  }

  private async preparePackage(pkg: BlueprintPackage, signal?: AbortSignal): Promise<PreparedBlueprintPackage> {
    const prepare = this.ports.prepareBlueprintPackage ?? prepareBlueprintPackage;
    try {
      return await prepare(this.ports.home, pkg, { fetchImpl: this.ports.fetchImpl, signal });
    } catch (error) {
      if (error instanceof BlueprintPackageError && error.code === "github-unsupported") {
        throw publicError(GITHUB_APPLY_MESSAGE);
      }
      throw error;
    }
  }

  private writeBoundPatch(spaceId: string, patch: BlueprintPatch): void {
    assertPatchSafeToApply(patch, spaceId);
    const yaml = stringifyYaml(patch, { lineWidth: 0, schema: "json" });
    const isolated = applyIsolationPatch(yaml.endsWith("\n") ? yaml : `${yaml}\n`, spaceId, "blueprint.patch");
    if (!patchTextLooksConfigIsolated(isolated, spaceId)) {
      throw publicError("The blueprint config does not isolate this space.");
    }
    if (defeatsIsolation(isolated, spaceId)) {
      throw publicError("The blueprint config points at a protected Home path.");
    }
    const writer = this.ports.writePatch ?? ((id: string, body: string) => {
      atomicWrite(join(this.ports.home, "profiles", id, "cordis.patch.yml"), body);
    });
    writer(spaceId, isolated);
  }

  private async bindModel(spaceId: string, model: { connectionId: string; modelId: string }): Promise<void> {
    const llm = this.ports.llmAdmitted;
    if (!llm) throw publicError("This Home cannot apply a model binding.");
    try {
      const catalog = asDescribe(await llm({ method: "describe" }));
      const connection = catalog.connections.find((row) => row.id === model.connectionId);
      if (!connection || connection.enabled !== true) {
        throw publicError("The selected model connection is not available.");
      }
      const models = Array.isArray(connection.providerConfig.models)
        ? connection.providerConfig.models.flatMap((item) =>
            item && typeof item === "object" && "id" in item && typeof (item as { id?: unknown }).id === "string"
              ? [(item as { id: string }).id]
              : [],
          )
        : [];
      if (!models.includes(model.modelId)) {
        throw publicError("The selected model is not available on that connection.");
      }
      const policy = asSpacePolicy(await llm({ method: "spacePolicy", spaceId }));
      await llm({
        method: "updateSpacePolicy",
        spaceId,
        shared: { mode: "selected", connectionIds: [model.connectionId] },
        expectedRevision: policy.policy.revision,
      });
      await llm({
        method: "updateSpaceDefault",
        spaceId,
        model: { connectionId: model.connectionId, modelId: model.modelId },
      });
    } catch (error) {
      if (isPublicError(error)) throw error;
      throw publicError(modelWriteFailureReason(error));
    }
  }

  private requireMutableSpace(spaceId: string, options: { mustExist?: boolean }): string {
    assertMutableName(spaceId, this.ports.managerId());
    if (options.mustExist && !this.ports.listSpaces().some((row) => row.id === spaceId)) {
      throw publicError("That space was not found.");
    }
    return spaceId;
  }

  private requireNewSpaceName(name: string): string {
    assertMutableName(name, this.ports.managerId());
    if (this.ports.listSpaces().some((row) => row.id === name)) {
      throw publicError("A space with that name already exists.");
    }
    return name;
  }

  private nowMs(): number {
    return (this.ports.now?.() ?? new Date()).getTime();
  }
}

function decodeContent(content: string): Blueprint {
  try {
    return decodeBlueprint(content);
  } catch (error) {
    throw publicError(sanitizeBlueprintError(error));
  }
}

function buildGeneratedBlueprint(
  home: string,
  spaceId: string,
  input: {
    selection: BlueprintGenerateSelection;
    metadata: { name: string; version: string; description?: string };
    bindingOverrides?: BlueprintGenerateBindingOverride[];
  },
): Blueprint {
  const origin = readOrigin(home, spaceId);
  const manifest = readProfileManifest(home, spaceId);
  const library = readPluginLibrary(home);
  const available = sourcePackages(home, spaceId, manifest, library);
  const selected = unique(input.selection.packages);
  for (const name of selected) {
    const row = available.find((item) => item.name === name);
    if (!row) throw publicError(`Package ${name} is not a direct dependency of this space.`, `/packages/${name}`);
    if (!row.eligibility.available) {
      throw publicError(row.eligibility.reason ?? `Package ${name} cannot be included.`, `/packages/${name}`);
    }
  }

  let patch: BlueprintPatch = [];
  if (input.selection.includePatch) {
    const patchState = convertSourcePatch(home, spaceId);
    if (patchState.secret) {
      throw publicError("The selected configuration contains a secret and cannot be shared.", "/profile/patch");
    }
    if (!patchState.shareable && !patchState.convertible) {
      throw publicError(patchState.reason ?? "The selected configuration preset cannot be shared.", "/profile/patch");
    }
    patch = patchState.patch;
  }
  const described = describeSettings(home, spaceId);
  let settings: BlueprintSettings = {};
  for (const namespace of unique(input.selection.settingsNamespaces)) {
    const row = described.find((item) => item.info.namespace === namespace);
    if (!row) throw publicError(`Settings namespace ${namespace} was not found.`, `/profile/settings/${namespace}`);
    if (row.info.reason && !row.info.convertible && !row.info.shareable) {
      throw publicError(row.info.reason, `/profile/settings/${namespace}`);
    }
    if (!row.info.shareable && !row.info.convertible) {
      throw publicError(row.info.reason ?? `Settings namespace ${namespace} cannot be shared.`, `/profile/settings/${namespace}`);
    }
    settings[namespace] = row.value;
  }

  const packages: BlueprintPackage[] = selected.map((name) => {
    const row = available.find((item) => item.name === name)!;
    const pkg: BlueprintPackage = {
      name,
      version: row.version as string,
      source: { type: "npm" },
    };
    if (row.integrity) pkg.integrity = row.integrity;
    return pkg;
  });
  const bundles = manifest.bundles.filter((name) => selected.includes(name));
  let inputs: BlueprintInput[] = [];
  let bindings: BlueprintBinding[] = [];
  const overrides = input.bindingOverrides ?? [];

  if (origin) {
    const restored = restoreProvenanceOnCurrent(
      origin,
      patch,
      settings,
      input.selection.includePatch,
      unique(input.selection.settingsNamespaces),
      overrides,
    );
    patch = restored.patch;
    settings = restored.settings;
    inputs = restored.inputs;
    bindings = restored.bindings;
  }

  ({ patch, settings, inputs, bindings } = applyBindingOverrides(patch, settings, inputs, bindings, overrides));

  const leftover = findUndeclaredLocals(patch, settings, bindings);
  if (leftover) {
    throw publicError("A local value must be declared as an input.", leftover);
  }
  const secret = secretFindingsOfConfig(patch, settings);
  if (secret) {
    throw publicError("The selected configuration contains a secret and cannot be shared.", secret);
  }

  const model = maybeModelInput(home, spaceId, origin);
  if (model && !inputs.some((item) => item.id === model.input.id)) {
    inputs = [...inputs, model.input];
    bindings = [...bindings, model.binding];
  }

  const object: Record<string, unknown> = {
    kind: "dsh-blueprint",
    formatVersion: 1,
    metadata: metadataOf(input.metadata),
    packages,
    profile: { base: "web", bundles, patch, settings },
  };
  if (inputs.length) object.inputs = inputs;
  if (bindings.length) object.bindings = bindings;
  if (origin?.blueprint.relations?.length) {
    object.relations = origin.blueprint.relations.filter(
      (relation) => selected.includes(relation.from) || selected.includes(relation.to),
    );
  }
  if (origin?.blueprint.extensions) object.extensions = origin.blueprint.extensions;
  return parseBlueprint(object);
}

function restoreProvenanceOnCurrent(
  origin: BlueprintOriginRecord,
  patch: BlueprintPatch,
  settings: BlueprintSettings,
  includePatch: boolean,
  namespaces: string[],
  overrides: BlueprintGenerateBindingOverride[],
): {
  patch: BlueprintPatch;
  settings: BlueprintSettings;
  inputs: BlueprintInput[];
  bindings: BlueprintBinding[];
} {
  const nextPatch = cloneJson(patch);
  const nextSettings = cloneJson(settings);
  const inputs: BlueprintInput[] = [];
  const bindings: BlueprintBinding[] = [];
  const root = { profile: { patch: nextPatch, settings: nextSettings } };
  for (const recorded of origin.bindings) {
    const input = origin.blueprint.inputs.find((item) => item.id === recorded.input);
    if (!input) continue;
    if (recorded.kind === "default-model") {
      if (!inputs.some((item) => item.id === input.id)) inputs.push(input);
      bindings.push({ input: input.id, target: { kind: "default-model" } });
      continue;
    }
    if (!recorded.pointer) continue;
    if (recorded.pointer.startsWith("/profile/patch") && !includePatch) continue;
    const namespace = recorded.namespace ?? settingsNamespaceOf(recorded.pointer);
    if (namespace && !namespaces.includes(namespace)) continue;
    const located = locateProvenancePointer(root, recorded);
    const remap = authoritativeRemapPointer(root, recorded, overrides);
    if (located.ok) {
      const replaced = overrides.some(
        (item) => item.pointer === located.pointer || item.input.id === recorded.input,
      );
      setPointer(root as unknown as BlueprintJsonObject, located.pointer, null);
      if (replaced) continue;
      if (!inputs.some((item) => item.id === input.id)) inputs.push(input);
      bindings.push({ input: input.id, target: { kind: "value", pointer: located.pointer } });
      continue;
    }
    if (remap) {
      setPointer(root as unknown as BlueprintJsonObject, remap, null);
      continue;
    }
    throw publicError(
      "A binding location changed and needs an explicit override.",
      recorded.pointer,
    );
  }
  return { patch: nextPatch, settings: nextSettings, inputs, bindings };
}

function authoritativeRemapPointer(
  root: { profile: { patch: BlueprintPatch; settings: BlueprintSettings } },
  recorded: BlueprintOriginRecord["bindings"][number],
  overrides: BlueprintGenerateBindingOverride[],
): string | undefined {
  if (!recorded.pointer) return undefined;
  if (recorded.pointer.startsWith("/profile/settings")) {
    const hit = overrides.find((item) => item.pointer === recorded.pointer && pointerExists(root, item.pointer));
    return hit?.pointer;
  }
  const uniquePointer = uniqueEntryConfigPointer(root, recorded);
  if (!uniquePointer) return undefined;
  const hit = overrides.find((item) => item.pointer === uniquePointer);
  return hit ? uniquePointer : undefined;
}

function uniqueEntryConfigPointer(
  root: { profile: { patch: BlueprintPatch } },
  recorded: BlueprintOriginRecord["bindings"][number],
): string | undefined {
  if (!recorded.entryId || !recorded.pointer) return undefined;
  const suffix = configBindingSuffix(recorded.pointer);
  if (suffix === undefined) return undefined;
  const matches: string[] = [];
  walkAllPatchEntries(root.profile.patch, (entry, pointer) => {
    if (entry.id === recorded.entryId) matches.push(`${pointer}${suffix}`);
  });
  const uniqueMatches = unique(matches);
  return uniqueMatches.length === 1 ? uniqueMatches[0] : undefined;
}

function locateProvenancePointer(
  root: { profile: { patch: BlueprintPatch; settings: BlueprintSettings } },
  recorded: BlueprintOriginRecord["bindings"][number],
): { ok: true; pointer: string } | { ok: false } {
  const recordedPointer = recorded.pointer;
  if (!recordedPointer) return { ok: false };
  if (recordedPointer.startsWith("/profile/settings")) {
    if (pointerExists(root, recordedPointer)) return { ok: true, pointer: recordedPointer };
    const parentPointer = parentJsonPointer(recordedPointer);
    if (!parentPointer || !pointerExists(root, parentPointer)) return { ok: false };
    const parent = readPointer(root as unknown as BlueprintJson, parentPointer);
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) return { ok: false };
    const leaf = lastJsonPointerToken(recordedPointer);
    if (!leaf) return { ok: false };
    (parent as BlueprintJsonObject)[leaf] = null;
    return { ok: true, pointer: recordedPointer };
  }
  if (recorded.entryId) {
    const suffix = configBindingSuffix(recordedPointer);
    if (suffix === undefined) return { ok: false };
    const matches: string[] = [];
    walkAllPatchEntries(root.profile.patch, (entry, pointer) => {
      if (entry.id !== recorded.entryId) return;
      if (recorded.entryName && entry.name !== recorded.entryName) return;
      matches.push(`${pointer}${suffix}`);
    });
    const uniqueMatches = unique(matches);
    if (uniqueMatches.length === 1) {
      const pointer = uniqueMatches[0]!;
      if (pointerExists(root, pointer)) return { ok: true, pointer };
      const parentPointer = parentJsonPointer(pointer);
      if (parentPointer && pointerExists(root, parentPointer)) {
        const parent = readPointer(root as unknown as BlueprintJson, parentPointer);
        if (parent && typeof parent === "object" && !Array.isArray(parent)) {
          const leaf = lastJsonPointerToken(pointer);
          if (leaf) {
            (parent as BlueprintJsonObject)[leaf] = null;
            return { ok: true, pointer };
          }
        }
      }
      return { ok: false };
    }
    return { ok: false };
  }
  if (pointerExists(root, recordedPointer)) return { ok: true, pointer: recordedPointer };
  return { ok: false };
}

function applyBindingOverrides(
  patch: BlueprintPatch,
  settings: BlueprintSettings,
  inputs: BlueprintInput[],
  bindings: BlueprintBinding[],
  overrides: BlueprintGenerateBindingOverride[],
): { patch: BlueprintPatch; settings: BlueprintSettings; inputs: BlueprintInput[]; bindings: BlueprintBinding[] } {
  const nextPatch = cloneJson(patch);
  const nextSettings = cloneJson(settings);
  const nextInputs = [...inputs];
  const nextBindings = [...bindings];
  const root: { profile: { patch: BlueprintPatch; settings: BlueprintSettings } } = {
    profile: { patch: nextPatch, settings: nextSettings },
  };
  for (const override of overrides) {
    if (!pointerExists(root, override.pointer)) {
      throw publicError(`Binding override path ${override.pointer} does not exist.`, override.pointer);
    }
    const existing = nextBindings.find((item) => item.input === override.input.id);
    if (existing) {
      if (existing.target.kind === "value" && existing.target.pointer === override.pointer) continue;
      throw publicError(`Input ${override.input.id} is already declared.`);
    }
    if (nextInputs.some((item) => item.id === override.input.id)) {
      throw publicError(`Input ${override.input.id} is already declared.`);
    }
    setPointer(root as unknown as BlueprintJsonObject, override.pointer, null);
    nextInputs.push(override.input);
    nextBindings.push({ input: override.input.id, target: { kind: "value", pointer: override.pointer } });
  }
  return { patch: nextPatch, settings: nextSettings, inputs: nextInputs, bindings: nextBindings };
}

function sourcePackages(
  home: string,
  spaceId: string,
  manifest: ProfileManifest,
  library: ReturnType<typeof readPluginLibrary>,
): BlueprintSourcePackage[] {
  const rows: BlueprintSourcePackage[] = [];
  for (const [name, requestedSpec] of Object.entries(manifest.dependencies)) {
    if (HOST_PACKAGE_SET.has(name) || CONTROL_PACKAGE_SET.has(name) || isOwnedBridgeName(name)) continue;
    const version = readInstalledVersion(home, spaceId, name);
    const installed = readInstalledManifest(home, spaceId, name);
    const origin = resolveNpmOrigin(name, requestedSpec, version, library, home, spaceId);
    const eligibility = packageEligibility(origin, version, installed);
    const row: BlueprintSourcePackage = {
      name,
      version,
      source: origin.source,
      inBundles: manifest.bundles.includes(name),
      hasBundlePatch: Boolean(installed?.hasBundle),
      eligibility,
      lifecycleScripts: installed?.lifecycleScripts ?? [],
    };
    if (origin.publicSpec) row.requestedSpec = origin.publicSpec;
    if (origin.integrity) row.integrity = origin.integrity;
    rows.push(row);
  }
  return rows;
}

function sourceBundles(bundles: string[], packages: BlueprintSourcePackage[]): BlueprintSourceBundle[] {
  return bundles
    .filter((name) => !HOST_PACKAGE_SET.has(name) && !CONTROL_PACKAGE_SET.has(name) && !isOwnedBridgeName(name))
    .map((name, order) => {
      const pkg = packages.find((row) => row.name === name);
      if (!pkg) {
        return { name, order, eligible: false, reason: "This layer is not a direct dependency." };
      }
      if (!pkg.eligibility.available) {
        return { name, order, eligible: false, reason: pkg.eligibility.reason };
      }
      if (!pkg.hasBundlePatch) {
        return { name, order, eligible: false, reason: "This package has no bundle patch." };
      }
      return { name, order, eligible: true };
    });
}

function resolveNpmOrigin(
  name: string,
  requestedSpec: string,
  version: string | null,
  library: ReturnType<typeof readPluginLibrary>,
  home: string,
  spaceId: string,
): { source: BlueprintSourcePackage["source"]; publicSpec?: string; integrity?: string } {
  if (isGitSpec(requestedSpec) || requestedSpec.startsWith("link:") || requestedSpec.startsWith(".")) {
    return { source: "local" };
  }
  if (requestedSpec.startsWith("file:")) {
    return resolveFileArchiveOrigin(name, requestedSpec, version, library, home, spaceId);
  }
  const exact = isExactRuntimeVersion(requestedSpec) ? requestedSpec : null;
  const pin = parseNpmNameAndVersion(requestedSpec);
  const libraryHit = library.find((entry) => {
    if (entry.packageName !== name) return false;
    const parsed = parseNpmNameAndVersion(entry.spec);
    const wanted = pin?.version ?? exact ?? version;
    return Boolean(wanted && parsed?.version === wanted);
  });
  if (pin && pin.name === name) {
    return {
      source: "npm",
      publicSpec: `${name}@${pin.version}`,
      integrity: hashedLibraryIntegrity(home, libraryHit),
    };
  }
  if (exact) {
    return {
      source: "npm",
      publicSpec: `${name}@${exact}`,
      integrity: hashedLibraryIntegrity(home, libraryHit),
    };
  }
  if (libraryHit && parseNpmNameAndVersion(libraryHit.spec)) {
    const parsed = parseNpmNameAndVersion(libraryHit.spec)!;
    return {
      source: "npm",
      publicSpec: `${name}@${parsed.version}`,
      integrity: hashedLibraryIntegrity(home, libraryHit),
    };
  }
  return { source: "unknown" };
}

function resolveFileArchiveOrigin(
  name: string,
  requestedSpec: string,
  version: string | null,
  library: ReturnType<typeof readPluginLibrary>,
  home: string,
  spaceId: string,
): { source: BlueprintSourcePackage["source"]; publicSpec?: string; integrity?: string } {
  const raw = requestedSpec.slice("file:".length).trim();
  if (!raw || raw.includes("\0")) return { source: "local" };
  const profileDir = join(home, "profiles", spaceId);
  if (!containedIn(home, profileDir)) return { source: "local" };
  const archive = isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? resolve(raw) : resolve(profileDir, raw);
  if (!isHubPluginArchive(home, archive)) return { source: "local" };
  try {
    const st = lstatSync(archive);
    if (st.isSymbolicLink()) {
      const real = realpathSync(archive);
      if (!isHubPluginArchive(home, real)) return { source: "local" };
    } else if (!st.isFile()) {
      return { source: "local" };
    }
  } catch {
    return { source: "local" };
  }
  const libraryHit = library.find((entry) => {
    if (entry.packageName !== name) return false;
    if (!entry.tarball) return false;
    const recorded = isAbsolute(entry.tarball) ? entry.tarball : join(home, entry.tarball);
    return sameResolved(recorded, archive);
  });
  if (!libraryHit) return { source: "local" };
  const parsed = parseNpmNameAndVersion(libraryHit.spec);
  if (!parsed || parsed.name !== name) return { source: "local" };
  if (!version || parsed.version !== version) return { source: "local" };
  const integrity = hashedLibraryIntegrity(home, libraryHit);
  if (!integrity) return { source: "unknown" };
  return {
    source: "npm",
    publicSpec: `${parsed.name}@${parsed.version}`,
    integrity,
  };
}

function hashedLibraryIntegrity(
  home: string,
  entry: { tarball?: string } | undefined,
): string | undefined {
  if (!entry?.tarball) return undefined;
  return tarballIntegrity(home, entry.tarball);
}

function packageEligibility(
  origin: { source: BlueprintSourcePackage["source"] },
  version: string | null,
  installed: InstalledManifest | null,
): BlueprintEligibility {
  if (origin.source !== "npm") {
    return { available: false, reason: "Only packages with an npm origin can be included." };
  }
  if (!version || !isExactRuntimeVersion(version)) {
    return { available: false, reason: "The installed version is unknown." };
  }
  if (!installed) {
    return { available: false, reason: "The installed package manifest could not be read." };
  }
  return { available: true };
}

function describePatch(home: string, spaceId: string): { info: BlueprintSourcePatchInfo; observations: BlueprintLocalObservation[] } {
  const converted = convertSourcePatch(home, spaceId);
  return {
    info: {
      exists: converted.exists,
      shareable: converted.shareable,
      reason: converted.reason,
    },
    observations: converted.observations,
  };
}

function describeSettings(
  home: string,
  spaceId: string,
): Array<{ info: BlueprintSourceNamespace; observations: BlueprintLocalObservation[]; value: BlueprintJson }> {
  const path = spaceSettingsPath(home, spaceId);
  if (!existsSync(path)) return [];
  const doc = readProfileSettings(home, spaceId, true);
  if (!isMap(doc.contents)) return [];
  const rows: Array<{ info: BlueprintSourceNamespace; observations: BlueprintLocalObservation[]; value: BlueprintJson }> = [];
  for (const item of doc.contents.items) {
    const namespace = typeof item.key === "string" ? item.key : isScalar(item.key) ? String(item.key.value ?? "") : "";
    if (!namespace) continue;
    const pointer = `/profile/settings/${jsonPointerToken(namespace)}`;
    if (FORBIDDEN_SETTINGS.has(namespace)) {
      rows.push({
        info: {
          namespace,
          eligible: false,
          shareable: false,
          convertible: false,
          reason: "Managed model settings are re-expressed as a model input.",
        },
        observations: [{ pointer, kind: "managed", reason: "Managed model settings are not copied." }],
        value: null,
      });
      continue;
    }
    const dynamics: string[] = [];
    const json = yamlToJson(item.value, pointer, dynamics);
    const observations: BlueprintLocalObservation[] = dynamics.map((path) => ({
      pointer: path,
      kind: "dynamic" as const,
      reason: "Dynamic expressions cannot be shared.",
    }));
    if (jsonLooksCredential(json, pointer, observations) || secretFindingsOfConfig([], { [namespace]: json })) {
      rows.push({
        info: {
          namespace,
          eligible: false,
          shareable: false,
          convertible: false,
          reason: "This namespace looks like a credential preset.",
        },
        observations,
        value: json,
      });
      continue;
    }
    const locals = findLocalPointers(json, pointer);
    observations.push(...locals);
    const convertible = locals.length > 0 && dynamics.length === 0;
    rows.push({
      info: {
        namespace,
        eligible: dynamics.length === 0,
        shareable: dynamics.length === 0 && locals.length === 0,
        convertible,
        reason: dynamics.length
          ? "Dynamic expressions cannot be shared."
          : locals.length
            ? "Local values must be declared as inputs."
            : undefined,
      },
      observations,
      value: json,
    });
  }
  return rows;
}

function convertSourcePatch(
  home: string,
  spaceId: string,
): {
  exists: boolean;
  shareable: boolean;
  convertible: boolean;
  secret: boolean;
  reason?: string;
  patch: BlueprintPatch;
  observations: BlueprintLocalObservation[];
} {
  const path = join(home, "profiles", spaceId, "cordis.patch.yml");
  if (!existsSync(path)) {
    return { exists: false, shareable: true, convertible: false, secret: false, patch: [], observations: [] };
  }
  const text = readFileSync(path, "utf8");
  const observations: BlueprintLocalObservation[] = [];
  const dynamics: string[] = [];
  const patch = yamlPatchToBlueprint(text, spaceId, dynamics, observations);
  if (dynamics.length) {
    return {
      exists: true,
      shareable: false,
      convertible: false,
      secret: false,
      reason: "Dynamic expressions cannot be shared.",
      patch,
      observations: [
        ...observations,
        ...dynamics.map((pointer) => ({ pointer, kind: "dynamic" as const, reason: "Dynamic expressions cannot be shared." })),
      ],
    };
  }
  const secret = Boolean(secretFindingsOfConfig(patch, {}));
  if (secret) {
    return {
      exists: true,
      shareable: false,
      convertible: false,
      secret: true,
      reason: "The selected configuration contains a secret and cannot be shared.",
      patch,
      observations,
    };
  }
  const locals = findLocalPointers(patch as unknown as BlueprintJson, "/profile/patch");
  observations.push(...locals);
  return {
    exists: true,
    shareable: locals.length === 0,
    convertible: locals.length > 0,
    secret: false,
    patch,
    observations,
  };
}

function yamlPatchToBlueprint(
  text: string,
  spaceId: string,
  dynamics: string[],
  observations: BlueprintLocalObservation[],
): BlueprintPatch {
  const doc = parseDocument(text, { customTags: [jsTag], prettyErrors: true, schema: "core" });
  if (doc.errors.length) throw publicError("The space patch could not be read.");
  if (!isSeq(doc.contents)) throw publicError("The space patch is not a YAML sequence.");
  const patch: BlueprintPatch = [];
  doc.contents.items.forEach((item, index) => {
    const pointer = `/profile/patch/${index}`;
    if (!isMap(item)) {
      dynamics.push(pointer);
      return;
    }
    if (item.has("insert")) {
      const insertNode = item.get("insert", true);
      if (!isSeq(insertNode)) {
        dynamics.push(`${pointer}/insert`);
        return;
      }
      const insert: BlueprintPatchEntry[] = [];
      insertNode.items.forEach((entry, insertIndex) => {
        const converted = convertPatchEntry(entry, `${pointer}/insert/${insertIndex}`, spaceId, dynamics, observations);
        if (converted) insert.push(converted);
      });
      const op: BlueprintPatchInsert = { insert };
      if (item.has("id")) {
        const id = isScalar(item.get("id", true)) ? String(item.get("id") ?? "") : "";
        if (id) op.id = id;
      }
      if (insert.length) patch.push(op);
      return;
    }
    const converted = convertPatchEntry(item, pointer, spaceId, dynamics, observations);
    if (converted) patch.push(converted);
  });
  return patch;
}

function convertPatchEntry(
  node: unknown,
  pointer: string,
  spaceId: string,
  dynamics: string[],
  observations: BlueprintLocalObservation[],
): BlueprintPatchEntry | null {
  if (!isMap(node)) {
    dynamics.push(pointer);
    return null;
  }
  const keys = node.items.map((pair) => (isScalar(pair.key) ? String(pair.key.value ?? "") : "")).filter(Boolean);
  const allowed = new Set(["id", "name", "config", "group", "disabled", "inject", "intercept", "isolate"]);
  if (keys.some((key) => !allowed.has(key))) {
    observations.push({ pointer, kind: "unknown", reason: "This patch entry has fields that cannot be shared." });
    dynamics.push(pointer);
    return null;
  }
  const id = isScalar(node.get("id", true)) ? String(node.get("id") ?? "") : "";
  if (!id) {
    dynamics.push(`${pointer}/id`);
    return null;
  }
  if (MANAGED_ENTRY_SET.has(id)) {
    const stripped = stripOwnedEntry(node, id, spaceId, `${pointer}`, dynamics, observations);
    return stripped;
  }
  const entry: BlueprintPatchEntry = { id };
  if (node.has("name")) {
    const name = node.get("name");
    if (typeof name !== "string") {
      dynamics.push(`${pointer}/name`);
      return null;
    }
    if (looksLikeModulePath(name)) {
      observations.push({ pointer: `${pointer}/name`, kind: "unknown", reason: "Patch module references must be package names." });
      dynamics.push(`${pointer}/name`);
      return null;
    }
    entry.name = name;
  }
  if (node.has("disabled")) entry.disabled = yamlBoolOrNull(node, "disabled");
  if (node.has("group")) entry.group = yamlBoolOrNull(node, "group");
  if (node.has("config")) {
    if (entry.group === true && isSeq(node.get("config", true))) {
      const children: BlueprintPatchEntry[] = [];
      const seq = node.get("config", true);
      if (isSeq(seq)) {
        seq.items.forEach((child, index) => {
          const converted = convertPatchEntry(child, `${pointer}/config/${index}`, spaceId, dynamics, observations);
          if (converted) children.push(converted);
        });
      }
      entry.config = children as unknown as BlueprintJson;
    } else {
      const config = yamlToJson(node.get("config", true), `${pointer}/config`, dynamics);
      if (hasJsExpr(config, `${pointer}/config`, dynamics)) return null;
      entry.config = config;
    }
  }
  if (node.has("inject")) entry.inject = yamlToJson(node.get("inject", true), `${pointer}/inject`, dynamics) as BlueprintPatchEntry["inject"];
  if (node.has("intercept")) entry.intercept = yamlToJson(node.get("intercept", true), `${pointer}/intercept`, dynamics) as BlueprintJsonObject;
  if (node.has("isolate")) entry.isolate = yamlToJson(node.get("isolate", true), `${pointer}/isolate`, dynamics) as BlueprintPatchEntry["isolate"];
  return entry;
}

function stripOwnedEntry(
  node: unknown,
  id: string,
  spaceId: string,
  pointer: string,
  dynamics: string[],
  observations: BlueprintLocalObservation[],
): BlueprintPatchEntry | null {
  if (!isMap(node)) return null;
  const configNode = node.get("config", true);
  if (configNode != null && !isMap(configNode)) {
    dynamics.push(`${pointer}/config`);
    return null;
  }
  const extras: BlueprintJsonObject = {};
  if (isMap(configNode)) {
    for (const pair of configNode.items) {
      const key = isScalar(pair.key) ? String(pair.key.value ?? "") : "";
      if (!key) continue;
      if ((id === SESSION_ROW_ID || id === STORAGE_ROW_ID) && key === "root") {
        if (isOwnedIsolationScalar(pair.value, spaceId, id === SESSION_ROW_ID ? "sessions" : "storages")) continue;
        if (isJsScalar(pair.value)) {
          dynamics.push(`${pointer}/config/root`);
          return null;
        }
        extras[key] = yamlToJson(pair.value, `${pointer}/config/${key}`, dynamics) as BlueprintJson;
        continue;
      }
      if ((id === SETTINGS_ROW_ID || id === CREDENTIALS_ROW_ID) && key === "path") {
        const file = id === SETTINGS_ROW_ID ? "settings.yaml" : ".credentials.yaml";
        if (isOwnedPathScalar(pair.value, spaceId, file)) continue;
        if (isJsScalar(pair.value)) {
          dynamics.push(`${pointer}/config/path`);
          return null;
        }
        extras[key] = yamlToJson(pair.value, `${pointer}/config/${key}`, dynamics) as BlueprintJson;
        continue;
      }
      extras[key] = yamlToJson(pair.value, `${pointer}/config/${jsonPointerToken(key)}`, dynamics) as BlueprintJson;
    }
  }
  const extraKeys = node.items
    .map((pair) => (isScalar(pair.key) ? String(pair.key.value ?? "") : ""))
    .filter((key) => key && key !== "id" && key !== "config");
  if (extraKeys.length === 0 && Object.keys(extras).length === 0) {
    observations.push({ pointer, kind: "managed", reason: "Owned isolation fields were omitted." });
    return null;
  }
  const entry: BlueprintPatchEntry = { id };
  if (Object.keys(extras).length) entry.config = extras;
  return entry;
}

function yamlToJson(node: unknown, pointer: string, dynamics: string[]): BlueprintJson {
  if (node == null) return null;
  if (isScalar(node)) {
    if (jsTagged(node)) {
      dynamics.push(pointer);
      return typeof node.value === "string" ? node.value : String(node.value ?? "");
    }
    const value = node.value;
    if (value == null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value === 0 ? 0 : value;
    if (typeof value === "bigint") {
      dynamics.push(pointer);
      return String(value);
    }
    return String(value);
  }
  if (isSeq(node)) {
    return node.items.map((item, index) => yamlToJson(item, `${pointer}/${index}`, dynamics));
  }
  if (isMap(node)) {
    const object: BlueprintJsonObject = {};
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value ?? "") : "";
      if (!key) continue;
      if (key === "__jsExpr") {
        dynamics.push(pointer);
        continue;
      }
      object[key] = yamlToJson(pair.value, `${pointer}/${jsonPointerToken(key)}`, dynamics);
    }
    return object;
  }
  dynamics.push(pointer);
  return null;
}

function yamlBoolOrNull(node: { get(key: string, keep?: boolean): unknown; has(key: string): boolean }, key: string): boolean | null {
  const raw = node.get(key, true);
  if (raw == null) return null;
  if (isScalar(raw)) {
    if (raw.value == null) return null;
    return raw.value === true;
  }
  const value = node.get(key);
  if (value == null) return null;
  return value === true;
}

function jsTagged(node: Scalar): boolean {
  return node.tag === JS_TAG || node.tag === "!js" || String(node.tag ?? "").includes("yaml.org,2002:js");
}

function isJsScalar(node: unknown): node is Scalar {
  return isScalar(node) && jsTagged(node);
}

function isOwnedIsolationScalar(node: unknown, spaceId: string, kind: "sessions" | "storages"): boolean {
  if (!isJsScalar(node) || typeof node.value !== "string") return false;
  const actual = `!!js ${node.value}`;
  return isExpectedIsolationRoot(actual, spaceId, kind) || node.value.trim() === isolationExpr(spaceId, kind);
}

function isOwnedPathScalar(node: unknown, spaceId: string, file: "settings.yaml" | ".credentials.yaml"): boolean {
  if (!isJsScalar(node) || typeof node.value !== "string") return false;
  const actual = `!!js ${node.value}`;
  return isExpectedIsolationPath(actual, spaceId, file) || node.value.trim() === configPathExpr(spaceId, file);
}

function writeBoundSettings(home: string, spaceId: string, settings: BlueprintSettings): void {
  writeProfileSettings(home, spaceId, Object.fromEntries(
    Object.entries(settings).filter(([namespace]) => !FORBIDDEN_SETTINGS.has(namespace)),
  ));
}

function writeProvenance(home: string, spaceId: string, blueprint: Blueprint, values: BlueprintInputValues): void {
  const root = spaceDataRoot(home, spaceId);
  mkdirSync(root, { recursive: true });
  const origin: BlueprintOriginRecord = {
    schemaVersion: BLUEPRINT_ORIGIN_SCHEMA_VERSION,
    blueprint,
    bindings: blueprint.bindings.map((binding) => {
      if (binding.target.kind === "default-model") return { input: binding.input, kind: "default-model" as const };
      const entryId = patchEntryId(blueprint.profile.patch, binding.target.pointer);
      const entryName = patchEntryName(blueprint.profile.patch, binding.target.pointer);
      const namespace = settingsNamespaceOf(binding.target.pointer);
      return {
        input: binding.input,
        kind: "value" as const,
        pointer: binding.target.pointer,
        ...(entryId ? { entryId } : {}),
        ...(entryName ? { entryName } : {}),
        ...(namespace ? { namespace } : {}),
      };
    }),
    appliedAt: new Date().toISOString(),
  };
  try {
    atomicWrite(join(root, BLUEPRINT_ORIGIN_FILE), `${JSON.stringify(origin, null, 2)}\n`);
  } catch {
    throw publicError("Blueprint provenance could not be saved.");
  }
  const local: Record<string, BlueprintJson> = {};
  for (const [id, value] of Object.entries(values)) {
    if (typeof value === "object") continue;
    local[id] = value;
  }
  try {
    atomicWrite(join(root, BLUEPRINT_LOCAL_FILE), `${JSON.stringify({ schemaVersion: BLUEPRINT_ORIGIN_SCHEMA_VERSION, values: local }, null, 2)}\n`);
  } catch {
    /* local observations are best-effort and never block provenance */
  }
}

function readOrigin(home: string, spaceId: string): BlueprintOriginRecord | null {
  const path = join(spaceDataRoot(home, spaceId), BLUEPRINT_ORIGIN_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BlueprintOriginRecord;
    if (parsed.schemaVersion !== BLUEPRINT_ORIGIN_SCHEMA_VERSION) return null;
    parseBlueprint(parsed.blueprint);
    return parsed;
  } catch {
    return null;
  }
}

function provenanceMismatch(origin: BlueprintOriginRecord, home: string, spaceId: string): string | null {
  const patchPath = join(home, "profiles", spaceId, "cordis.patch.yml");
  const currentPatch = existsSync(patchPath)
    ? yamlPatchToBlueprint(readFileSync(patchPath, "utf8"), spaceId, [], [])
    : [];
  for (const binding of origin.bindings) {
    if (binding.kind !== "value" || !binding.pointer) continue;
    if (binding.entryId) {
      const currentId = patchEntryId(currentPatch, binding.pointer);
      if (currentId !== binding.entryId) return binding.pointer;
    }
    if (binding.namespace) {
      const settings = describeSettings(home, spaceId);
      if (!settings.some((row) => row.info.namespace === binding.namespace)) return binding.pointer;
    }
  }
  return null;
}

function composeBundles(
  home: string,
  spaceId: string,
  blueprintBundles: string[],
  options: { includeLlmBridge: boolean },
): void {
  const manifest = readProfileManifest(home, spaceId);
  const known = [...manifest.bundles, ...Object.keys(manifest.dependencies)];
  const hostLayers = manifest.bundles.filter((name) => HOST_PACKAGE_SET.has(name));
  const view = known.find((name) => name === "@dsh-spaces/view-bridge" || name === "dsh-spaces-view-bridge");
  const llm = known.find((name) => name === "@dsh-spaces/llm-bridge" || name === "dsh-spaces-llm-bridge");
  const final: string[] = [...hostLayers];
  if (view && !final.includes(view)) final.push(view);
  if (options.includeLlmBridge && llm && !final.includes(llm)) final.push(llm);
  for (const name of blueprintBundles) {
    if (!final.includes(name)) final.push(name);
  }
  writeProfileBundles(home, spaceId, final);
}

function writeProfileBundles(home: string, spaceId: string, bundles: string[]): void {
  const path = join(home, "profiles", spaceId, "package.json");
  assertRegularFile(path);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const dsh = isPlainObject(raw.dsh) ? { ...raw.dsh } : {};
  const profile = isPlainObject(dsh.profile) ? { ...dsh.profile } : {};
  profile.bundles = bundles;
  dsh.profile = profile;
  raw.dsh = dsh;
  atomicWrite(path, `${JSON.stringify(raw, null, 2)}\n`);
}

function assertBundlePatches(home: string, spaceId: string, blueprint: Blueprint): void {
  const allowed = allowedModuleNames(home, spaceId, blueprint);
  for (const name of blueprint.profile.bundles) {
    const installed = readInstalledManifest(home, spaceId, name);
    if (!installed?.hasBundle) {
      throw publicError(`Package ${name} has no bundle patch and cannot be composed.`);
    }
  }
  walkPatchEntries(blueprint.profile.patch, (entry, pointer) => {
    if (!entry.name) return;
    if (!moduleRefAllowed(entry.name, allowed)) {
      throw publicError(`Patch module ${entry.name} does not resolve to a selected or host package.`, `${pointer}/name`);
    }
  });
}

function allowedModuleNames(home: string, spaceId: string, blueprint: Blueprint): Set<string> {
  const names = new Set<string>([
    ...HOST_PACKAGE_SET,
    ...CONTROL_PACKAGE_SET,
    ...blueprint.packages.map((pkg) => pkg.name),
  ]);
  const manifest = readProfileManifest(home, spaceId);
  for (const name of [...Object.keys(manifest.dependencies), ...manifest.bundles]) {
    if (isOwnedBridgeName(name)) names.add(name);
  }
  for (const pkg of blueprint.packages) {
    const installed = readInstalledManifest(home, spaceId, pkg.name);
    for (const dep of installed?.dependencies ?? []) names.add(dep);
  }
  return names;
}

function moduleRefAllowed(name: string, allowed: Set<string>): boolean {
  if (looksLikeModulePath(name)) return false;
  if (allowed.has(name)) return true;
  const pkg = packageNameOfModule(name);
  return Boolean(pkg && allowed.has(pkg));
}

function packageNameOfModule(name: string): string | null {
  if (name.startsWith("@")) {
    const parts = name.split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return name.split("/")[0] ?? null;
}

function looksLikeModulePath(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.startsWith("/") ||
    name.startsWith("file:") ||
    /^[A-Za-z]:[\\/]/.test(name) ||
    name.includes("\\")
  );
}

function blockingApplyDiagnostics(
  blueprint: Blueprint,
): { diagnostics: BlueprintDiagnostic[]; errors: string[] } {
  const diagnostics: BlueprintDiagnostic[] = [];
  const errors: string[] = [];
  const push = (message: string, path?: string) => {
    diagnostics.push({ code: "blueprint.unsupported", message, severity: "error", path });
    errors.push(message);
  };
  if (blueprint.packages.some((pkg) => pkg.source.type === "github")) {
    push(GITHUB_APPLY_MESSAGE);
  }
  for (const namespace of Object.keys(blueprint.profile.settings)) {
    if (FORBIDDEN_SETTINGS.has(namespace)) {
      push("Managed model settings cannot be applied from a blueprint.", `/profile/settings/${namespace}`);
    }
  }
  walkPatchEntries(blueprint.profile.patch, (entry, pointer) => {
    if (MANAGED_ENTRY_SET.has(entry.id)) {
      push("Managed isolation fields cannot be supplied by a blueprint.", `${pointer}/id`);
    }
    if (entry.name && looksLikeModulePath(entry.name)) {
      push("Patch module references must be package names.", `${pointer}/name`);
    }
    if (hasJsExpr(entry as unknown as BlueprintJson, pointer, [])) {
      push("Dynamic expressions cannot be applied.", pointer);
    }
  });
  if (hasJsExpr(blueprint.profile.settings, "/profile/settings", [])) {
    push("Dynamic expressions cannot be applied.", "/profile/settings");
  }
  return { diagnostics, errors };
}

function previewInputs(blueprint: Blueprint, values: BlueprintInputValues): BlueprintPreviewInput[] {
  return blueprint.inputs.map((input) => {
    if (Object.prototype.hasOwnProperty.call(values, input.id)) {
      return { id: input.id, type: input.type, origin: "explicit" as const, value: values[input.id] };
    }
    if (input.default !== undefined) {
      return { id: input.id, type: input.type, origin: "default" as const, value: input.default };
    }
    return { id: input.id, type: input.type, origin: "missing" as const };
  });
}

function isRequiredInput(blueprint: Blueprint, id: string): boolean {
  return blueprint.inputs.some((input) => input.id === id && input.required);
}

function directoryInputError(home: string, blueprint: Blueprint, values: BlueprintInputValues): string | undefined {
  for (const input of blueprint.inputs) {
    if (input.type !== "directory") continue;
    const value = values[input.id];
    if (typeof value !== "string") continue;
    const error = directoryProtectionError(home, value);
    if (error) return error;
  }
  return undefined;
}

function directoryProtectionError(home: string, value: string): string | undefined {
  if (!value || value.includes("\0")) return "A directory input is invalid.";
  if (!isAbsolute(value)) return "A directory input must be an absolute path.";
  return walkProtectedAncestors(resolve(home), resolve(realDshHome()), value);
}

function walkProtectedAncestors(homeRoot: string, realHome: string, value: string): string | undefined {
  const segments: string[] = [];
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    segments.push(value.slice(0, 2) + sep);
    segments.push(...value.slice(3).split(/[/\\]/).filter(Boolean));
  } else if (value.startsWith("\\\\") || value.startsWith("//")) {
    return "A directory input cannot use a network path.";
  } else if (value.startsWith("/") || value.startsWith("\\")) {
    segments.push(sep);
    segments.push(...value.slice(1).split(/[/\\]/).filter(Boolean));
  } else {
    return "A directory input must be an absolute path.";
  }
  let resolved = segments[0]!;
  for (let index = 1; index < segments.length; index++) {
    const next = join(resolved, segments[index]!);
    let st;
    try {
      st = lstatSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const rest = join(resolved, ...segments.slice(index));
        if (isProtectedLocation(homeRoot, realHome, rest) || isProtectedLocation(homeRoot, realHome, resolved)) {
          return "A directory input points at a protected Home path.";
        }
        return undefined;
      }
      return "A directory input could not be read.";
    }
    try {
      const target = st.isSymbolicLink() ? realpathSync(next) : next;
      if (isProtectedLocation(homeRoot, realHome, target)) {
        return "A directory input points at a protected Home path.";
      }
      resolved = target;
    } catch {
      return "A directory input could not be read.";
    }
  }
  try {
    const st = lstatSync(resolved);
    if (st.isSymbolicLink()) {
      const target = realpathSync(resolved);
      if (isProtectedLocation(homeRoot, realHome, target)) return "A directory input points at a protected Home path.";
    } else if (!st.isDirectory()) {
      return "A directory input must be a directory.";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return "A directory input could not be read.";
  }
  if (isProtectedLocation(homeRoot, realHome, resolved)) return "A directory input points at a protected Home path.";
  return undefined;
}

function isProtectedLocation(homeRoot: string, realHome: string, target: string): boolean {
  const resolved = resolve(target);
  if (sameResolved(resolved, homeRoot) || containedIn(homeRoot, resolved)) return true;
  if (sameResolved(resolved, realHome) || containedIn(realHome, resolved)) return true;
  return false;
}

function assertPatchSafeToApply(patch: BlueprintPatch, _spaceId: string): void {
  if (hasJsExpr(patch, "/profile/patch", [])) {
    throw publicError("Dynamic expressions cannot be applied.");
  }
  walkPatchEntries(patch, (entry, pointer) => {
    if (MANAGED_ENTRY_SET.has(entry.id)) {
      throw publicError("Managed isolation fields cannot be supplied by a blueprint.", `${pointer}/id`);
    }
    if (entry.name && isOwnedBridgeName(entry.name)) {
      throw publicError("Owned control components cannot be supplied by a blueprint.", `${pointer}/name`);
    }
  });
}

function defeatsIsolation(text: string, spaceId: string): boolean {
  if (/(?:hub|profiles)\/web\b/i.test(text) && spaceId !== "web") return true;
  if (/dshHomePath\s*\(\s*['"][^'"]*\.\./i.test(text)) return true;
  return false;
}

function maybeModelInput(
  home: string,
  spaceId: string,
  origin: BlueprintOriginRecord | null,
): { input: BlueprintInput; binding: BlueprintBinding } | null {
  if (origin?.blueprint.bindings.some((binding) => binding.target.kind === "default-model")) {
    const binding = origin.blueprint.bindings.find((item) => item.target.kind === "default-model")!;
    const input = origin.blueprint.inputs.find((item) => item.id === binding.input);
    if (input) return { input, binding };
  }
  const path = spaceSettingsPath(home, spaceId);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (!text.includes("agent-default-model") && !text.includes("llm-pi-ai")) return null;
  return {
    input: { id: "default-model", type: "model", label: "Model", required: false },
    binding: { input: "default-model", target: { kind: "default-model" } },
  };
}

function findUndeclaredLocals(patch: BlueprintPatch, settings: BlueprintSettings, bindings: BlueprintBinding[]): string | null {
  const bound = new Set(
    bindings.flatMap((item) => (item.target.kind === "value" ? [item.target.pointer] : [])),
  );
  const found = [
    ...findLocalPointers(patch as unknown as BlueprintJson, "/profile/patch"),
    ...findLocalPointers(settings, "/profile/settings"),
  ];
  const leftover = found.find((item) => !bound.has(item.pointer));
  return leftover?.pointer ?? null;
}

function findLocalPointers(value: BlueprintJson, pointer: string): BlueprintLocalObservation[] {
  const found: BlueprintLocalObservation[] = [];
  visitJson(value, pointer, (item, path) => {
    if (typeof item === "string" && looksLikeLocalPath(item)) {
      found.push({ pointer: path, kind: "directory", reason: "Local paths must be declared as inputs." });
    }
  });
  return found;
}

function looksLikeLocalPath(value: string): boolean {
  if (value.startsWith("file:")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("/") && !value.startsWith("//") && value.length > 1) return true;
  if (value.includes("\\") && /[A-Za-z]:\\/.test(value)) return true;
  return false;
}

function jsonLooksCredential(value: BlueprintJson, pointer: string, observations: BlueprintLocalObservation[]): boolean {
  let found = false;
  visitJson(value, pointer, (item, path, key) => {
    if (key && CREDENTIAL_KEY_RE.test(key)) {
      observations.push({ pointer: path, kind: "unknown", reason: "Credential-like keys cannot be shared." });
      found = true;
    }
    if (typeof item === "string" && /sk-[A-Za-z0-9]{10,}/.test(item)) {
      observations.push({ pointer: path, kind: "unknown", reason: "Credential-like values cannot be shared." });
      found = true;
    }
  });
  return found;
}

function visitJson(
  value: BlueprintJson,
  pointer: string,
  visit: (value: BlueprintJson, pointer: string, key?: string) => void,
): void {
  visit(value, pointer);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitJson(item, `${pointer}/${index}`, visit));
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      visitJson(value[key] as BlueprintJson, `${pointer}/${jsonPointerToken(key)}`, visit);
      visit(value[key] as BlueprintJson, `${pointer}/${jsonPointerToken(key)}`, key);
    }
  }
}

function hasJsExpr(value: unknown, pointer: string, dynamics: string[]): boolean {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "__jsExpr")) {
    dynamics.push(pointer);
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item, index) => hasJsExpr(item, `${pointer}/${index}`, dynamics));
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).some((key) =>
      hasJsExpr((value as Record<string, unknown>)[key], `${pointer}/${jsonPointerToken(key)}`, dynamics),
    );
  }
  return false;
}

function walkPatchEntries(patch: BlueprintPatch, visit: (entry: BlueprintPatchEntry, pointer: string) => void): void {
  walkAllPatchEntries(patch, visit);
}

function walkAllPatchEntries(patch: BlueprintPatch, visit: (entry: BlueprintPatchEntry, pointer: string) => void): void {
  const visitEntry = (entry: BlueprintPatchEntry, pointer: string) => {
    visit(entry, pointer);
    if (entry.group === true && Array.isArray(entry.config)) {
      entry.config.forEach((child, index) => {
        if (child && typeof child === "object" && !Array.isArray(child) && "id" in child && !("insert" in child)) {
          visitEntry(child as unknown as BlueprintPatchEntry, `${pointer}/config/${index}`);
        }
      });
    }
  };
  patch.forEach((item, index) => {
    const pointer = `/profile/patch/${index}`;
    if ("insert" in item && Array.isArray(item.insert)) {
      item.insert.forEach((entry, insertIndex) => visitEntry(entry, `${pointer}/insert/${insertIndex}`));
      return;
    }
    visitEntry(item as BlueprintPatchEntry, pointer);
  });
}

function patchEntryId(patch: BlueprintPatch, pointer: string): string | undefined {
  return patchEntryAt(patch, pointer)?.id;
}

function patchEntryName(patch: BlueprintPatch, pointer: string): string | undefined {
  return patchEntryAt(patch, pointer)?.name;
}

function patchEntryAt(patch: BlueprintPatch, pointer: string): BlueprintPatchEntry | undefined {
  const match = /^\/profile\/patch\/(\d+)(?:\/insert\/(\d+))?/.exec(pointer);
  if (!match) return undefined;
  const item = patch[Number(match[1])];
  if (!item) return undefined;
  if (match[2] && "insert" in item) return item.insert[Number(match[2])];
  if ("id" in item && !("insert" in item)) return item;
  return undefined;
}

function settingsNamespaceOf(pointer: string): string | undefined {
  const match = /^\/profile\/settings\/([^/]+)/.exec(pointer);
  return match ? decodePointerToken(match[1]!) : undefined;
}

function pointerExists(root: unknown, pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  const tokens = pointer.slice(1).split("/").map((token) => decodePointerToken(token));
  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || String(index) !== token || index < 0 || index >= current.length) return false;
      current = current[index];
    } else if (current && typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return false;
      current = (current as BlueprintJsonObject)[token];
    } else {
      return false;
    }
  }
  return true;
}

function parentJsonPointer(pointer: string): string | undefined {
  const index = pointer.lastIndexOf("/");
  if (index <= 0) return undefined;
  return pointer.slice(0, index);
}

function lastJsonPointerToken(pointer: string): string | undefined {
  const index = pointer.lastIndexOf("/");
  if (index < 0 || index === pointer.length - 1) return undefined;
  return decodePointerToken(pointer.slice(index + 1));
}

function configBindingSuffix(pointer: string): string | undefined {
  const index = pointer.indexOf("/config/");
  if (index >= 0) return pointer.slice(index);
  if (pointer.endsWith("/config")) return "/config";
  return undefined;
}

function readPointer(root: BlueprintJson, pointer: string): BlueprintJson {
  const tokens = pointer.slice(1).split("/").map((token) => decodePointerToken(token));
  let current: BlueprintJson = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      current = current[index] as BlueprintJson;
    } else if (current && typeof current === "object") {
      current = (current as BlueprintJsonObject)[token] as BlueprintJson;
    } else {
      throw new Error("missing");
    }
  }
  return current;
}

function setPointer(root: BlueprintJsonObject, pointer: string, value: BlueprintJson): void {
  const tokens = pointer.slice(1).split("/").map((token) => decodePointerToken(token));
  let current: BlueprintJson = root;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(current)) current = current[Number(token)] as BlueprintJson;
    else current = (current as BlueprintJsonObject)[token] as BlueprintJson;
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(current)) current[Number(last)] = value;
  else (current as BlueprintJsonObject)[last] = value;
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function jsonPointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

type ProfileManifest = { dependencies: Record<string, string>; bundles: string[] };

function readProfileManifest(home: string, spaceId: string): ProfileManifest {
  const path = join(home, "profiles", spaceId, "package.json");
  if (!existsSync(path)) throw publicError("That space was not found.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: unknown } };
  };
  const dependencies = parsed.dependencies && isPlainObject(parsed.dependencies) ? parsed.dependencies as Record<string, string> : {};
  const bundles = Array.isArray(parsed.dsh?.profile?.bundles)
    ? parsed.dsh.profile.bundles.filter((item): item is string => typeof item === "string")
    : [];
  return { dependencies, bundles };
}

type InstalledManifest = { name: string; version: string; hasBundle: boolean; lifecycleScripts: string[]; dependencies: string[] };

function readInstalledManifest(home: string, spaceId: string, name: string): InstalledManifest | null {
  const path = installedManifestPath(home, spaceId, name);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      name?: unknown;
      version?: unknown;
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      dsh?: { bundle?: { patch?: unknown } };
    };
    const pkgName = typeof parsed.name === "string" ? parsed.name : name;
    const version = typeof parsed.version === "string" ? parsed.version : "";
    const hasBundle = Boolean(parsed.dsh && parsed.dsh.bundle && typeof parsed.dsh.bundle.patch === "string");
    const lifecycleScripts = LIFECYCLE_SCRIPTS.filter((script) => parsed.scripts && Object.prototype.hasOwnProperty.call(parsed.scripts, script));
    const dependencies = parsed.dependencies && isPlainObject(parsed.dependencies) ? Object.keys(parsed.dependencies) : [];
    return { name: pkgName, version, hasBundle, lifecycleScripts, dependencies };
  } catch {
    return null;
  }
}

function readInstalledIdentity(home: string, spaceId: string, name: string): { name: string; version: string } | null {
  const installed = readInstalledManifest(home, spaceId, name);
  if (!installed || !isExactRuntimeVersion(installed.version)) return null;
  return { name: installed.name, version: installed.version };
}

function readInstalledVersion(home: string, spaceId: string, name: string): string | null {
  const version = readInstalledManifest(home, spaceId, name)?.version;
  return version && isExactRuntimeVersion(version) ? version : null;
}

function installedManifestPath(home: string, spaceId: string, name: string): string {
  return join(home, "profiles", spaceId, "node_modules", ...name.split("/"), "package.json");
}

function tarballIntegrity(home: string, rel: string): string | undefined {
  const abs = isAbsolute(rel) ? rel : join(home, rel);
  if (!isHubPluginArchive(home, abs)) return undefined;
  try {
    const bytes = readFileSync(abs);
    return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  } catch {
    return undefined;
  }
}

function sourceFingerprint(home: string, spaceId: string): string {
  return sha256Hex(
    [
      fileDigest(join(home, "profiles", spaceId, "package.json")),
      fileDigest(join(home, "profiles", spaceId, "cordis.patch.yml")),
      fileDigest(spaceSettingsPath(home, spaceId)),
      fileDigest(join(spaceDataRoot(home, spaceId), BLUEPRINT_ORIGIN_FILE)),
    ].join("|"),
  );
}

function fileDigest(path: string): string {
  if (!existsSync(path)) return sha256Hex("");
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return sha256Hex("unreadable");
  }
}

function environmentFromHost(host: BlueprintHostVersions, packages?: BlueprintPackageEvidence[]) {
  const os = (BLUEPRINT_OS as readonly string[]).includes(host.os) ? (host.os as BlueprintOs) : undefined;
  const arch = (BLUEPRINT_ARCH as readonly string[]).includes(host.arch) ? (host.arch as BlueprintArch) : undefined;
  return {
    dsh: host.dsh ?? undefined,
    spaces: host.spaces ?? undefined,
    node: host.node,
    os,
    arch,
    packages,
  };
}

function evidenceFromBlueprint(blueprint: Blueprint): BlueprintPackageEvidence[] {
  return blueprint.packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    selected: true,
    bundled: blueprint.profile.bundles.includes(pkg.name),
  }));
}

function metadataOf(metadata: { name: string; version: string; description?: string }) {
  return metadata.description
    ? { name: metadata.name, version: metadata.version, description: metadata.description }
    : { name: metadata.name, version: metadata.version };
}

function blueprintFileName(name: string, version: string): string {
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const base = slug && /^[A-Za-z0-9]/.test(slug) ? slug : "blueprint";
  return `${base}-${version}.dsh-blueprint.json`;
}

function emptyOutcome(host: BlueprintHostVersions, packages: BlueprintPackageResult[] = []): WorkbenchBlueprintApplyOutcome {
  return {
    kind: "blueprint.apply",
    stages: {
      "space-create": { status: "not-run" },
      packages: { status: "not-run" },
      presets: { status: "not-run" },
      start: { status: "not-run" },
    },
    installed: [],
    packageResults: packages,
    writes: [
      { kind: "patch", status: "not-run" },
      { kind: "settings", status: "not-run" },
      { kind: "model", status: "not-run" },
      { kind: "provenance", status: "not-run" },
    ],
    host: hostOutcome(host),
  };
}

function markRemainingPackages(outcome: WorkbenchBlueprintApplyOutcome, status: BlueprintPackageResult["status"]): void {
  outcome.packageResults = outcome.packageResults.map((row) => (row.status === "not-run" ? { ...row, status } : row));
}

function markWrites(outcome: WorkbenchBlueprintApplyOutcome, status: BlueprintWriteResult["status"]): void {
  outcome.writes = outcome.writes.map((row) => (row.status === "not-run" ? { ...row, status } : row));
}

function sanitizeOutcome(outcome: WorkbenchBlueprintApplyOutcome): WorkbenchBlueprintApplyOutcome {
  const next = cloneOutcome(outcome);
  for (const stage of Object.values(next.stages)) {
    if ("error" in stage && stage.error) stage.error = durableText(stage.error);
  }
  for (const row of next.packageResults) {
    if (row.error) row.error = durableText(row.error);
  }
  for (const row of next.writes) {
    if (row.error) row.error = durableText(row.error);
  }
  if (next.source && !safeBlueprintLabel(next.source.name)) delete next.source;
  return next;
}

function durableText(message: string): string {
  const cleaned = sanitizePublicMessage(message);
  if (looksLikeLocalPath(cleaned) || /[A-Za-z]:[\\/]|\\\\|\/\/|\/(?:home|Users|root|opt|var|tmp)\//.test(cleaned)) {
    return "The blueprint operation failed.";
  }
  return cleaned;
}

function durableFailureReason(error: unknown, stage: "space-create" | "packages" | "presets"): string {
  if (isAbortError(error)) return "The blueprint apply was cancelled.";
  if (error instanceof BlueprintPackageError && error.code === "github-unsupported") return GITHUB_APPLY_MESSAGE;
  if (isPublicError(error) && isSafeKnownReason(error.message)) return error.message;
  if (stage === "packages") return "Package installation failed.";
  if (stage === "presets") return "Blueprint presets could not be written.";
  return "The space could not be created.";
}

function isSafeKnownReason(message: string): boolean {
  if (!message) return false;
  if (looksLikeLocalPath(message)) return false;
  if (/canary|sk-[A-Za-z0-9]{10,}/i.test(message)) return false;
  if (/[A-Za-z]:[\\/]|\\\\|\/\/|\/(?:home|Users|root|opt|var|tmp)\//.test(message)) return false;
  return message.length <= 500;
}

function safeBlueprintLabel(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed || looksLikeLocalPath(trimmed) || /[\\/]/.test(trimmed)) return undefined;
  return trimmed.slice(0, 80);
}

function secretFindingsOfBlueprint(blueprint: Blueprint): string | undefined {
  return secretFindingsOfConfig(blueprint.profile.patch, blueprint.profile.settings);
}

function secretFindingsOfConfig(patch: BlueprintPatch, settings: BlueprintSettings): string | undefined {
  const payload = JSON.stringify({ patch, settings });
  const findings = scanShareEntries([{ name: "blueprint.json", data: payload }]).filter(
    (finding) => finding.reason !== "absolute path",
  );
  if (findings.length) return findings[0]?.path;
  if (jsonLooksCredential(settings, "/profile/settings", []) || jsonLooksCredential(patch as unknown as BlueprintJson, "/profile/patch", [])) {
    return "/profile";
  }
  return undefined;
}

function compositionFailureReason(error: unknown, fallback = "Blueprint composition could not be verified."): string {
  if (error instanceof Error && isSafeKnownReason(error.message) && !/EPERM|ENOENT|EACCES|EISDIR/i.test(error.message)) {
    return error.message;
  }
  return fallback;
}

function officialSkippedBlueprintOverlay(warnings: string[], patch: BlueprintPatch): string | undefined {
  const overlays = new Set<string>();
  const groupInserts = new Set<string>();
  for (const item of patch) {
    if ("insert" in item && Array.isArray(item.insert)) {
      if (item.id) groupInserts.add(item.id);
      continue;
    }
    if ("id" in item && item.id) overlays.add(item.id);
  }
  for (const warning of warnings) {
    const notFound = /^patch: entry "(.+)" not found$/.exec(warning);
    if (notFound && overlays.has(notFound[1]!)) {
      return `Blueprint overlay "${notFound[1]}" was not applied.`;
    }
    const nameMismatch =
      /^patch: name mismatch for "(.+)" \(expected .+, got .+\), skipping$/.exec(warning) ??
      /^patch: entry "(.+)" name mismatch/.exec(warning);
    if (nameMismatch && overlays.has(nameMismatch[1]!)) {
      return `Blueprint overlay "${nameMismatch[1]}" was skipped because the entry name does not match.`;
    }
    const notGroup = /^patch insert: entry "(.+)" is not a group$/.exec(warning);
    if (notGroup && groupInserts.has(notGroup[1]!)) {
      return `Blueprint insert target "${notGroup[1]}" is not a group.`;
    }
    const insertMissing = /^patch insert: entry "(.+)" not found$/.exec(warning);
    if (insertMissing && groupInserts.has(insertMissing[1]!)) {
      return `Blueprint overlay "${insertMissing[1]}" was not applied.`;
    }
  }
  return undefined;
}

function selectedBundleIdentityError(blueprint: Blueprint, layers: BlueprintRuntimeLayerIdentity[]): string | undefined {
  const byName = new Map(
    layers
      .filter((layer) => layer && typeof layer.name === "string" && typeof layer.version === "string")
      .map((layer) => [layer.name, layer.version]),
  );
  for (const name of blueprint.profile.bundles) {
    const selected = blueprint.packages.find((pkg) => pkg.name === name);
    const version = byName.get(name);
    if (!version) return `Package ${name} did not resolve as a composed layer.`;
    if (selected && version !== selected.version) {
      return `Package ${name} resolved to a different version than the selected pin.`;
    }
  }
  return undefined;
}

function patchModuleSpecifiers(patch: BlueprintPatch): string[] {
  const names: string[] = [];
  walkAllPatchEntries(patch, (entry) => {
    if (entry.name) names.push(entry.name);
  });
  return unique(names);
}

type ModuleIdentityEvidence = { name: string; version: string | null };

function moduleResolutionEvidence(
  home: string,
  spaceId: string,
  blueprint: Blueprint,
  composed: BlueprintRuntimeCompose | undefined,
  inspected: BlueprintRuntimeInspect | null,
): ModuleIdentityEvidence[] {
  const evidence: ModuleIdentityEvidence[] = [];
  const seen = new Set<string>();
  const add = (name: string, version: string | null) => {
    const key = `${name}@${version ?? "*"}`;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({ name, version });
  };
  for (const pkg of blueprint.packages) {
    const installed = readInstalledManifest(home, spaceId, pkg.name);
    for (const dep of installed?.dependencies ?? []) {
      const identity = readInstalledIdentity(home, spaceId, dep);
      if (identity) add(dep, identity.version);
    }
  }
  if (composed) {
    for (const layer of composed.layers) {
      if (layer.name && layer.version) add(layer.name, layer.version);
    }
  }
  if (inspected) {
    for (const layer of inspected.baseLayers) {
      if (layer.name && layer.version) add(layer.name, layer.version);
    }
    addUnknownEntryNames(inspected.baseEntries, add);
  }
  return evidence;
}

function addUnknownEntryNames(entries: unknown[], add: (name: string, version: string | null) => void): void {
  walkUnknownPatchItems(entries, (item) => {
    if (typeof item.name === "string" && item.name) add(item.name, null);
  });
}

function resolvedIdentityAllowed(resolved: BlueprintRuntimeModule, evidence: ModuleIdentityEvidence[]): boolean {
  if (!resolved.packageName || resolved.packageVersion == null) return false;
  return evidence.some((row) => {
    if (row.name !== resolved.packageName) return false;
    if (row.version == null) return true;
    return row.version === resolved.packageVersion;
  });
}

function homePatchesOverrideManaged(entries: unknown[]): boolean {
  let found = false;
  walkUnknownPatchItems(entries, (item) => {
    if (typeof item.id === "string" && MANAGED_ENTRY_SET.has(item.id)) found = true;
    if (typeof item.name === "string" && (CONTROL_PACKAGE_SET.has(item.name) || isOwnedBridgeName(item.name))) {
      found = true;
    }
  });
  return found;
}

function walkUnknownPatchItems(entries: unknown, visit: (item: Record<string, unknown>) => void): void {
  if (!Array.isArray(entries)) return;
  for (const item of entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    visit(rec);
    if (Array.isArray(rec.insert)) walkUnknownPatchItems(rec.insert, visit);
    if (rec.group === true && Array.isArray(rec.config)) walkUnknownPatchItems(rec.config, visit);
  }
}

function composedManagedIsolationError(entries: unknown[], spaceId: string): string | undefined {
  let foreign = false;
  walkUnknownPatchItems(entries, (item) => {
    if (typeof item.id !== "string" || !MANAGED_ENTRY_SET.has(item.id)) return;
    const config = item.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) return;
    const rec = config as Record<string, unknown>;
    if (pointsAtForeignSpaceHub(isolationConfigText(rec.path ?? rec.root), spaceId)) foreign = true;
  });
  return foreign ? "Home configuration overrides managed isolation or control entries." : undefined;
}

function isolationConfigText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (typeof rec.__jsExpr === "string") return rec.__jsExpr;
  }
  return "";
}

function pointsAtForeignSpaceHub(text: string, spaceId: string): boolean {
  if (!text) return false;
  const match = /(?:^|[ '"\\/])hub[\\/]([^\\/'"]+)[\\/]/.exec(text);
  if (!match) return false;
  return match[1] !== spaceId;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: string }).name === "AbortError");
}

function hostOutcome(host: BlueprintHostVersions): WorkbenchBlueprintApplyOutcome["host"] {
  return { dsh: host.dsh, spaces: host.spaces, base: host.base, webApp: host.webApp };
}

function failStage(error: string): BlueprintApplyStage {
  return { status: "failed", error };
}

function cloneOutcome(value: WorkbenchBlueprintApplyOutcome): WorkbenchBlueprintApplyOutcome {
  return JSON.parse(JSON.stringify(value)) as WorkbenchBlueprintApplyOutcome;
}

function resultOf(outcome: WorkbenchBlueprintApplyOutcome): WorkbenchJobResult {
  return outcome.spaceId ? { spaceId: outcome.spaceId, product: outcome } : { product: outcome };
}

function afterFailure(outcome: WorkbenchBlueprintApplyOutcome, message: string): Error {
  const error = publicError(message);
  (error as Error & { outcome: WorkbenchBlueprintApplyOutcome }).outcome = outcome;
  return error;
}

function observationsMatch(left: PlanObservation, right: PlanObservation): boolean {
  return (
    left.serviceEpoch === right.serviceEpoch &&
    left.stateRevision === right.stateRevision &&
    left.dshVersion === right.dshVersion &&
    left.hostBaseVersion === right.hostBaseVersion &&
    left.hostWebAppVersion === right.hostWebAppVersion &&
    left.homeSettingsDigest === right.homeSettingsDigest &&
    left.homePatchDigest === right.homePatchDigest &&
    left.runtimeFingerprint === right.runtimeFingerprint &&
    left.llmCatalogRevision === right.llmCatalogRevision &&
    left.llmCatalogDigest === right.llmCatalogDigest
  );
}

function asDescribe(result: LlmApiResult): LlmDescribeResult {
  if (!result || typeof result !== "object" || !("connections" in result) || !("revision" in result)) {
    throw publicError("The model catalog could not be read.");
  }
  return result as LlmDescribeResult;
}

function asSpacePolicy(result: LlmApiResult): LlmSpacePolicyResult {
  if (!result || typeof result !== "object" || !("policy" in result)) {
    throw publicError("The space model policy could not be read.");
  }
  const policy = (result as LlmSpacePolicyResult).policy;
  if (!policy || typeof policy.revision !== "number" || !Number.isInteger(policy.revision) || policy.revision < 0) {
    throw publicError("The space model policy could not be read.");
  }
  return result as LlmSpacePolicyResult;
}

function isPublicError(error: unknown): error is Error {
  return error instanceof Error && error.name === "Error" && isSafeKnownReason(error.message);
}

function isInspectRuntimeFailure(error: unknown): boolean {
  return error instanceof Error && error.message === INSPECT_RUNTIME_FAILED;
}

function modelWriteFailureReason(error: unknown): string {
  if (error instanceof LlmConfigError) {
    if (error.code === LLM_ERROR.REVISION_CONFLICT) return "The model policy could not be updated.";
    if (error.code === LLM_ERROR.MODEL_NOT_FOUND) return "The selected model is not available on that connection.";
  }
  if (error instanceof Error && isSafeKnownReason(error.message)) return error.message;
  return "The model binding could not be written.";
}

function assertMutableName(spaceId: string, managerId: string | null): void {
  if (!PROFILE_NAME_RE.test(spaceId)) throw publicError("That space name is not allowed.");
  if (spaceId === "web" || (RESERVED_PROFILE_NAMES as readonly string[]).includes(spaceId)) {
    throw publicError(`The ${spaceId} space cannot be changed this way.`);
  }
  if (managerId && spaceId === managerId) throw publicError(`The ${spaceId} space cannot be changed this way.`);
}

function isOwnedBridgeName(name: string): boolean {
  if (CONTROL_PACKAGE_SET.has(name)) return true;
  return name === "dsh-spaces-view-bridge" || name === "dsh-spaces-llm-bridge" || name === "dsh-spaces-plugin";
}

function exactOrNull(value: string | null): string | null {
  return value && isExactRuntimeVersion(value) ? value : null;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function containedIn(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function sameResolved(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function assertRegularFile(path: string): void {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink()) throw publicError("The space manifest is not a regular file.");
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("The blueprint apply was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function publicError(message: string, _path?: string): Error {
  return new Error(sanitizePublicMessage(message));
}

function sanitizeBlueprintError(error: unknown): string {
  if (error instanceof BlueprintError) return sanitizePublicMessage(error.message);
  if (error instanceof BlueprintPackageError) {
    if (error.code === "github-unsupported") return GITHUB_APPLY_MESSAGE;
    return sanitizePublicMessage(error.message);
  }
  if (error instanceof Error) return sanitizePublicMessage(error.message);
  return "The blueprint request failed.";
}

function sanitizePublicMessage(message: string): string {
  const redacted = sanitizeLogText(message)
    .replace(/[A-Za-z]:\\[^\s"'\\]+(?:\\[^\s"'\\]+)*/g, "[path]")
    .replace(/\/(?:home|Users|root|opt|var|tmp)\/[^\s"']+/g, "[path]");
  return redacted.length > 500 ? `${redacted.slice(0, 499)}…` : redacted;
}
