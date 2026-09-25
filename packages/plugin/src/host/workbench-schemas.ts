import { z } from "zod";
import { SNAPSHOT_ID_RE } from "../../../../src/shared/snapshots";
import { isExactRuntimeVersion } from "../../../../src/shared/runtime";
import { MAX_SPACE_ICON_DATA_URL_CHARS } from "../../../../src/shared/space-icon";
import {
  workbenchMutationContextSchema,
  workbenchProductCommandSchema,
  workbenchProductOutcomeSchema,
  workbenchProductRequestSchema,
  workbenchProductResultSchema,
} from "../../../../src/shared/workbench-product-schemas";
import { parseLoopbackOrigin, parseRelativeEntryPath } from "./loopback";
import { identifier, parseSelection } from "../../../../src/core/domain/dashboard/validation";

// Keep native Remote validation aligned with the same strict dashboard contract
// used by the Supervisor. Accepting a plan here never grants execution rights.
const dashboardIdentifierSchema = z.string().refine((value) => {
  try { identifier(value); return true; } catch { return false; }
}, "invalid dashboard identifier");
const dashboardSelectionSchema = z.union([
  z.null(),
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("selected"), instanceIds: z.array(dashboardIdentifierSchema).min(1).max(100) }).strict(),
]).refine((value) => {
  try { parseSelection(value); return true; } catch { return false; }
}, "invalid dashboard selection");

export {
  workbenchMutationContextSchema as mutationContextSchema,
  workbenchProductCommandSchema,
  workbenchProductOutcomeSchema,
  workbenchProductRequestSchema,
  workbenchProductResultSchema,
};

const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const spaceIdSchema = z
  .string()
  .refine((value) => value === "web" || /^[a-z0-9][a-z0-9-]{0,38}$/.test(value), "invalid space id");

export const jobIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const requestIdSchema = jobIdSchema;
export const planIdSchema = jobIdSchema;
export const snapshotIdSchema = z.string().regex(SNAPSHOT_ID_RE);
export const pluginsQuerySchema = z.string().max(200);
export const catalogIdSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/)
  .refine(
    (value) => !value.includes("..") && !/^(file|git|git\+|https?|ssh):/i.test(value) && !/[\s;|&$`<>(){}]/.test(value),
    "catalog id",
  );
export const exactVersionSchema = z.string().refine(isExactRuntimeVersion, "exact version required");
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);

const iconSchema = z.string().max(MAX_SPACE_ICON_DATA_URL_CHARS);
const displayNameSchema = z.string().min(1).max(80);
const reasonsSchema = z.array(z.string().max(500)).max(32);

export const workbenchRoleSchema = z.enum(["manager", "workspace", "uninitialized"]);

export const workbenchSpaceSchema = z
  .object({
    id: spaceIdSchema,
    displayName: z.string(),
    isHost: z.boolean(),
    hasWebApp: z.boolean(),
    isolation: z.enum(["verified", "unverified", "invalid", "default"]),
    icon: z.string(),
    status: z.enum(["running", "starting", "stopping", "stopped", "crashed", "unknown"]),
    generation: z.number().int(),
    managed: z.boolean(),
    needsIsolation: z.boolean(),
  })
  .strict();

export const workbenchJobErrorSchema = z
  .object({
    code: z.string().min(1).max(128),
    message: z.string().max(500),
    spaceId: spaceIdSchema.optional(),
    stage: z.string().min(1).max(120).optional(),
    packageName: z.string().min(1).max(214).optional(),
    pluginAttribution: z.enum(["known", "unknown"]).optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().min(1).max(32).nullable().optional(),
  })
  .strict();

const loopbackOrigin = z
  .string()
  .refine((value) => parseLoopbackOrigin(value) !== null, "loopback origin")
  .transform((value) => parseLoopbackOrigin(value) as string);
const entryPathSchema = z
  .string()
  .refine((value) => parseRelativeEntryPath(value) !== null, "relative entry path")
  .transform((value) => parseRelativeEntryPath(value) as string);

export const workbenchViewSchema = z
  .object({
    serviceEpoch: hex64Schema,
    spaceId: spaceIdSchema,
    generation: z.number().int(),
    origin: loopbackOrigin,
    entryOrigin: loopbackOrigin,
    entryPath: entryPathSchema,
    channel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  })
  .strict();

export const workbenchJobResultSchema = z
  .object({
    spaceId: spaceIdSchema.optional(),
    snapshotId: snapshotIdSchema.optional(),
    runtimeVersion: exactVersionSchema.optional(),
    view: workbenchViewSchema.optional(),
    product: workbenchProductOutcomeSchema.optional(),
  })
  .strict();

export const workbenchJobSchema = z
  .object({
    id: jobIdSchema,
    requestId: requestIdSchema,
    kind: z.string().min(1).max(64),
    status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    phase: z.string().max(64),
    message: z.string().max(500),
    affectedSpaceIds: z.array(spaceIdSchema).max(256),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
    canCancel: z.boolean(),
    result: workbenchJobResultSchema.optional(),
    error: workbenchJobErrorSchema.optional(),
  })
  .strict();

export const workbenchStateSchema = z
  .object({
    protocolVersion: z.literal(2),
    serviceEpoch: hex64Schema,
    revision: hex64Schema,
    availability: z.enum(["ready", "limited", "unavailable"]),
    role: workbenchRoleSchema,
    managerId: z.union([spaceIdSchema, z.null()]),
    owner: z
      .object({
        kind: z.enum(["web", "desktop"]),
        since: isoDateSchema,
      })
      .strict()
      .nullable(),
    writable: z.boolean(),
    mode: z.enum(["verified-full", "verified-limited", "unknown-readonly", "recovery-only"]),
    dshVersion: z.union([exactVersionSchema, z.null()]),
    maintenance: z.boolean(),
    reasons: reasonsSchema,
    spaces: z.array(workbenchSpaceSchema).max(256),
    jobs: z.array(workbenchJobSchema).max(256),
  })
  .strict();

export const spaceSummarySchema = z
  .object({
    id: spaceIdSchema,
    displayName: z.string(),
    isHost: z.boolean(),
    hasWebApp: z.boolean(),
    status: z.enum(["running", "stopped", "unknown"]),
    isolation: z.enum(["verified", "unverified", "invalid", "default"]),
  })
  .strict();

export const workbenchSpaceDetailSchema = z
  .object({
    space: spaceSummarySchema,
    plugins: z
      .array(
        z
          .object({
            name: z.string(),
            version: z.union([z.string(), z.null()]),
          })
          .strict(),
      )
      .max(256),
    snapshots: z
      .array(
        z
          .object({
            id: z.string(),
            createdAt: z.string(),
            runtimeVersion: z.union([z.string(), z.null()]),
          })
          .strict(),
      )
      .max(256),
    diagnostics: z
      .array(
        z
          .object({
            level: z.enum(["info", "warning", "error"]),
            code: z.string(),
            message: z.string(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

const createInputSchema = z
  .object({
    name: spaceIdSchema,
    displayName: displayNameSchema.optional(),
    icon: iconSchema.optional(),
    useSharedLlm: z.boolean().optional(),
  })
  .strict();

const coreWorkbenchCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("space.create"), input: createInputSchema }).strict(),
  z
    .object({
      kind: z.literal("space.update"),
      spaceId: spaceIdSchema,
      displayName: displayNameSchema.optional(),
      icon: iconSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("space.reorder"), spaceIds: z.array(spaceIdSchema).min(1).max(256) }).strict(),
  z.object({ kind: z.literal("space.start"), spaceId: spaceIdSchema }).strict(),
  z.object({ kind: z.literal("space.verify"), spaceId: spaceIdSchema }).strict(),
  z.object({ kind: z.literal("plan.execute"), planId: planIdSchema }).strict(),
  z
    .object({
      kind: z.literal("llm.apply"),
      spaceIds: z.array(spaceIdSchema).min(1).max(256),
      catalogRevision: z.number().int().nonnegative(),
      observations: z
        .array(
          z
            .object({
              spaceId: spaceIdSchema,
              status: z.enum(["running", "starting", "stopping", "stopped", "crashed", "unknown"]),
              generation: z.number().int().nonnegative(),
              catalogRevision: z.number().int().nonnegative().nullable(),
              busy: z.boolean(),
              serviceEpoch: hex64Schema,
            })
            .strict(),
        )
        .max(256),
    })
    .strict(),
]);

export const workbenchCommandSchema = z.union([coreWorkbenchCommandSchema, workbenchProductCommandSchema]);

export const workbenchPlanRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dashboard.publication.set"),
    spaceId: spaceIdSchema,
    providerId: dashboardIdentifierSchema,
    expectedGrantRevision: dashboardIdentifierSchema,
    selection: dashboardSelectionSchema,
  }).strict(),
  z.object({ kind: z.literal("space.stop"), spaceId: spaceIdSchema }).strict(),
  z.object({ kind: z.literal("space.restart"), spaceId: spaceIdSchema }).strict(),
  z.object({ kind: z.literal("space.delete"), spaceId: spaceIdSchema, removeData: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("plugin.install"),
      spaceIds: z.array(spaceIdSchema).min(1).max(64),
      catalogId: catalogIdSchema,
      version: exactVersionSchema,
    })
    .strict(),
  z.object({ kind: z.literal("plugin.remove"), spaceId: spaceIdSchema, packageName: z.string().min(1).max(214) }).strict(),
  z
    .object({
      kind: z.literal("plugin.toggle"),
      spaceId: spaceIdSchema,
      pluginId: z.string().min(1).max(214),
      enabled: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("plugin.cleanup-manager"), spaceId: spaceIdSchema }).strict(),
  z.object({ kind: z.literal("snapshot.create") }).strict(),
  z.object({ kind: z.literal("snapshot.delete"), snapshotId: snapshotIdSchema }).strict(),
  z.object({ kind: z.literal("runtime.install"), version: exactVersionSchema }).strict(),
  z.object({ kind: z.literal("runtime.upgrade"), version: exactVersionSchema }).strict(),
  z.object({ kind: z.literal("workbench.upgrade"), catalogId: z.literal("bundled-workbench"), version: exactVersionSchema }).strict(),
  z.object({ kind: z.literal("service.shutdown") }).strict(),
]);

export const workbenchPlanSchema = z
  .object({
    id: planIdSchema,
    kind: z.enum([
      "dashboard.publication.set",
      "space.stop",
      "space.restart",
      "space.delete",
      "plugin.install",
      "plugin.remove",
      "plugin.toggle",
      "plugin.cleanup-manager",
      "snapshot.create",
      "snapshot.delete",
      "runtime.install",
      "runtime.upgrade",
      "workbench.upgrade",
      "service.shutdown",
    ]),
    title: z.string().max(200),
    scope: z.enum(["space", "home", "controller"]),
    affectedSpaceIds: z.array(spaceIdSchema).max(256),
    runningSpaceIds: z.array(spaceIdSchema).max(256),
    changes: z.array(z.string().max(500)).max(64),
    destructive: z.boolean(),
    expiresAt: isoDateSchema,
    serviceEpoch: hex64Schema,
    stateRevision: hex64Schema,
  })
  .strict();

export const workbenchPluginSchema = z
  .object({
    id: z.string().min(1).max(214),
    title: z.string().max(200),
    packageName: z.string().min(1).max(214),
    description: z.string().max(2000),
    version: z.union([z.string(), z.null()]),
    installedIn: z.array(spaceIdSchema).max(256),
    protected: z.boolean(),
  })
  .strict();

export const workbenchPluginListSchema = z.array(workbenchPluginSchema).max(256);

export const workbenchPackageResultSchema = z.object({
  id: z.literal("bundled-workbench"),
  version: exactVersionSchema,
  installedVersion: exactVersionSchema.nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  updateAvailable: z.boolean(),
}).strict().nullable();

export const workbenchSnapshotSchema = z
  .object({
    id: snapshotIdSchema,
    createdAt: isoDateSchema,
    reason: z.string().max(200).optional(),
    runtimeVersion: exactVersionSchema,
    spaceIds: z.array(spaceIdSchema).max(256),
    bytes: z.number().nonnegative(),
    restorable: z.boolean(),
  })
  .strict();

export const workbenchRuntimeSchema = z
  .object({
    version: exactVersionSchema,
    installed: z.boolean(),
    current: z.boolean(),
    compatible: z.boolean(),
  })
  .strict();

export const workbenchRuntimeListSchema = z.array(workbenchRuntimeSchema).max(64);

export const workbenchBackupSchema = z
  .object({
    id: jobIdSchema,
    createdAt: isoDateSchema,
    reason: z.string().max(200),
  })
  .strict();

export const backupsResultSchema = z.array(workbenchBackupSchema).max(256);

export const workbenchGuideRoleSchema = z
  .object({
    role: workbenchRoleSchema,
    profileId: z.union([spaceIdSchema, z.null()]),
    managerId: z.union([spaceIdSchema, z.null()]),
    unavailable: z.boolean(),
    reasons: reasonsSchema,
  })
  .strict();

export const workbenchBootstrapResultSchema = z
  .object({
    ok: z.boolean(),
    connected: z.boolean(),
    unavailable: z.boolean(),
    origin: z.union([loopbackOrigin, z.null()]),
    reasons: reasonsSchema,
  })
  .strict();

export const workbenchReturnTargetSchema = z
  .object({
    available: z.boolean(),
    origin: z.union([loopbackOrigin, z.null()]),
    path: z.union([entryPathSchema, z.null()]),
    unavailable: z.boolean(),
    reasons: reasonsSchema,
  })
  .strict();

export const workbenchInitializeResultSchema = z
  .object({
    ok: z.boolean(),
    connected: z.boolean(),
    unavailable: z.boolean(),
    origin: z.union([loopbackOrigin, z.null()]),
    path: z.union([entryPathSchema, z.null()]),
    managerId: z.union([spaceIdSchema, z.null()]),
    reasons: reasonsSchema,
  })
  .strict();

export const workbenchHostHintSchema = z
  .object({
    role: workbenchRoleSchema,
    unavailable: z.boolean(),
  })
  .strict();

export const capabilitiesSchema = z
  .object({
    mode: z.enum(["verified-full", "verified-limited", "unknown-readonly", "recovery-only"]),
    hostSpaceId: z.union([z.string(), z.null()]),
    dshVersion: z.union([z.string(), z.null()]),
    canCreate: z.boolean(),
    canVerify: z.boolean(),
    reasons: z.array(z.string()),
  })
  .strict();

export const overviewSchema = z
  .object({
    capabilities: capabilitiesSchema,
    spaces: z.array(spaceSummarySchema),
  })
  .strict();

const connectionIdSchema = z.string().uuid();
const llmAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("api-key"), credentialRecordId: z.string().min(1).max(200) }).strict(),
]);
const llmDraftSchema = z
  .object({
    id: connectionIdSchema.optional(),
    displayName: z.string().min(1).max(80),
    enabled: z.boolean().optional(),
    providerConfig: z.record(z.string(), z.unknown()),
    auth: llmAuthSchema.optional(),
  })
  .strict();
const llmModelRefSchema = z.object({ connectionId: connectionIdSchema, modelId: z.string().min(1).max(200) }).strict();
const llmSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("selected"), connectionIds: z.array(connectionIdSchema).max(256) }).strict(),
]);
const llmObservationSchema = z
  .object({
    spaceId: spaceIdSchema,
    status: z.enum(["running", "starting", "stopping", "stopped", "crashed", "unknown"]),
    generation: z.number().int().nonnegative(),
    catalogRevision: z.number().int().nonnegative().nullable(),
    busy: z.boolean(),
    serviceEpoch: hex64Schema,
  })
  .strict();

export const llmApiRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("describe") }).strict(),
  z.object({ method: z.literal("previewChange"), draft: llmDraftSchema, expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ method: z.literal("saveConnection"), draft: llmDraftSchema, expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ method: z.literal("setDefault"), model: llmModelRefSchema.nullable(), expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ method: z.literal("previewDelete"), connectionId: connectionIdSchema }).strict(),
  z.object({ method: z.literal("deleteConnection"), connectionId: connectionIdSchema, expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ method: z.literal("discoverModels"), connectionId: connectionIdSchema.optional(), draft: llmDraftSchema.optional() }).strict(),
  z.object({ method: z.literal("testConnection"), connectionId: connectionIdSchema, modelId: z.string().min(1).max(200), authorize: z.literal(true) }).strict(),
  z.object({ method: z.literal("spacePolicy"), spaceId: spaceIdSchema }).strict(),
  z
    .object({
      method: z.literal("updateSpacePolicy"),
      spaceId: spaceIdSchema,
      shared: llmSelectionSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ method: z.literal("spaceDefault"), spaceId: spaceIdSchema }).strict(),
  z.object({ method: z.literal("updateSpaceDefault"), spaceId: spaceIdSchema, model: llmModelRefSchema.nullable() }).strict(),
  z.object({ method: z.literal("listLocalCandidates"), spaceId: spaceIdSchema }).strict(),
  z
    .object({
      method: z.literal("adoptLocal"),
      spaceId: spaceIdSchema,
      routeId: z.string().min(1).max(200),
      displayName: z.string().min(1).max(80),
      expectedRevision: z.number().int().nonnegative(),
      copyCredential: z.literal(true),
    })
    .strict(),
  z
    .object({
      method: z.literal("applyPlan"),
      spaceIds: z.array(spaceIdSchema).min(1).max(256),
      catalogRevision: z.number().int().nonnegative(),
      observations: z.array(llmObservationSchema).max(256),
      requestId: requestIdSchema,
    })
    .strict(),
  z.object({ method: z.literal("operationStatus"), operationId: requestIdSchema }).strict(),
  z.object({ method: z.literal("previewShare"), spaceId: spaceIdSchema }).strict(),
  z.object({ method: z.literal("importedRequirements"), spaceId: spaceIdSchema }).strict(),
  z
    .object({
      method: z.literal("mapImported"),
      spaceId: spaceIdSchema,
      mappings: z
        .array(z.object({ requirementId: z.string().min(1).max(80), connectionId: connectionIdSchema }).strict())
        .max(256),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
]);

const redactedConnectionSchema = z
  .object({
    id: connectionIdSchema,
    revision: z.number().int().positive(),
    displayName: z.string(),
    enabled: z.boolean(),
    backend: z.literal("llm-pi-ai"),
    providerConfig: z.record(z.string(), z.unknown()),
    auth: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("api-key"), configured: z.literal(true) }).strict(),
    ]),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
    routeId: z.string().regex(/^spaces-llm-[0-9a-f]{32}$/),
    usedBySpaceIds: z.array(spaceIdSchema).optional(),
  })
  .strict();

export const llmApiResultSchema = z.union([
  z
    .object({
      revision: z.number().int().nonnegative(),
      connections: z.array(redactedConnectionSchema).max(256),
      defaultModel: llmModelRefSchema.nullable(),
      capabilities: z
        .object({
          adapter: z.literal("llm-pi-ai"),
          adapterVersion: z.literal("0.1.7-alpha.1"),
          protocols: z.tuple([z.literal("openai-completions"), z.literal("openai-responses"), z.literal("anthropic-messages")]),
          keyless: z.literal(false),
        })
        .strict(),
      pendingRestartSpaceIds: z.array(spaceIdSchema).max(256),
    })
    .strict(),
  z
    .object({
      catalogRevision: z.number().int().nonnegative(),
      affectedSpaceIds: z.array(spaceIdSchema).max(256),
      pendingRestartSpaceIds: z.array(spaceIdSchema).max(256),
      connectionId: connectionIdSchema,
    })
    .strict(),
  z
    .object({
      connectionId: connectionIdSchema,
      references: z
        .array(
          z
            .object({
              spaceId: spaceIdSchema,
              connectionIds: z.array(connectionIdSchema).max(256),
              mode: z.enum(["none", "all", "selected"]),
            })
            .strict(),
        )
        .max(256),
    })
    .strict(),
  z
    .object({
      revision: z.number().int().nonnegative(),
      connections: z.array(redactedConnectionSchema).max(256),
      defaultModel: llmModelRefSchema.nullable(),
      connectionId: connectionIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      spaceId: spaceIdSchema,
      policy: z
        .object({
          schemaVersion: z.literal(1),
          revision: z.number().int().nonnegative(),
          shared: llmSelectionSchema,
        })
        .strict(),
      targetCatalogRevision: z.number().int().nonnegative(),
      runningCatalogRevision: z.number().int().nonnegative().nullable(),
      pendingRestart: z.boolean(),
    })
    .strict(),
  z
    .object({
      models: z.array(z.object({ id: z.string(), name: z.string().optional() }).strict()).max(1000),
      truncated: z.boolean(),
      connectionId: connectionIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      spaceId: spaceIdSchema,
      source: z.enum(["local", "global", "none"]),
      inheritGlobal: z.boolean(),
      local: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
      global: llmModelRefSchema.nullable(),
      effective: z
        .object({
          provider: z.string(),
          model: z.string(),
          origin: z.enum(["local", "global"]),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      spaceId: spaceIdSchema,
      candidates: z
        .array(
          z
            .object({
              routeId: z.string(),
              displayName: z.string(),
              api: z.string().optional(),
              origin: z.string(),
              modelIds: z.array(z.string()).max(1000),
              credentialCopy: z.enum(["available", "reenter", "unsupported"]),
            })
            .strict(),
        )
        .max(256),
    })
    .strict(),
  z
    .object({
      spaceId: spaceIdSchema,
      schemaVersion: z.literal(1),
      kind: z.literal("dsh-space-llm-requirements"),
      sourceSharedMode: z.enum(["none", "all", "selected"]),
      requirements: z
        .array(
          z
            .object({
              requirementId: z.string(),
              displayName: z.string(),
              protocol: z.string(),
              endpoint: z.string(),
              modelIds: z.array(z.string()).max(1000),
              authKind: z.enum(["api-key", "none"]),
              usedAsDefault: z.boolean(),
            })
            .strict(),
        )
        .max(256),
      defaultRequirementId: z.string().nullable(),
      adapterRequired: z.literal("llm-pi-ai"),
      note: z.string(),
    })
    .strict(),
  z
    .object({
      spaceId: spaceIdSchema,
      mappingRequired: z.boolean(),
      manifest: z
        .object({
          schemaVersion: z.literal(1),
          kind: z.literal("dsh-space-llm-requirements"),
          sourceSharedMode: z.enum(["none", "all", "selected"]),
          requirements: z.array(z.object({
            requirementId: z.string(),
            displayName: z.string(),
            protocol: z.string(),
            endpoint: z.string(),
            modelIds: z.array(z.string()).max(1000),
            authKind: z.enum(["api-key", "none"]),
            usedAsDefault: z.boolean(),
          }).strict()).max(256),
          defaultRequirementId: z.string().nullable(),
          adapterRequired: z.literal("llm-pi-ai"),
          note: z.string(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z.object({ ok: z.literal(true), modelId: z.string(), billed: z.literal(true) }).strict(),
  z
    .object({
      operationId: requestIdSchema,
      status: z.enum(["committed", "not-found", "unknown"]),
      catalogRevision: z.number().int().nonnegative().optional(),
      connectionId: connectionIdSchema.optional(),
      leftoverRecordId: z.string().optional(),
    })
    .strict(),
  workbenchJobSchema,
]);

const llmSecretDraftSchema = z
  .object({
    id: connectionIdSchema.optional(),
    displayName: z.string().min(1).max(80),
    enabled: z.boolean().optional(),
    providerConfig: z.record(z.string(), z.unknown()),
  })
  .strict();

export const llmCredentialRequestSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("saveConnectionWithCredential"),
      draft: llmSecretDraftSchema,
      secret: z.string().min(1).max(16_384),
      expectedRevision: z.number().int().nonnegative(),
      operationId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("discoverModels"),
      draft: llmSecretDraftSchema,
      secret: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      method: z.literal("adoptLocal"),
      spaceId: spaceIdSchema,
      routeId: z.string().min(1).max(200),
      displayName: z.string().min(1).max(80),
      secret: z.string().min(1).max(16_384),
      expectedRevision: z.number().int().nonnegative(),
      operationId: requestIdSchema,
    })
    .strict(),
]);
