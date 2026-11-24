import { z } from "zod";
import { SNAPSHOT_ID_RE } from "../../../../src/shared/snapshots";
import { SPACE_NAME_RE } from "../../../../src/shared/types";
import { isExactRuntimeVersion } from "../../../../src/shared/runtime";
import { MAX_SPACE_ICON_DATA_URL_CHARS } from "../../../../src/shared/space-icon";
import {
  workbenchMutationContextSchema,
  workbenchProductCommandSchema,
  workbenchProductOutcomeSchema,
  workbenchProductRequestSchema,
  workbenchProductResultSchema,
} from "../../../../src/shared/workbench-product-schemas";
import { parseLoopbackOrigin, parseRelativeEntryPath } from "../../../../src/shared/loopback";
import { validClientFailureReport } from "../types";

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

export const spaceNameSchema = z.string().regex(SPACE_NAME_RE, "invalid space name");

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

export const serviceRestartPreviewSchema = z.object({
  confirmationId: hex64Schema,
  expiresAt: isoDateSchema,
  action: z.enum(["start", "restart", "stop"]),
  spaces: z.array(z.object({ id: spaceIdSchema, displayName: z.string().max(500), running: z.boolean() }).strict()).max(1000),
}).strict();

export const workbenchRoleSchema = z.enum(["manager", "workspace", "uninitialized"]);

export const workbenchSpaceSchema = z
  .object({
    id: spaceIdSchema,
    displayName: z.string(),
    isHost: z.boolean(),
    hasWebApp: z.boolean(),
    icon: z.string(),
    startWithDesktop: z.boolean().default(false),
    status: z.enum(["running", "starting", "stopping", "stopped", "crashed", "unknown"]),
    generation: z.number().int(),
    managed: z.boolean(),
    dshVersion: exactVersionSchema.nullable(),
    base: z.enum(["web", "browser"]).optional(),
    baseVersion: exactVersionSchema.optional(),
    attention: z.enum(["required", "none", "unknown"]).optional(),
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
    dshVersion: exactVersionSchema.optional(),
    view: workbenchViewSchema.optional(),
    product: workbenchProductOutcomeSchema.optional(),
    pluginApplication: z.enum(["applied", "restart-required"]).optional(),
    restartRequiredSpaceIds: z.array(spaceIdSchema).max(256).optional(),
    steps: z
      .array(
        z
          .object({
            step: z.string().trim().min(1).max(40),
            status: z.enum(["done", "failed", "not-run"]),
            packageName: z.string().max(214).optional(),
            detail: z.string().max(300).optional(),
          })
          .strict(),
      )
      .max(256)
      .optional(),
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
    subject: z
      .object({
        displayName: z.string().min(1).max(200),
        icon: z.string().max(MAX_SPACE_ICON_DATA_URL_CHARS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Empty before ownership; otherwise the same 64-hex epoch as currentServiceEpoch. */
const startupServiceEpochSchema = z.string().regex(/^(?:[a-f0-9]{64})?$/);

export const workbenchStartupFailureSchema = z
  .object({
    stage: z.string().max(64),
    primaryReason: z.string().max(220),
    cleanupReason: z.string().max(220).optional(),
    instanceRetained: z.boolean(),
  })
  .strict();

export const workbenchStartupStatusSchema = z
  .object({
    serviceEpoch: startupServiceEpochSchema,
    managerId: z.union([spaceIdSchema, z.null()]),
    phase: z.enum(["preparing", "starting", "ready", "failed"]),
    reasons: reasonsSchema,
    failure: z.union([workbenchStartupFailureSchema, z.null()]),
  })
  .strict();

export const desktopLaunchPhaseSchema = z.enum([
  "idle",
  "discovering",
  "preparing",
  "launching",
  "starting",
  "connecting",
  "ready",
  "failed",
  "stopped",
]);

/** Public Desktop launch snapshot. Every field is required; secrets and paths are not members. */
export const desktopLaunchStateSchema = z
  .object({
    operationId: z.union([z.string().min(1).max(80), z.null()]),
    phase: desktopLaunchPhaseSchema,
    serviceEpoch: z.union([hex64Schema, z.null()]),
    managerId: z.union([spaceIdSchema, z.null()]),
    reasons: reasonsSchema,
    failure: z.union([workbenchStartupFailureSchema, z.null()]),
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
  })
  .strict();

export const spaceModelConfigSchema = z.object({
  status: z.enum(["configured", "incomplete", "unconfigured"]),
  routeNames: z.array(z.string().max(200)).max(256),
  defaultModel: z.string().max(500).nullable(),
  missingCredentials: z.array(z.string().max(200)).max(256),
}).strict();

export const workbenchSpaceDetailSchema = z
  .object({
    space: spaceSummarySchema,
    models: spaceModelConfigSchema,
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
    name: spaceNameSchema,
    displayName: displayNameSchema.optional(),
    icon: iconSchema.optional(),
    modelSource: z.enum(['main','local']).optional(),
    browser: z.boolean().optional(),
    base: z.enum(["web", "browser"]).optional(),
    baseVersion: exactVersionSchema.optional(),
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
      startWithDesktop: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("space.reorder"), spaceIds: z.array(spaceIdSchema).min(1).max(256) }).strict(),
  z.object({ kind: z.literal("space.start"), spaceId: spaceIdSchema }).strict(),
  z.object({ kind: z.literal("plan.execute"), planId: planIdSchema }).strict(),
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
  z.object({ kind: z.literal("space.runtime.set"), spaceId: spaceIdSchema, version: exactVersionSchema }).strict(),
  z.object({ kind: z.literal("runtime.remove"), version: exactVersionSchema }).strict(),
  z.object({ kind: z.literal("service.shutdown") }).strict(),
]);

export const workbenchCommandSchema = z.union([coreWorkbenchCommandSchema, workbenchProductCommandSchema]);

export const workbenchPlanRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("space.stop"), spaceId: spaceIdSchema }).strict(),
  z.object({ kind: z.literal("space.restart"), spaceId: spaceIdSchema }).strict(),
  z.object({ kind: z.literal("space.delete"), spaceId: spaceIdSchema, removeData: z.boolean() }).strict(),
  z.object({ kind: z.literal("space.models.sync"), spaceId: spaceIdSchema }).strict(),
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
  z.object({ kind: z.literal("space.runtime.set"), spaceId: spaceIdSchema, version: exactVersionSchema }).strict(),
  z.object({ kind: z.literal("runtime.remove"), version: exactVersionSchema }).strict(),
  z.object({ kind: z.literal("service.shutdown") }).strict(),
]);

export const modelSyncSummarySchema = z.object({
  mainProfile: spaceIdSchema,
  routes: z.array(z.string().max(200)).max(256),
  deepseek: z.boolean(),
  defaultModel: z.string().max(500).optional(),
  defaultModelSkipped: z.string().max(200).optional(),
  credentials: z.array(z.string().max(200)).max(256),
  skipped: z.array(z.object({
    route: z.string().max(200),
    reason: z.enum(["login-grant", "expression", "unsupported"]),
  }).strict()).max(256),
  missingCredentials: z.array(z.string().max(200)).max(256),
}).strict();

export const workbenchPlanSchema = z
  .object({
    modelsSync: modelSyncSummarySchema.optional(),
    taskActivity: z.enum(["idle", "busy", "unknown"]).optional(),
    id: planIdSchema,
    kind: z.enum([
      "space.stop",
      "space.restart",
      "space.delete",
      "space.models.sync",
      "plugin.install",
      "plugin.remove",
      "plugin.toggle",
      "plugin.cleanup-manager",
      "snapshot.create",
      "snapshot.delete",
      "space.runtime.set",
      "runtime.remove",
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
    host: z.boolean(),
    pinnedBy: z.array(spaceIdSchema).max(256),
    removable: z.boolean(),
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
    reasons: z.array(z.string()),
  })
  .strict();

export const overviewSchema = z
  .object({
    capabilities: capabilitiesSchema,
    spaces: z.array(spaceSummarySchema),
  })
  .strict();

export const clientFailureReportSchema = z.unknown().refine(validClientFailureReport, "invalid client failure report");

export const clientFailureRecordedSchema = z
  .object({
    recorded: z.boolean(),
  })
  .strict();

