/** Blueprint v1 shared types. Node codec and later apply services import these names. */

export const BLUEPRINT_KIND = "dsh-blueprint" as const;
export const BLUEPRINT_FORMAT_VERSION = 1 as const;
export const BLUEPRINT_SHARE_PREFIX = "DSHBP1" as const;

/** JSON file or decompressed JSON, UTF-8 bytes. */
export const BLUEPRINT_JSON_MAX_BYTES = 1024 * 1024;
/** Share code after trimming leading/trailing SP/HT/CR/LF, ASCII bytes. */
export const BLUEPRINT_SHARE_MAX_BYTES = 2 * 1024 * 1024;
/** JSON object/array nesting; the root object is depth 1. */
export const BLUEPRINT_MAX_DEPTH = 64;

export const BLUEPRINT_OS = ["win32", "darwin", "linux"] as const;
export const BLUEPRINT_ARCH = ["x64", "arm64"] as const;
export const BLUEPRINT_INPUT_TYPES = ["string", "number", "boolean", "directory", "model"] as const;
export const BLUEPRINT_RELATION_TYPES = ["requires", "conflicts", "integrates", "after"] as const;
export const BLUEPRINT_TEST_CHECKS = ["install", "compose", "start", "interaction"] as const;
export const BLUEPRINT_HOST_PACKAGES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] as const;
export const BLUEPRINT_FORBIDDEN_SETTINGS = ["llm-pi-ai", "agent-default-model"] as const;
export const BLUEPRINT_SPACES_CONTROL_PACKAGES = [
  "@dsh-spaces/plugin",
  "@dsh-spaces/view-bridge",
  "@dsh-spaces/llm-bridge",
] as const;
export const BLUEPRINT_MANAGED_ENTRY_IDS = [
  "session-persistence-jsonl",
  "storage-json",
  "settings",
  "credentials",
] as const;

export const BLUEPRINT_INPUT_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const BLUEPRINT_GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const BLUEPRINT_GIT_COMMIT_RE = /^[a-f0-9]{40}$/;

export type BlueprintKind = typeof BLUEPRINT_KIND;
export type BlueprintFormatVersion = typeof BLUEPRINT_FORMAT_VERSION;
export type BlueprintOs = (typeof BLUEPRINT_OS)[number];
export type BlueprintArch = (typeof BLUEPRINT_ARCH)[number];
export type BlueprintInputType = (typeof BLUEPRINT_INPUT_TYPES)[number];
export type BlueprintRelationType = (typeof BLUEPRINT_RELATION_TYPES)[number];
export type BlueprintTestCheck = (typeof BLUEPRINT_TEST_CHECKS)[number];
export type BlueprintHostPackage = (typeof BLUEPRINT_HOST_PACKAGES)[number];
export type BlueprintShareEncoding = "J" | "Z";
export type BlueprintEncodeMode = BlueprintShareEncoding | "shortest";
export type BlueprintDiagnosticSeverity = "info" | "warning" | "error";

/** JSON values allowed in plugin config, settings, and extensions. */
export type BlueprintJson =
  | null
  | boolean
  | number
  | string
  | BlueprintJson[]
  | { [key: string]: BlueprintJson };

export type BlueprintJsonObject = { [key: string]: BlueprintJson };

export class BlueprintError extends Error {
  readonly name = "BlueprintError";
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

export function isBlueprintError(error: unknown): error is BlueprintError {
  return error instanceof BlueprintError;
}

export const BLUEPRINT_CODE = {
  INVALID_TYPE: "blueprint.invalid-type",
  INVALID_JSON: "blueprint.invalid-json",
  DUPLICATE_KEY: "blueprint.duplicate-key",
  BOM: "blueprint.bom",
  SURROGATE: "blueprint.surrogate",
  NUMBER: "blueprint.number",
  DEPTH: "blueprint.depth",
  JSON_TOO_LARGE: "blueprint.json-too-large",
  SHARE_TOO_LARGE: "blueprint.share-too-large",
  UNKNOWN_FIELD: "blueprint.unknown-field",
  INVALID_FIELD: "blueprint.invalid-field",
  UNSUPPORTED_VERSION: "blueprint.unsupported-version",
  INVALID_SHARE: "blueprint.invalid-share",
  BASE64: "blueprint.base64",
  UTF8: "blueprint.utf8",
  DEFLATE: "blueprint.deflate",
  POINTER: "blueprint.pointer",
  BINDING: "blueprint.binding",
  INPUT_REQUIRED: "blueprint.input-required",
  INPUT_TYPE: "blueprint.input-type",
  DYNAMIC: "blueprint.dynamic",
} as const;

export type BlueprintErrorCode = (typeof BLUEPRINT_CODE)[keyof typeof BLUEPRINT_CODE];

export interface BlueprintDiagnostic {
  code: string;
  message: string;
  severity: BlueprintDiagnosticSeverity;
  path?: string;
}

export type BlueprintModelRef = {
  connectionId: string;
  modelId: string;
};

export type BlueprintInputValue = string | number | boolean | BlueprintModelRef;

/** Receiver-local values keyed by input id. */
export type BlueprintInputValues = { [inputId: string]: BlueprintInputValue };

export interface BlueprintMetadata {
  name: string;
  version: string;
  id?: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
}

export interface BlueprintRequirements {
  dsh?: string;
  spaces?: string;
  node?: string;
  os?: BlueprintOs[];
  arch?: BlueprintArch[];
}

export type BlueprintPackageSource =
  | { type: "npm" }
  | { type: "github"; repository: string; commit: string };

export interface BlueprintPackage {
  name: string;
  version: string;
  source: BlueprintPackageSource;
  integrity?: string;
}

export interface BlueprintPatchEntry {
  id: string;
  /** Overlay: match guard, not a module replacement. Inserted rows require name. */
  name?: string;
  /** Whole-config replacement. `null` is official clear; omit means leave unchanged. */
  config?: BlueprintJson;
  group?: boolean | null;
  disabled?: boolean | null;
  inject?: string[] | BlueprintJsonObject | null;
  intercept?: BlueprintJsonObject | null;
  isolate?: { [service: string]: true | string } | null;
}

/** Root insert omits `id`. Targeted group insert uses closed keys `id` + `insert`. */
export interface BlueprintPatchInsert {
  id?: string;
  insert: BlueprintPatchEntry[];
}

export type BlueprintPatchItem = BlueprintPatchEntry | BlueprintPatchInsert;

export type BlueprintPatch = BlueprintPatchItem[];

export type BlueprintSettings = { [namespace: string]: BlueprintJson };

export interface BlueprintProfile {
  base: "web";
  bundles: string[];
  patch: BlueprintPatch;
  settings: BlueprintSettings;
}

export interface BlueprintInput {
  id: string;
  type: BlueprintInputType;
  label: string;
  required: boolean;
  description?: string;
  default?: string | number | boolean;
}

export type BlueprintBindingTarget =
  | { kind: "value"; pointer: string }
  | { kind: "default-model" };

export interface BlueprintBinding {
  input: string;
  target: BlueprintBindingTarget;
}

export interface BlueprintRelation {
  type: BlueprintRelationType;
  from: string;
  to: string;
  reason: string;
  fromVersion?: string;
  toVersion?: string;
}

export interface BlueprintTestedWith {
  dsh: string;
  spaces: string;
  node: string;
  os: BlueprintOs;
  arch: BlueprintArch;
  checkedAt: string;
  checks: BlueprintTestCheck[];
  evidence?: string;
}

export interface Blueprint {
  kind: BlueprintKind;
  formatVersion: BlueprintFormatVersion;
  metadata: BlueprintMetadata;
  requirements?: BlueprintRequirements;
  packages: BlueprintPackage[];
  profile: BlueprintProfile;
  inputs: BlueprintInput[];
  bindings: BlueprintBinding[];
  relations: BlueprintRelation[];
  testedWith?: BlueprintTestedWith[];
  extensions?: BlueprintJsonObject;
}

export interface BlueprintBindResult {
  patch: BlueprintPatch;
  settings: BlueprintSettings;
  model?: BlueprintModelRef;
}

/**
 * Static and runtime package evidence for diagnosis.
 * `selected` / `installed` / `bundled` / `active` are independent.
 * Omit `version` when the exact version is unknown. Absence of a flag is unknown, not false.
 */
export interface BlueprintPackageEvidence {
  name: string;
  version?: string;
  selected?: boolean;
  installed?: boolean;
  bundled?: boolean;
  active?: boolean;
}

/**
 * Receiver environment. Host versions are exact. Package rows are only the
 * evidence the caller actually has; missing rows stay unknown.
 */
export interface BlueprintEnvironment {
  dsh?: string;
  spaces?: string;
  node?: string;
  os?: BlueprintOs;
  arch?: BlueprintArch;
  packages?: readonly BlueprintPackageEvidence[];
}

export const BLUEPRINT_SCHEMA_ID = "dsh-blueprint-v1";
export const BLUEPRINT_SCHEMA_RELATIVE_PATH = "schemas/blueprint-v1.schema.json";
