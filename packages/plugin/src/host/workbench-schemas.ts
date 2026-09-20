import { z } from "zod";
import { SNAPSHOT_ID_RE } from "../../../../src/shared/snapshots";
import { isExactRuntimeVersion } from "../../../../src/shared/runtime";
import { MAX_SPACE_ICON_DATA_URL_CHARS } from "../../../../src/shared/space-icon";
import { parseLoopbackOrigin, parseRelativeEntryPath } from "./loopback";

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
  })
  .strict();

export const workbenchJobSchema = z
  .object({
    id: jobIdSchema,
    requestId: requestIdSchema,
    kind: z.string().min(1).max(64),
    status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "recovery-required"]),
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
    recoveryRequired: z.boolean(),
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
  })
  .strict();

export const workbenchCommandSchema = z.discriminatedUnion("kind", [
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
  z.object({ kind: z.literal("controller.acquire") }).strict(),
  z.object({ kind: z.literal("recovery.resume") }).strict(),
]);

export const workbenchPlanRequestSchema = z.discriminatedUnion("kind", [
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
  z.object({ kind: z.literal("snapshot.restore"), snapshotId: snapshotIdSchema }).strict(),
  z.object({ kind: z.literal("snapshot.delete"), snapshotId: snapshotIdSchema }).strict(),
  z.object({ kind: z.literal("config.restore"), spaceId: spaceIdSchema, backupId: jobIdSchema }).strict(),
  z.object({ kind: z.literal("runtime.install"), version: exactVersionSchema }).strict(),
  z.object({ kind: z.literal("runtime.upgrade"), version: exactVersionSchema }).strict(),
  z.object({ kind: z.literal("workbench.upgrade"), catalogId: z.literal("bundled-workbench"), version: exactVersionSchema }).strict(),
  z.object({ kind: z.literal("controller.release") }).strict(),
  z.object({ kind: z.literal("controller.shutdown") }).strict(),
]);

export const workbenchPlanSchema = z
  .object({
    id: planIdSchema,
    kind: z.enum([
      "space.stop",
      "space.restart",
      "space.delete",
      "plugin.install",
      "plugin.remove",
      "plugin.toggle",
      "plugin.cleanup-manager",
      "snapshot.create",
      "snapshot.restore",
      "snapshot.delete",
      "config.restore",
      "runtime.install",
      "runtime.upgrade",
      "workbench.upgrade",
      "controller.release",
      "controller.shutdown",
    ]),
    title: z.string().max(200),
    scope: z.enum(["space", "home", "controller"]),
    affectedSpaceIds: z.array(spaceIdSchema).max(256),
    runningSpaceIds: z.array(spaceIdSchema).max(256),
    changes: z.array(z.string().max(500)).max(64),
    destructive: z.boolean(),
    expiresAt: isoDateSchema,
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
    recoveryRequired: z.boolean(),
    reasons: reasonsSchema,
  })
  .strict();

export const workbenchBootstrapResultSchema = z
  .object({
    ok: z.boolean(),
    connected: z.boolean(),
    recoveryRequired: z.boolean(),
    origin: z.union([loopbackOrigin, z.null()]),
    reasons: reasonsSchema,
  })
  .strict();

export const workbenchReturnTargetSchema = z
  .object({
    available: z.boolean(),
    origin: z.union([loopbackOrigin, z.null()]),
    path: z.union([entryPathSchema, z.null()]),
    recoveryRequired: z.boolean(),
    reasons: reasonsSchema,
  })
  .strict();

export const workbenchHostHintSchema = z
  .object({
    role: workbenchRoleSchema,
    recoveryRequired: z.boolean(),
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
