/* Host FaceModel descriptors for guide, manager, and compatibility-read Remotes. */
import { z } from "zod";
import {
  backupsResultSchema,
  jobIdSchema,
  overviewSchema,
  pluginsQuerySchema,
  requestIdSchema,
  snapshotIdSchema,
  spaceIdSchema,
  workbenchBootstrapResultSchema,
  workbenchCommandSchema,
  workbenchGuideRoleSchema,
  workbenchInitializeResultSchema,
  workbenchJobSchema,
  workbenchPlanRequestSchema,
  workbenchPlanSchema,
  workbenchPluginListSchema,
  workbenchReturnTargetSchema,
  workbenchRuntimeListSchema,
  workbenchPackageResultSchema,
  workbenchSnapshotSchema,
  workbenchSpaceDetailSchema,
  workbenchStateSchema,
  workbenchViewSchema,
  llmApiRequestSchema,
  llmApiResultSchema,
  llmCredentialRequestSchema,
} from "./host/workbench-schemas";

export {
  backupsResultSchema,
  jobIdSchema,
  overviewSchema,
  pluginsQuerySchema,
  requestIdSchema,
  snapshotIdSchema,
  spaceIdSchema,
  spaceSummarySchema,
  workbenchBootstrapResultSchema,
  workbenchCommandSchema,
  workbenchGuideRoleSchema,
  workbenchInitializeResultSchema,
  workbenchJobSchema,
  workbenchPlanRequestSchema,
  workbenchPlanSchema,
  workbenchPluginListSchema,
  workbenchReturnTargetSchema,
  workbenchRuntimeListSchema,
  workbenchSnapshotSchema,
  workbenchSpaceDetailSchema,
  workbenchStateSchema,
  workbenchViewSchema,
} from "./host/workbench-schemas";

const source = (file: string) => ({ file, line: 1, column: 1 });

function param(name: string, schema: z.ZodType, typeSymbol: string) {
  return {
    name,
    wire: name,
    source: "json" as const,
    codec: {
      mode: "strict" as const,
      typeSymbol,
      schema,
    },
  };
}

function result(typeSymbol: string, schema: z.ZodType) {
  return {
    mode: "strict" as const,
    typeSymbol,
    schema,
  };
}

function invocation(
  service: string,
  method: string,
  file: string,
  parameters: ReturnType<typeof param>[],
  resultSpec: ReturnType<typeof result>,
) {
  return {
    id: `@dsh-spaces/plugin#${service}/${method}`,
    service,
    namespace: service,
    method,
    invocation: { kind: "direct" as const },
    parameters,
    result: resultSpec,
    sourceLocation: source(file),
  };
}

const guideFile = "packages/plugin/src/host/workbench-guide.ts";
const managerFile = "packages/plugin/src/host/workbench-manager.ts";
const spacesFile = "packages/plugin/src/host/spaces-service.ts";

export const TYPERT = {
  package: "@dsh-spaces/plugin",
  face: "host",
  schemas: [],
  invocations: [
    invocation("workbenchGuide", "role", guideFile, [], result("@dsh-spaces/plugin/types#WorkbenchGuideRole", workbenchGuideRoleSchema)),
    invocation("workbenchGuide", "bootstrap", guideFile, [], result("@dsh-spaces/plugin/types#WorkbenchBootstrapResult", workbenchBootstrapResultSchema)),
    invocation("workbenchGuide", "returnTarget", guideFile, [], result("@dsh-spaces/plugin/types#WorkbenchReturnTarget", workbenchReturnTargetSchema)),
    invocation("workbenchGuide", "initialize", guideFile, [], result("@dsh-spaces/plugin/types#WorkbenchInitializeResult", workbenchInitializeResultSchema)),
    invocation("spaces", "overview", spacesFile, [], result("@dsh-spaces/plugin/types#SpacesOverview", overviewSchema)),
    invocation(
      "spaces",
      "detail",
      spacesFile,
      [param("id", spaceIdSchema, "@dsh-spaces/plugin#spaces/detail:id")],
      result("@dsh-spaces/plugin/types#SpaceDetail", workbenchSpaceDetailSchema),
    ),
    invocation("workbench", "state", managerFile, [], result("@dsh-spaces/plugin/types#WorkbenchState", workbenchStateSchema)),
    invocation(
      "workbench",
      "detail",
      managerFile,
      [param("spaceId", spaceIdSchema, "@dsh-spaces/plugin#workbench/detail:spaceId")],
      result("@dsh-spaces/plugin/types#SpaceDetail", workbenchSpaceDetailSchema),
    ),
    invocation(
      "workbench",
      "submit",
      managerFile,
      [
        param("command", workbenchCommandSchema, "@dsh-spaces/plugin/types#WorkbenchCommand"),
        param("requestId", requestIdSchema, "@dsh-spaces/plugin#workbench/submit:requestId"),
      ],
      result("@dsh-spaces/plugin/types#WorkbenchJob", workbenchJobSchema),
    ),
    invocation(
      "workbench",
      "job",
      managerFile,
      [param("id", jobIdSchema, "@dsh-spaces/plugin#workbench/job:id")],
      result("@dsh-spaces/plugin/types#WorkbenchJob", workbenchJobSchema),
    ),
    invocation(
      "workbench",
      "cancel",
      managerFile,
      [param("id", jobIdSchema, "@dsh-spaces/plugin#workbench/cancel:id")],
      result("@dsh-spaces/plugin/types#WorkbenchJob", workbenchJobSchema),
    ),
    invocation(
      "workbench",
      "view",
      managerFile,
      [param("spaceId", spaceIdSchema, "@dsh-spaces/plugin#workbench/view:spaceId")],
      result("@dsh-spaces/plugin/types#WorkbenchView", workbenchViewSchema),
    ),
    invocation(
      "workbench",
      "preview",
      managerFile,
      [param("request", workbenchPlanRequestSchema, "@dsh-spaces/plugin/types#WorkbenchPlanRequest")],
      result("@dsh-spaces/plugin/types#WorkbenchPlan", workbenchPlanSchema),
    ),
    invocation(
      "workbench",
      "plugins",
      managerFile,
      [param("query", pluginsQuerySchema, "@dsh-spaces/plugin#workbench/plugins:query")],
      result("@dsh-spaces/plugin/types#WorkbenchPlugin[]", workbenchPluginListSchema),
    ),
    invocation("workbench", "snapshots", managerFile, [], result("@dsh-spaces/plugin/types#WorkbenchSnapshot[]", workbenchSnapshotSchema.array())),
    invocation(
      "workbench",
      "snapshot",
      managerFile,
      [param("id", snapshotIdSchema, "@dsh-spaces/plugin#workbench/snapshot:id")],
      result("@dsh-spaces/plugin/types#WorkbenchSnapshot", workbenchSnapshotSchema),
    ),
    invocation("workbench", "runtimes", managerFile, [], result("@dsh-spaces/plugin/types#WorkbenchRuntime[]", workbenchRuntimeListSchema)),
    invocation("workbench", "workbenchPackage", managerFile, [], result("@dsh-spaces/plugin/types#WorkbenchPackageRelease | null", workbenchPackageResultSchema)),
    invocation(
      "workbench",
      "backups",
      managerFile,
      [param("spaceId", spaceIdSchema, "@dsh-spaces/plugin#workbench/backups:spaceId")],
      result("@dsh-spaces/plugin/types#WorkbenchBackup[]", backupsResultSchema),
    ),
    invocation(
      "workbench",
      "llm",
      managerFile,
      [param("request", llmApiRequestSchema, "@dsh-spaces/plugin/types#LlmApiRequest")],
      result("@dsh-spaces/plugin/types#LlmApiResult", llmApiResultSchema),
    ),
    invocation(
      "workbench",
      "llmCredential",
      managerFile,
      [param("request", llmCredentialRequestSchema, "@dsh-spaces/plugin/types#LlmCredentialRequest")],
      result("@dsh-spaces/plugin/types#LlmApiResult", llmApiResultSchema),
    ),
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
};

export const GUIDE_METHODS = ["role", "bootstrap", "returnTarget", "initialize"] as const;
export const MANAGER_METHODS = [
  "state",
  "detail",
  "submit",
  "job",
  "cancel",
  "view",
  "preview",
  "plugins",
  "snapshots",
  "snapshot",
  "runtimes",
  "workbenchPackage",
  "backups",
  "llm",
  "llmCredential",
] as const;
export const SPACES_READ_METHODS = ["overview", "detail"] as const;
