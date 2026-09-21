/** Public blueprint product DTOs. Transient preview/generate may carry receiver-local input values; jobs must not. */
import {
  BLUEPRINT_JSON_MAX_BYTES,
  BLUEPRINT_SHARE_MAX_BYTES,
  type Blueprint,
  type BlueprintDiagnostic,
  type BlueprintInput,
  type BlueprintInputType,
  type BlueprintInputValue,
  type BlueprintInputValues,
  type BlueprintJson,
} from "./blueprint";

export const BLUEPRINT_PLAN_TTL_MS = 5 * 60_000;
export const BLUEPRINT_PLAN_MAX_COUNT = 16;
export const BLUEPRINT_PLAN_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Envelope on top of a 2MiB share code plus a 1MiB JSON document. */
export const WORKBENCH_BLUEPRINT_JSON_OVERHEAD = 256 * 1024;
export const WORKBENCH_BLUEPRINT_REQUEST_BODY_LIMIT =
  BLUEPRINT_SHARE_MAX_BYTES + BLUEPRINT_JSON_MAX_BYTES + WORKBENCH_BLUEPRINT_JSON_OVERHEAD;
export const WORKBENCH_BLUEPRINT_RESPONSE_BODY_LIMIT = 16 * 1024 * 1024;

export const BLUEPRINT_ORIGIN_FILE = "blueprint-origin.json";
export const BLUEPRINT_LOCAL_FILE = "blueprint-local.json";
export const BLUEPRINT_ORIGIN_SCHEMA_VERSION = 1 as const;

export const BLUEPRINT_PRODUCT_METHODS = [
  "blueprint.source",
  "blueprint.generate",
  "blueprint.inspect",
  "blueprint.preview",
] as const;

export type BlueprintProductMethod = (typeof BLUEPRINT_PRODUCT_METHODS)[number];

export const BLUEPRINT_APPLY_KIND = "blueprint.apply" as const;

export const BLUEPRINT_APPLY_STAGES = ["space-create", "packages", "presets", "start"] as const;
export type BlueprintApplyStageName = (typeof BLUEPRINT_APPLY_STAGES)[number];
export type BlueprintStageStatus = "succeeded" | "failed" | "not-run";

export type BlueprintPackageSourceKind = "npm" | "local" | "unknown";

export type BlueprintEligibility =
  | { available: true; reason?: string }
  | { available: false; reason: string };

export interface BlueprintSourcePackage {
  name: string;
  version: string | null;
  requestedSpec?: string;
  source: BlueprintPackageSourceKind;
  integrity?: string;
  inBundles: boolean;
  hasBundlePatch: boolean;
  eligibility: BlueprintEligibility;
  lifecycleScripts: string[];
}

export interface BlueprintSourceBundle {
  name: string;
  order: number;
  eligible: boolean;
  reason?: string;
}

export interface BlueprintSourceNamespace {
  namespace: string;
  eligible: boolean;
  shareable: boolean;
  /** Local values can be declared as inputs; secrets cannot. */
  convertible: boolean;
  reason?: string;
}

export interface BlueprintSourcePatchInfo {
  exists: boolean;
  shareable: boolean;
  reason?: string;
}

export interface BlueprintLocalObservation {
  pointer: string;
  kind: "directory" | "model" | "dynamic" | "managed" | "unknown";
  reason: string;
}

export interface BlueprintHostVersions {
  dsh: string | null;
  spaces: string | null;
  node: string;
  os: string;
  arch: string;
  base: string | null;
  webApp: string | null;
}

export type WorkbenchBlueprintSourceRequest = {
  method: "blueprint.source";
  spaceId: string;
};

export type WorkbenchBlueprintSourcePayload = {
  method: "blueprint.source";
  spaceId: string;
  packages: BlueprintSourcePackage[];
  bundles: BlueprintSourceBundle[];
  patch: BlueprintSourcePatchInfo;
  settingsNamespaces: BlueprintSourceNamespace[];
  localObservations: BlueprintLocalObservation[];
  host: BlueprintHostVersions;
};

export type BlueprintGenerateSelection = {
  packages: string[];
  includePatch: boolean;
  settingsNamespaces: string[];
};

export type BlueprintGenerateBindingOverride = {
  pointer: string;
  input: BlueprintInput;
};

export type WorkbenchBlueprintGenerateRequest = {
  method: "blueprint.generate";
  spaceId: string;
  selection: BlueprintGenerateSelection;
  metadata: { name: string; version: string; description?: string };
  bindingOverrides?: BlueprintGenerateBindingOverride[];
};

export type WorkbenchBlueprintGeneratePayload = {
  method: "blueprint.generate";
  fileName: string;
  json: string;
  shareCode: string;
  blueprint: Blueprint;
  diagnostics: BlueprintDiagnostic[];
};

export type WorkbenchBlueprintInspectRequest = {
  method: "blueprint.inspect";
  content: string;
};

export type WorkbenchBlueprintInspectPayload = {
  method: "blueprint.inspect";
  blueprint: Blueprint;
  diagnostics: BlueprintDiagnostic[];
};

export type BlueprintInputOrigin = "explicit" | "default" | "missing";

export type BlueprintPreviewInput = {
  id: string;
  type: BlueprintInputType;
  origin: BlueprintInputOrigin;
  value?: BlueprintInputValue;
};

export type BlueprintPreviewPackage = {
  name: string;
  version: string;
  source: "npm" | "github";
  bundled: boolean;
  order?: number;
};

export type WorkbenchBlueprintPreviewRequest = {
  method: "blueprint.preview";
  content: string;
  name: string;
  displayName?: string;
  values: BlueprintInputValues;
};

export type WorkbenchBlueprintPreviewPayload = {
  method: "blueprint.preview";
  blueprint: Blueprint;
  packages: BlueprintPreviewPackage[];
  inputs: BlueprintPreviewInput[];
  host: BlueprintHostVersions;
  planId?: string;
  expiresAt?: string;
  diagnostics: BlueprintDiagnostic[];
  missingInputs: string[];
};

export type WorkbenchBlueprintApplyCommand = {
  kind: "blueprint.apply";
  planId: string;
};

export type BlueprintApplyStage = {
  status: BlueprintStageStatus;
  error?: string;
};

export type BlueprintInstalledIdentity = {
  name: string;
  version: string;
  integrity?: string;
};

export type BlueprintPackageResultStatus = BlueprintStageStatus;

export type BlueprintPackageResult = {
  name: string;
  version: string;
  status: BlueprintPackageResultStatus;
  error?: string;
};

export type BlueprintWriteKind = "patch" | "settings" | "model" | "provenance";

export type BlueprintWriteResult = {
  kind: BlueprintWriteKind;
  status: BlueprintStageStatus;
  error?: string;
  namespace?: string;
};

export type WorkbenchBlueprintApplyOutcome = {
  kind: "blueprint.apply";
  spaceId?: string;
  stages: {
    "space-create": BlueprintApplyStage;
    packages: BlueprintApplyStage;
    presets: BlueprintApplyStage;
    start: { status: "not-run" };
  };
  installed: BlueprintInstalledIdentity[];
  packageResults: BlueprintPackageResult[];
  writes: BlueprintWriteResult[];
  host: { dsh: string | null; spaces: string | null; base: string | null; webApp: string | null };
  source?: { name: string; version: string };
};

export type WorkbenchBlueprintProductRequest =
  | WorkbenchBlueprintSourceRequest
  | WorkbenchBlueprintGenerateRequest
  | WorkbenchBlueprintInspectRequest
  | WorkbenchBlueprintPreviewRequest;

export type WorkbenchBlueprintProductPayload =
  | WorkbenchBlueprintSourcePayload
  | WorkbenchBlueprintGeneratePayload
  | WorkbenchBlueprintInspectPayload
  | WorkbenchBlueprintPreviewPayload;

export function isBlueprintProductMethod(method: string): method is BlueprintProductMethod {
  return (BLUEPRINT_PRODUCT_METHODS as readonly string[]).includes(method);
}

/** Inspect/preview carry share-code or JSON content. */
export function isBlueprintLargeRequestMethod(method: string): boolean {
  return method === "blueprint.inspect" || method === "blueprint.preview";
}

/** Generate/inspect/preview may return a full blueprint plus JSON/share encodings. */
export function isBlueprintLargeResponseMethod(method: string): boolean {
  return (
    method === "blueprint.generate" ||
    method === "blueprint.inspect" ||
    method === "blueprint.preview"
  );
}

export type BlueprintOriginRecord = {
  schemaVersion: typeof BLUEPRINT_ORIGIN_SCHEMA_VERSION;
  blueprint: Blueprint;
  bindings: Array<{
    input: string;
    pointer?: string;
    kind: "value" | "default-model";
    entryId?: string;
    entryName?: string;
    namespace?: string;
  }>;
  appliedAt: string;
};

export type BlueprintLocalRecord = {
  schemaVersion: typeof BLUEPRINT_ORIGIN_SCHEMA_VERSION;
  values: { [inputId: string]: BlueprintJson };
};
