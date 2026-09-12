/* Host FaceModel descriptors for the spaces Remote. */
import { z } from "zod";

const spaceIdSchema = z.string();

const createInputSchema = z
  .object({
    name: z.string(),
    displayName: z.string().optional(),
  })
  .strict();

const capabilitiesSchema = z
  .object({
    mode: z.enum(["verified-full", "verified-limited", "unknown-readonly", "recovery-only"]),
    hostSpaceId: z.union([z.string(), z.null()]),
    dshVersion: z.union([z.string(), z.null()]),
    canCreate: z.boolean(),
    canVerify: z.boolean(),
    reasons: z.array(z.string()),
  })
  .strict();

const spaceSummarySchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    isHost: z.boolean(),
    hasWebApp: z.boolean(),
    status: z.enum(["running", "stopped", "unknown"]),
    isolation: z.enum(["verified", "unverified", "invalid", "default"]),
  })
  .strict();

const overviewSchema = z
  .object({
    capabilities: capabilitiesSchema,
    spaces: z.array(spaceSummarySchema),
  })
  .strict();

const detailSchema = z
  .object({
    space: spaceSummarySchema,
    plugins: z.array(
      z
        .object({
          name: z.string(),
          version: z.union([z.string(), z.null()]),
        })
        .strict(),
    ),
    snapshots: z.array(
      z
        .object({
          id: z.string(),
          createdAt: z.string(),
          runtimeVersion: z.union([z.string(), z.null()]),
        })
        .strict(),
    ),
    diagnostics: z.array(
      z
        .object({
          level: z.enum(["info", "warning", "error"]),
          code: z.string(),
          message: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const verifyResultSchema = z
  .object({
    id: z.string(),
    valid: z.boolean(),
    message: z.string(),
  })
  .strict();

export const TYPERT = {
  package: "@dsh-spaces/plugin",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "@dsh-spaces/plugin#spaces/overview",
      service: "spaces",
      namespace: "spaces",
      method: "overview",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-spaces/plugin/types#SpacesOverview",
        schema: overviewSchema,
      },
      sourceLocation: { file: "packages/plugin/src/host/spaces-service.ts", line: 1, column: 1 },
    },
    {
      id: "@dsh-spaces/plugin#spaces/detail",
      service: "spaces",
      namespace: "spaces",
      method: "detail",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "id",
          wire: "id",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "@dsh-spaces/plugin#spaces/detail:id",
            schema: spaceIdSchema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-spaces/plugin/types#SpaceDetail",
        schema: detailSchema,
      },
      sourceLocation: { file: "packages/plugin/src/host/spaces-service.ts", line: 1, column: 1 },
    },
    {
      id: "@dsh-spaces/plugin#spaces/create",
      service: "spaces",
      namespace: "spaces",
      method: "create",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "input",
          wire: "input",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "@dsh-spaces/plugin/types#CreateSpaceInput",
            schema: createInputSchema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-spaces/plugin/types#SpaceSummary",
        schema: spaceSummarySchema,
      },
      sourceLocation: { file: "packages/plugin/src/host/spaces-service.ts", line: 1, column: 1 },
    },
    {
      id: "@dsh-spaces/plugin#spaces/verify",
      service: "spaces",
      namespace: "spaces",
      method: "verify",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "id",
          wire: "id",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "@dsh-spaces/plugin#spaces/verify:id",
            schema: spaceIdSchema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-spaces/plugin/types#VerifySpaceResult",
        schema: verifyResultSchema,
      },
      sourceLocation: { file: "packages/plugin/src/host/spaces-service.ts", line: 1, column: 1 },
    },
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
};

export {
  createInputSchema,
  detailSchema,
  overviewSchema,
  spaceIdSchema,
  spaceSummarySchema,
  verifyResultSchema,
};
