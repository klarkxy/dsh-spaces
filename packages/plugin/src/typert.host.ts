/* Host FaceModel descriptors for guide, manager, and compatibility-read Remotes. */
import { z } from "zod";
import { parseSpaceHostAudience, parsePortalSnapshot } from "../../../src/shared/space-host";
import { validDesktopSpaceAction } from "./types";
import { WORKBENCH_API, WORKBENCH_API_METHODS, type WorkbenchApiMethod } from "../../../src/shared/workbench";
import { WORKBENCH_API_CODECS } from "./host/workbench-api";
import {
  overviewSchema,
  spaceIdSchema,
  desktopLaunchStateSchema,
  workbenchBootstrapResultSchema,
  serviceRestartPreviewSchema,
  workbenchGuideRoleSchema,
  workbenchInitializeResultSchema,
  workbenchReturnTargetSchema,
  workbenchSpaceDetailSchema,
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
      create: () => schema,
    },
  };
}

function result(typeSymbol: string, schema: z.ZodType) {
  return {
    mode: "strict" as const,
    typeSymbol,
    create: () => schema,
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

/**
 * One descriptor row per canonical management method.
 *
 * The method name, the wire argument names and their order come from the
 * canonical definition; only the codec and the type symbol are added here.
 */
function workbenchInvocation(method: WorkbenchApiMethod) {
  const spec: { args: readonly { name: string }[] } = WORKBENCH_API[method];
  const codecs: {
    params: Record<string, { schema: z.ZodType; typeSymbol: string }>;
    result: { schema: z.ZodType; typeSymbol: string };
  } = WORKBENCH_API_CODECS[method];
  return invocation(
    "workbench",
    method,
    managerFile,
    spec.args.map((arg) => {
      const codec = codecs.params[arg.name];
      return param(arg.name, codec.schema, codec.typeSymbol);
    }),
    result(codecs.result.typeSymbol, codecs.result.schema),
  );
}

const workbenchInvocations = WORKBENCH_API_METHODS.map(workbenchInvocation);

export const TYPERT = {
  package: "@dsh-spaces/plugin",
  face: "host",
  schemas: [],
  invocations: [
    invocation("workbenchGuide", "role", guideFile, [], result("@dsh-spaces/plugin/types#WorkbenchGuideRole", workbenchGuideRoleSchema)),
    invocation("workbenchGuide", "presentationSnapshot", guideFile, [], result("@dsh-spaces/plugin#PortalSnapshot", z.unknown().refine(value => parsePortalSnapshot(value) !== null))),
    invocation("workbenchGuide", "spaceActivity", guideFile, [param("spaceId", spaceIdSchema, "string"), param("serviceEpoch", z.string().regex(/^[a-f0-9]{64}$/), "string")], result("@dsh-spaces/plugin#SpaceActivity", z.object({ activity: z.enum(["idle", "busy", "unknown"]), generation: z.number().int().nonnegative() }).strict())),
    invocation("workbenchGuide", "spaceAction", guideFile, [param("request", z.unknown().refine(validDesktopSpaceAction), "@dsh-spaces/plugin/types#DesktopSpaceAction")], result("@dsh-spaces/plugin#PortalSnapshot", z.unknown().refine(value => parsePortalSnapshot(value) !== null))),
    invocation("workbenchGuide", "bootstrap", guideFile, [], result("@dsh-spaces/plugin/types#WorkbenchBootstrapResult", workbenchBootstrapResultSchema)),
    invocation("workbenchGuide", "returnTarget", guideFile, [], result("@dsh-spaces/plugin/types#WorkbenchReturnTarget", workbenchReturnTargetSchema)),
    invocation("workbenchGuide", "portalTarget", guideFile, [param("audience", z.object({ parentOrigin: z.string().max(128), channel: z.string().regex(/^[a-f0-9]{32}$/) }).strict().refine(value => parseSpaceHostAudience(value) !== null), "@dsh-spaces/plugin#SpaceHostAudience")], result("@dsh-spaces/plugin/types#WorkbenchReturnTarget", workbenchReturnTargetSchema)),
    invocation("workbenchGuide", "initialize", guideFile, [], result("@dsh-spaces/plugin/types#WorkbenchInitializeResult", workbenchInitializeResultSchema)),
    invocation("workbenchGuide", "previewServiceRestart", guideFile, [], result("@dsh-spaces/plugin/types#WorkbenchServiceRestartPreview", serviceRestartPreviewSchema)),
    invocation("workbenchGuide", "previewServiceStop", guideFile, [], result("@dsh-spaces/plugin/types#WorkbenchServiceRestartPreview", serviceRestartPreviewSchema)),
    invocation("workbenchGuide", "stopService", guideFile, [param("confirmationId", z.string().regex(/^[a-f0-9]{64}$/), "string")], result("@dsh-spaces/plugin/types#WorkbenchBootstrapResult", workbenchBootstrapResultSchema)),
    invocation("workbenchGuide", "restartService", guideFile, [param("confirmationId", z.string().regex(/^[a-f0-9]{64}$/), "string")], result("@dsh-spaces/plugin/types#WorkbenchBootstrapResult", workbenchBootstrapResultSchema)),
    invocation("workbenchGuide", "beginDesktopLaunch", guideFile, [], result("@dsh-spaces/plugin/types#DesktopLaunchState", desktopLaunchStateSchema)),
    invocation("workbenchGuide", "desktopLaunchState", guideFile, [], result("@dsh-spaces/plugin/types#DesktopLaunchState", desktopLaunchStateSchema)),
    invocation("spaces", "overview", spacesFile, [], result("@dsh-spaces/plugin/types#SpacesOverview", overviewSchema)),
    invocation(
      "spaces",
      "detail",
      spacesFile,
      [param("id", spaceIdSchema, "@dsh-spaces/plugin#spaces/detail:id")],
      result("@dsh-spaces/plugin/types#SpaceDetail", workbenchSpaceDetailSchema),
    ),
    ...workbenchInvocations,
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
};
