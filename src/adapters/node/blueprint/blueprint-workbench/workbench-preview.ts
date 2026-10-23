import { randomUUID } from "node:crypto";
import { bindDocumentInputs, diagnoseDocument, type BlueprintRecipe as Blueprint } from "@klarkxy/dsh-blueprint/document";
import { BLUEPRINT_CODE, BlueprintError, type BlueprintDiagnostic, type BlueprintInputValues } from "../../../../shared/blueprint";
import { BLUEPRINT_PLAN_MAX_COUNT, BLUEPRINT_PLAN_MAX_TOTAL_BYTES, BLUEPRINT_PLAN_TTL_MS, type WorkbenchBlueprintInspectPayload, type WorkbenchBlueprintPreviewPayload } from "../../../../shared/workbench-blueprint";
import type { PlanObservation, StagedPlan } from "./types";
import { INSPECT_RUNTIME_FAILED } from "./constants";
import { publicError, isInspectRuntimeFailure } from "./errors";
import { blockingApplyDiagnostics, previewInputs, isRequiredInput, secretFindingsOfBlueprint, secretFindingsOfConfig, environmentFromHost, evidenceFromBlueprint } from "./diagnostics";
import { directoryInputError } from "./isolation-config";
import { decodeContent } from "./generate-blueprint";
import { BlueprintWorkbenchBindOps } from "./workbench-bind";

export class BlueprintWorkbenchPreviewOps extends BlueprintWorkbenchBindOps {

  async inspect(content: string): Promise<WorkbenchBlueprintInspectPayload> {
    const blueprint = decodeContent(content);
    const diagnostics = diagnoseDocument(blueprint.document, environmentFromHost(await this.hostVersions()));
    return { method: "blueprint.inspect", blueprint: blueprint.document, diagnostics };
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
      const diagnostics = diagnoseDocument(
        blueprint.document,
        environmentFromHost(host, evidenceFromBlueprint(blueprint)),
      );
      const gate = await this.previewGate(blueprint, name, input.values, diagnostics);
      if (!gate.ok || missingInputs.length > 0) {
        return {
          method: "blueprint.preview",
          blueprint: blueprint.document,
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
      const observation = await this.captureObservation(blueprint);
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
        blueprint: blueprint.document,
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
        blueprint: blueprint.document,
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
    let bound: ReturnType<typeof bindDocumentInputs> | undefined;
    try {
      bound = bindDocumentInputs(blueprint.document, values);
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
    const builtinError = await this.builtinIdentityError(blueprint);
    if (builtinError) diagnostics.push({ code: "blueprint.builtin", message: builtinError, severity: "error" });
    const ok =
      blocking.errors.length === 0 &&
      !secret &&
      !boundSecret &&
      !directoryError &&
      !modelError &&
      !compositionError &&
      !homePatchError && !builtinError;
    return { ok };
  }

  protected consumePlan(planId: string, live: PlanObservation): StagedPlan {
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

  private nowMs(): number {
    return (this.ports.now?.() ?? new Date()).getTime();
  }
}

export function observationsMatch(left: PlanObservation, right: PlanObservation): boolean {
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
