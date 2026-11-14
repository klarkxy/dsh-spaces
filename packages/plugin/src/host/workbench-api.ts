/**
 * The wire codecs of the canonical management API.
 *
 * The canonical definition — method names, wire argument names and DTO types —
 * lives in `src/shared/workbench.ts`. This module only adds the Zod codec and
 * the Typert type symbol of every method, parameter and result, so the
 * descriptor table, the Host client and the Client declarations all read one
 * surface.
 */
import { z } from "zod";
import type { WorkbenchApiArgNames, WorkbenchApiMethod } from "../../../../src/shared/workbench";
import {
  backupsResultSchema,
  jobIdSchema,
  mutationContextSchema,
  pluginsQuerySchema,
  requestIdSchema,
  snapshotIdSchema,
  spaceIdSchema,
  workbenchCommandSchema,
  workbenchJobSchema,
  workbenchPlanRequestSchema,
  workbenchPlanSchema,
  workbenchPluginListSchema,
  workbenchProductRequestSchema,
  workbenchProductResultSchema,
  workbenchRuntimeListSchema,
  workbenchSnapshotSchema,
  workbenchSpaceDetailSchema,
  workbenchStartupStatusSchema,
  workbenchStateSchema,
  workbenchViewSchema,
} from "./workbench-schemas";

/** The codec and the descriptor symbol of one wire value. */
export interface WorkbenchApiCodec {
  schema: z.ZodType;
  typeSymbol: string;
}

/**
 * The wire codecs of every management API method.
 *
 * The parameter keys are the canonical wire argument names, so a method cannot
 * be validated, described or invoked under a different argument name.
 */
export const WORKBENCH_API_CODECS: {
  [K in WorkbenchApiMethod]: {
    params: { [P in WorkbenchApiArgNames<K>]: WorkbenchApiCodec };
    result: WorkbenchApiCodec;
  };
} = {
  state: {
    params: {},
    result: { schema: workbenchStateSchema, typeSymbol: "dsh-spaces/types#WorkbenchState" },
  },
  startupStatus: {
    params: {},
    result: { schema: workbenchStartupStatusSchema, typeSymbol: "dsh-spaces/types#WorkbenchStartupStatus" },
  },
  detail: {
    params: {
      spaceId: { schema: spaceIdSchema, typeSymbol: "dsh-spaces#workbench/detail:spaceId" },
    },
    result: { schema: workbenchSpaceDetailSchema, typeSymbol: "dsh-spaces/types#SpaceDetail" },
  },
  submit: {
    params: {
      command: { schema: workbenchCommandSchema, typeSymbol: "dsh-spaces/types#WorkbenchCommand" },
      requestId: { schema: requestIdSchema, typeSymbol: "dsh-spaces#workbench/submit:requestId" },
      context: { schema: mutationContextSchema, typeSymbol: "dsh-spaces/types#WorkbenchMutationContext" },
    },
    result: { schema: workbenchJobSchema, typeSymbol: "dsh-spaces/types#WorkbenchJob" },
  },
  job: {
    params: {
      id: { schema: jobIdSchema, typeSymbol: "dsh-spaces#workbench/job:id" },
    },
    result: { schema: workbenchJobSchema, typeSymbol: "dsh-spaces/types#WorkbenchJob" },
  },
  cancel: {
    params: {
      id: { schema: jobIdSchema, typeSymbol: "dsh-spaces#workbench/cancel:id" },
    },
    result: { schema: workbenchJobSchema, typeSymbol: "dsh-spaces/types#WorkbenchJob" },
  },
  view: {
    params: {
      spaceId: { schema: spaceIdSchema, typeSymbol: "dsh-spaces#workbench/view:spaceId" },
    },
    result: { schema: workbenchViewSchema, typeSymbol: "dsh-spaces/types#WorkbenchView" },
  },
  preview: {
    params: {
      request: { schema: workbenchPlanRequestSchema, typeSymbol: "dsh-spaces/types#WorkbenchPlanRequest" },
      context: { schema: mutationContextSchema, typeSymbol: "dsh-spaces/types#WorkbenchMutationContext" },
    },
    result: { schema: workbenchPlanSchema, typeSymbol: "dsh-spaces/types#WorkbenchPlan" },
  },
  product: {
    params: {
      request: { schema: workbenchProductRequestSchema, typeSymbol: "dsh-spaces/types#WorkbenchProductRequest" },
    },
    result: { schema: workbenchProductResultSchema, typeSymbol: "dsh-spaces/types#WorkbenchProductResult" },
  },
  plugins: {
    params: {
      query: { schema: pluginsQuerySchema, typeSymbol: "dsh-spaces#workbench/plugins:query" },
    },
    result: { schema: workbenchPluginListSchema, typeSymbol: "dsh-spaces/types#WorkbenchPlugin[]" },
  },
  snapshots: {
    params: {},
    result: { schema: workbenchSnapshotSchema.array(), typeSymbol: "dsh-spaces/types#WorkbenchSnapshot[]" },
  },
  snapshot: {
    params: {
      id: { schema: snapshotIdSchema, typeSymbol: "dsh-spaces#workbench/snapshot:id" },
    },
    result: { schema: workbenchSnapshotSchema, typeSymbol: "dsh-spaces/types#WorkbenchSnapshot" },
  },
  runtimes: {
    params: {},
    result: { schema: workbenchRuntimeListSchema, typeSymbol: "dsh-spaces/types#WorkbenchRuntime[]" },
  },
  backups: {
    params: {
      spaceId: { schema: spaceIdSchema, typeSymbol: "dsh-spaces#workbench/backups:spaceId" },
    },
    result: { schema: backupsResultSchema, typeSymbol: "dsh-spaces/types#WorkbenchBackup[]" },
  },
};
