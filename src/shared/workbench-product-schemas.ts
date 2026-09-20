/** Strict product DTO validators. Shape/format/limits only; no local paths or URL credentials. */
import { z } from "zod";
import { LLM_SHARE_NOTE } from "../core/domain/llm-share";
import { isExactRuntimeVersion } from "./runtime";
import {
  MAX_WORKBENCH_SHARE_BASE64,
  type WorkbenchProductCommand,
  type WorkbenchProductOutcome,
  type WorkbenchProductRequest,
  type WorkbenchProductResult,
} from "./workbench-product";

const SPACE_ID_RE = /^(?:web|[a-z0-9][a-z0-9-]{0,38})$/;
const ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const CONTENT_HASH_RE = /^[a-f0-9]{16,128}$/;
const PACKAGE_NAME_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/;
const CATALOG_ID_RE = PACKAGE_NAME_RE;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,118}(?:\.[A-Za-z0-9]{1,16})?$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX_COLORLESS_PATH = /(?:^|[\s"'=])(?:\/(?:home|Users|root|opt|var|tmp)\/|[A-Za-z]:\\)/;

export const workbenchMutationContextSchema = z
  .object({
    serviceEpoch: z.string().regex(DIGEST_RE),
    expectedRevision: z.string().regex(DIGEST_RE),
  })
  .strict();

const spaceIdSchema = z.string().regex(SPACE_ID_RE);
const entityIdSchema = z.string().regex(ENTITY_ID_RE);
const isoDateSchema = z.string().regex(ISO_DATE_RE);
const displayNameSchema = z.string().min(1).max(80);
const packageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(PACKAGE_NAME_RE)
  .refine((value) => !containsLocalPath(value) && !containsCredentialUrl(value), "package name");
const catalogIdSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(CATALOG_ID_RE)
  .refine(
    (value) =>
      !value.includes("..") &&
      !/^(file|git|git\+|https?|ssh):/i.test(value) &&
      !/[\s;|&$`<>(){}]/.test(value) &&
      !containsLocalPath(value),
    "catalog id",
  );
const exactVersionSchema = z.string().refine(isExactRuntimeVersion, "exact version required");
// Library keys are persisted npm pins, catalog IDs or GitHub specs, not entity UUIDs.
const libraryIdSchema = z.string().min(1).max(512).refine((value) => {
  if (containsLocalPath(value) || containsCredentialUrl(value)) return false;
  if (ENTITY_ID_RE.test(value)) return true;
  const npm = /^((?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*)(?:@(.+))?$/.exec(value);
  if (npm) return npm[2] === undefined || isExactRuntimeVersion(npm[2]);
  return /^(?:github:)?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:#[A-Za-z0-9][A-Za-z0-9._/-]{0,127})?$/.test(value);
}, "library id");
const httpUrlSchema = z.string().max(2048).refine((value) => isHttpUrlWithoutCredentials(value), "http url");
const optionalHttpUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => value === "" || isHttpUrlWithoutCredentials(value), "catalog url");

const homeSettingsSchema = z
  .object({
    portStart: z.number().int().min(1024).max(65535),
    portEnd: z.number().int().min(1024).max(65535),
    packageSource: z.enum(["china", "official"]),
    catalogUrl: optionalHttpUrlSchema,
  })
  .strict()
  .refine((value) => value.portEnd >= value.portStart, "portEnd must be >= portStart");

const libraryItemSchema = z
  .object({
    id: libraryIdSchema,
    packageName: packageNameSchema,
    title: z.string().min(1).max(200),
    version: z.union([exactVersionSchema, z.null()]),
    source: z.enum(["catalog", "manual", "installed"]),
    downloadedAt: isoDateSchema,
    installedIn: z.array(spaceIdSchema).max(256),
  })
  .strict();

const diagnosticLogSchema = z
  .object({
    at: isoDateSchema,
    channel: z.enum(["stdout", "stderr", "lifecycle"]),
    text: z.string().max(2000),
  })
  .strict();

const backupMetaSchema = z
  .object({
    id: entityIdSchema,
    createdAt: isoDateSchema,
    size: z.number().int().nonnegative().max(8 * 1024 * 1024),
    tooLarge: z.boolean(),
  })
  .strict();

const diagnosticsSchema = z
  .object({
    spaceId: spaceIdSchema,
    status: z.enum(["running", "starting", "stopping", "stopped", "crashed", "unknown"]),
    lastError: z.string().max(500).optional(),
    logs: z.array(diagnosticLogSchema).max(256),
    logError: z.string().max(500).optional(),
    backups: z.array(backupMetaSchema).max(256),
  })
  .strict();

const catalogMetaSchema = z
  .object({
    schemaVersion: z.number().int().positive().max(16),
    generatedAt: isoDateSchema,
    count: z.number().int().nonnegative().max(10_000),
    contentHash: z.string().regex(CONTENT_HASH_RE),
  })
  .strict();

const catalogEntrySchema = z
  .object({
    id: z.string().min(1).max(214),
    repo: z.string().min(1).max(200),
    owner: z.string().min(1).max(100),
    url: httpUrlSchema,
    tier: z.enum(["verified-npm", "verified-git", "likely-plugin", "related"]),
    packageName: packageNameSchema.optional(),
    installMethod: z.enum(["npm", "git", "manual"]),
    installSpec: z
      .string()
      .max(214)
      .refine((value) => !containsLocalPath(value) && !containsCredentialUrl(value), "install spec")
      .optional(),
    runsBuildScript: z.boolean(),
    description: z.string().max(2000),
    summary: z.string().max(500).optional(),
    summaryEn: z.string().max(500).optional(),
    category: z.string().max(80).optional(),
    tags: z.array(z.string().max(80)).max(64),
    stars: z.number().int().nonnegative(),
    license: z.string().max(80).optional(),
    hasClient: z.boolean(),
  })
  .strict();

const catalogSnapshotSchema = z
  .object({
    meta: catalogMetaSchema,
    entries: z.array(catalogEntrySchema).max(1024),
    source: z.enum(["remote", "cache", "seed"]),
    url: optionalHttpUrlSchema,
  })
  .strict();

const sharePluginSchema = z
  .object({
    packageName: packageNameSchema,
    requestedSpec: z
      .string()
      .max(214)
      .refine((value) => !containsLocalPath(value) && !containsCredentialUrl(value), "requested spec")
      .optional(),
    resolvedVersion: z.union([exactVersionSchema, z.null()]),
    source: z.enum(["npm", "git", "manual", "unknown"]),
    installSpec: z
      .string()
      .max(214)
      .refine((value) => !containsLocalPath(value) && !containsCredentialUrl(value), "install spec")
      .optional(),
  })
  .strict();

const llmShareRequirementSchema = z
  .object({
    requirementId: z.string().min(1).max(80),
    displayName: displayNameSchema,
    protocol: z.string().min(1).max(80),
    endpoint: httpUrlSchema,
    modelIds: z.array(z.string().min(1).max(200)).max(1000),
    authKind: z.enum(["api-key", "none"]),
    usedAsDefault: z.boolean(),
  })
  .strict();

const llmShareManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("dsh-space-llm-requirements"),
    sourceSharedMode: z.enum(["none", "all", "selected"]),
    requirements: z.array(llmShareRequirementSchema).max(256),
    defaultRequirementId: z.string().min(1).max(80).nullable(),
    adapterRequired: z.literal("llm-pi-ai"),
    note: z.literal(LLM_SHARE_NOTE),
  })
  .strict();

const shareManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    kind: z.literal("dsh-space"),
    exportedAt: isoDateSchema,
    source: z
      .object({
        dshVersion: z.union([exactVersionSchema, z.null()]).optional(),
      })
      .strict(),
    space: z
      .object({
        displayName: displayNameSchema,
        icon: z.string().max(16_384).optional(),
      })
      .strict(),
  })
  .strict();

const sharePreviewSchema = z
  .object({
    manifest: shareManifestSchema,
    plugins: z.array(sharePluginSchema).max(256),
    hasConfig: z.boolean(),
    unknownSources: z.array(z.string().max(214)).max(256),
    llmMappingRequired: z.boolean(),
    llmRequirements: z.array(llmShareRequirementSchema).max(256),
  })
  .strict();

const spaceRecipeSchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: displayNameSchema,
    icon: z.string().max(16_384).optional(),
    plugins: z.array(sharePluginSchema).max(256),
    patch: z
      .string()
      .max(256 * 1024)
      .refine((value) => !HEX_COLORLESS_PATH.test(value), "recipe patch")
      .optional(),
    llm: llmShareManifestSchema.optional(),
    source: z
      .object({
        dshVersion: z.union([exactVersionSchema, z.null()]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const spaceTemplateSchema = z
  .object({
    id: entityIdSchema,
    name: z.string().min(1).max(80),
    displayName: displayNameSchema,
    plugins: z.array(sharePluginSchema).max(256),
    createdAt: isoDateSchema,
    recipe: spaceRecipeSchema.optional(),
  })
  .strict();

const spaceImportResultSchema = z
  .object({
    definition: z.enum(["imported", "failed"]),
    plugins: z.enum(["completed", "failed", "pending-manual", "not-run"]),
    start: z.enum(["not-run", "failed"]),
    spaceId: spaceIdSchema.optional(),
    errors: z.array(z.string().max(500)).max(64),
    pendingManual: z.array(sharePluginSchema).max(256),
    llm: z
      .object({
        mappingRequired: z.boolean(),
        requirements: z.array(llmShareRequirementSchema).max(256),
        mapped: z.literal(false),
      })
      .strict()
      .optional(),
  })
  .strict();

const archiveBase64Schema = z
  .string()
  .min(1)
  .max(MAX_WORKBENCH_SHARE_BASE64)
  .regex(BASE64_RE)
  .refine((value) => value.length % 4 === 0, "archive base64");

const downloadSpecSchema = z
  .string()
  .min(1)
  .max(214)
  .refine((value) => !containsLocalPath(value) && !containsCredentialUrl(value), "download spec")
  .refine((value) => !/^(file|git|git\+|https?|ssh):/i.test(value), "download spec protocol")
  .refine((value) => !/[\s;|&$`<>(){}]/.test(value), "download spec");

export const workbenchProductRequestSchema: z.ZodType<WorkbenchProductRequest> = z.discriminatedUnion("method", [
  z.object({ method: z.literal("settings") }).strict(),
  z.object({ method: z.literal("catalog"), query: z.string().max(200).optional() }).strict(),
  z.object({ method: z.literal("library") }).strict(),
  z.object({ method: z.literal("diagnostics"), spaceId: spaceIdSchema }).strict(),
  z.object({ method: z.literal("templates") }).strict(),
  z
    .object({
      method: z.literal("share.export"),
      spaceId: spaceIdSchema,
      includeConfig: z.boolean().optional(),
    })
    .strict(),
  z.object({ method: z.literal("share.previewImport"), archiveBase64: archiveBase64Schema }).strict(),
]);

export const workbenchProductCommandSchema: z.ZodType<WorkbenchProductCommand> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workbench.prepare"), version: z.union([z.literal("latest"), exactVersionSchema]).optional() }).strict(),
  z.object({ kind: z.literal("settings.update"), settings: homeSettingsSchema }).strict(),
  z.object({ kind: z.literal("catalog.refresh"), url: optionalHttpUrlSchema.optional() }).strict(),
  z
    .object({
      kind: z.literal("plugin.download"),
      catalogId: catalogIdSchema.optional(),
      spec: downloadSpecSchema.optional(),
      version: exactVersionSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("plugin.library.remove"), libraryId: libraryIdSchema }).strict(),
  z
    .object({
      kind: z.literal("template.save"),
      spaceId: spaceIdSchema,
      name: z.string().min(1).max(80),
      includeConfig: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("template.create"),
      templateId: entityIdSchema,
      name: z.string().min(1).max(80),
      displayName: displayNameSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("space.import"),
      importId: entityIdSchema,
      name: z.string().min(1).max(80),
      displayName: displayNameSchema.optional(),
    })
    .strict(),
]);

export const workbenchProductOutcomeSchema: z.ZodType<WorkbenchProductOutcome> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workbench.prepare"), candidate: z.object({
    id: z.literal("bundled-workbench"), version: exactVersionSchema,
    installedVersion: z.union([exactVersionSchema, z.null()]),
    digest: z.string().regex(DIGEST_RE), updateAvailable: z.boolean(),
  }).strict() }).strict(),
  z.object({ kind: z.literal("settings.update"), settings: homeSettingsSchema }).strict(),
  z.object({ kind: z.literal("catalog.refresh"), count: z.number().int().nonnegative().max(10_000) }).strict(),
  z.object({ kind: z.literal("plugin.download"), item: libraryItemSchema }).strict(),
  z.object({ kind: z.literal("plugin.library.remove"), libraryId: libraryIdSchema }).strict(),
  z.object({ kind: z.literal("template.save"), templateId: entityIdSchema }).strict(),
  z.object({ kind: z.literal("template.create"), import: spaceImportResultSchema }).strict(),
  z.object({ kind: z.literal("space.import"), import: spaceImportResultSchema }).strict(),
]);

const productObservationSchema = workbenchMutationContextSchema;

export const workbenchProductResultSchema: z.ZodType<WorkbenchProductResult> = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("settings"),
      settings: homeSettingsSchema,
      clientDefaults: z
        .object({
          locale: z.enum(["system", "en", "zh"]),
          theme: z.enum(["system", "light", "dark"]),
        })
        .strict(),
      observation: productObservationSchema,
    })
    .strict(),
  z.object({ method: z.literal("catalog"), catalog: catalogSnapshotSchema, observation: productObservationSchema }).strict(),
  z.object({ method: z.literal("library"), items: z.array(libraryItemSchema).max(256), observation: productObservationSchema }).strict(),
  z.object({ method: z.literal("diagnostics"), diagnostics: diagnosticsSchema, observation: productObservationSchema }).strict(),
  z
    .object({
      method: z.literal("templates"),
      templates: z.array(spaceTemplateSchema).max(256),
      observation: productObservationSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("share.export"),
      fileName: z.string().regex(FILE_NAME_RE),
      archiveBase64: archiveBase64Schema,
      preview: sharePreviewSchema,
      observation: productObservationSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("share.previewImport"),
      importId: entityIdSchema,
      expiresAt: isoDateSchema,
      preview: sharePreviewSchema,
      observation: productObservationSchema,
    })
    .strict(),
]);

export function parseWorkbenchProductRequest(value: unknown): WorkbenchProductRequest {
  return workbenchProductRequestSchema.parse(value);
}

export function parseWorkbenchProductCommand(value: unknown): WorkbenchProductCommand {
  return workbenchProductCommandSchema.parse(value);
}

export function parseWorkbenchProductOutcome(value: unknown): WorkbenchProductOutcome {
  return workbenchProductOutcomeSchema.parse(value);
}

export function parseWorkbenchProductResult(value: unknown): WorkbenchProductResult {
  return workbenchProductResultSchema.parse(value);
}

function containsLocalPath(value: string): boolean {
  if (value.includes("\\") || value.includes("..")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  return /^(?:file|git|git\+|ssh):/i.test(value);
}

function containsCredentialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return true;
    return false;
  } catch {
    return /:\/\/[^/?#]*:[^/?#]*@/.test(value);
  }
}

function isHttpUrlWithoutCredentials(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.hostname === "") return false;
  return true;
}
