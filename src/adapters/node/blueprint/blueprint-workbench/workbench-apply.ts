import { bindDocumentInputs } from "@klarkxy/dsh-blueprint/document";
import type { BlueprintPackage } from "../../../../shared/blueprint";
import { spaceIdFromName } from "../../../../shared/types";
import type { WorkbenchJobResult } from "../../../../shared/workbench";
import type { BlueprintApplyStage, BlueprintHostVersions, BlueprintInstalledIdentity, BlueprintPackageResult, BlueprintWriteKind, BlueprintWriteResult, WorkbenchBlueprintApplyOutcome } from "../../../../shared/workbench-blueprint";
import { prepareBlueprintPackage, BlueprintPackageError, type PreparedBlueprintPackage } from "../blueprint-package";
import type { WorkbenchJobContext } from "../../maintenance/workbench-jobs";
import type { StagedPlan } from "./types";
import { GITHUB_APPLY_MESSAGE, INSPECT_RUNTIME_FAILED } from "./constants";
import { throwIfAborted } from "./utils";
import { publicError, isInspectRuntimeFailure, durableFailureReason, durableText, safeBlueprintLabel, isAbortError } from "./errors";
import { blockingApplyDiagnostics, secretFindingsOfBlueprint, secretFindingsOfConfig } from "./diagnostics";
import { readInstalledIdentity } from "./source-inspection";
import { writeBoundSettings, writeProvenance, composeBundles, directoryInputError } from "./isolation-config";
import { observationsMatch, BlueprintWorkbenchPreviewOps } from "./workbench-preview";

export class BlueprintWorkbench extends BlueprintWorkbenchPreviewOps {

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
      const live = await this.captureObservation(this.plans.get(planId)?.blueprint);
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

    let bound: ReturnType<typeof bindDocumentInputs>;
    try {
      bound = bindDocumentInputs(staged.blueprint.document, staged.values);
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
    try {
      const builtinError = await this.builtinIdentityError(staged.blueprint);
      if (builtinError) failCreate(builtinError);
      if (!observationsMatch(staged.observation, await this.captureObservation(staged.blueprint))) {
        failCreate("The target changed. Request a new preview.");
      }
    } catch (error) {
      if ((error as { outcome?: WorkbenchBlueprintApplyOutcome }).outcome) throw error;
      failCreate(isInspectRuntimeFailure(error) ? INSPECT_RUNTIME_FAILED : durableFailureReason(error, "space-create"));
    }

    ctx.phase("space-create");
    const spaceId = spaceIdFromName(staged.name);
    try {
      throwIfAborted(ctx.signal);
      await this.ports.createSpace(
        { name: staged.name, displayName: staged.displayName || sourceName || "blueprint" },
        ctx,
      );
      if (!this.ports.listSpaces().some((row) => row.id === spaceId)) {
        failCreate("The space was not created.");
      }
      outcome.spaceId = spaceId;
      outcome.stages["space-create"] = { status: "succeeded" };
      publish(outcome);
    } catch (error) {
      if (this.ports.listSpaces().some((row) => row.id === spaceId)) {
        outcome.spaceId = spaceId;
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
        await this.assertBuiltinRuntimeUnchanged(staged);
        if (pkg.source.type === "builtin") {
          installed.push({ name: pkg.name, version: pkg.version });
          outcome.packageResults[index] = { name: pkg.name, version: pkg.version, status: "succeeded" };
          outcome.installed = [...installed];
          publish(outcome);
          continue;
        }
        if (pkg.source.type !== "npm") {
          throw publicError(GITHUB_APPLY_MESSAGE);
        }
        const prepared = await this.preparePackage({ ...pkg, source: pkg.source }, ctx.signal);
        await this.assertBuiltinRuntimeUnchanged(staged);
        throwIfAborted(ctx.signal);
        try {
          await this.ports.installPlugin(spaceId, prepared.archivePath);
        } catch (error) {
          throw publicError(durableFailureReason(error, "packages"));
        }
        const actual = readInstalledIdentity(this.ports.home, spaceId, pkg.name);
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
      await this.assertBuiltinRuntimeUnchanged(staged);
      composeBundles(this.ports.home, spaceId, staged.blueprint.profile.bundles, { includeLlmBridge: false });
      const compositionError = await this.compositionError(spaceId, staged.blueprint, bound.patch);
      if (compositionError) throw publicError(compositionError);
      outcome.host = hostOutcome(await this.hostVersions(spaceId));
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
      await this.assertBuiltinRuntimeUnchanged(staged);
      currentWrite = "patch";
      this.writeBoundPatch(spaceId, bound.patch);
      writes[0] = { kind: "patch", status: "succeeded" };
      currentWrite = undefined;
      outcome.writes = [...writes];
      publish(outcome);
      currentWrite = "settings";
      writeBoundSettings(this.ports.home, spaceId, bound.settings);
      writes[1] = { kind: "settings", status: "succeeded" };
      currentWrite = undefined;
      outcome.writes = [...writes];
      publish(outcome);
      if (bound.model) {
        currentWrite = "model";
        await this.bindModel(spaceId, bound.model);
        writes[2] = { kind: "model", status: "succeeded" };
        currentWrite = undefined;
      }
      outcome.writes = [...writes];
      publish(outcome);
      composeBundles(this.ports.home, spaceId, staged.blueprint.profile.bundles, {
        includeLlmBridge: Boolean(bound.model),
      });
      if (bound.model) {
        const lateError = await this.compositionError(spaceId, staged.blueprint, bound.patch, { force: true });
        if (lateError) throw publicError(lateError);
      }
      currentWrite = "provenance";
      await this.assertBuiltinRuntimeUnchanged(staged);
      writeProvenance(this.ports.home, spaceId, staged.blueprint, staged.values);
      writes[3] = { kind: "provenance", status: "succeeded" };
      currentWrite = undefined;
      outcome.writes = [...writes];
      outcome.host = hostOutcome(await this.hostVersions(spaceId));
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

  private async assertBuiltinRuntimeUnchanged(staged: StagedPlan): Promise<void> {
    if (!staged.blueprint.packages.some((pkg) => pkg.source.type === "builtin")) return;
    const error = await this.builtinIdentityError(staged.blueprint);
    if (error) throw publicError(error);
    const inspected = await this.inspectRuntimeSnapshot(staged.blueprint);
    if (inspected?.fingerprint !== staged.observation.runtimeFingerprint) {
      throw publicError("The bound runtime changed after preview.");
    }
  }

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
