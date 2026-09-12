import type { RemoteResult, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";
import type {
  CreateSpaceInput,
  SpaceDetail,
  SpaceSummary,
  SpacesOverview,
  VerifySpaceResult,
} from "../../../src/shared/spaces-control";
import {
  TYPERT,
  createInputSchema,
  detailSchema,
  overviewSchema,
  spaceIdSchema,
  spaceSummarySchema,
  verifyResultSchema,
} from "./typert.host";
import "./host/remote-errors";

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespace$spaces {
    overview: () => Promise<RemoteResult<SpacesOverview>>;
    detail: (id: string) => Promise<RemoteResult<SpaceDetail>>;
    create: (input: CreateSpaceInput) => Promise<RemoteResult<SpaceSummary>>;
    verify: (id: string) => Promise<RemoteResult<VerifySpaceResult>>;
  }
  interface TypertRemoteMap {
    "spaces/overview": () => Promise<RemoteResult<SpacesOverview>>;
    "spaces/detail": (id: string) => Promise<RemoteResult<SpaceDetail>>;
    "spaces/create": (input: CreateSpaceInput) => Promise<RemoteResult<SpaceSummary>>;
    "spaces/verify": (id: string) => Promise<RemoteResult<VerifySpaceResult>>;
  }
  interface TypertRemoteNamespaceMap {
    spaces: TypertRemoteNamespace$spaces;
  }
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: "@dsh-spaces/plugin",
  descriptors: [
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
      sourceLocation: TYPERT.invocations[0].sourceLocation,
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
      sourceLocation: TYPERT.invocations[1].sourceLocation,
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
      sourceLocation: TYPERT.invocations[2].sourceLocation,
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
      sourceLocation: TYPERT.invocations[3].sourceLocation,
    },
  ],
};

export default TYPERT_REMOTE;
