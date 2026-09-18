import { createHomeLlmHost } from "../adapters/node/llm-host";
import { MapLlmInstanceStatus } from "../adapters/node/llm-host";
import type { LlmInstanceRecord } from "../core/ports/llm-runtime";
import { isLlmWriteMethod } from "../shared/llm-api";
import type { LlmApiRequest, LlmApiResult, LlmCredentialRequest } from "../shared/llm-api";
import type { WorkbenchJob } from "../shared/workbench";

export type DesktopLlmPorts = {
  listSpaceIds(): string[];
  statusOf(spaceId: string): LlmInstanceRecord["status"];
  generationOf(spaceId: string): number;
  restart(spaceId: string): Promise<void>;
  assertWritable(): void;
};

export function createDesktopLlmHost(home: string, ports: DesktopLlmPorts) {
  const rows = new Map<string, LlmInstanceRecord>();
  const instances = new MapLlmInstanceStatus(rows);
  const sync = (): void => {
    for (const spaceId of ports.listSpaceIds()) {
      const current = rows.get(spaceId);
      rows.set(spaceId, {
        spaceId,
        status: ports.statusOf(spaceId),
        generation: ports.generationOf(spaceId),
        catalogRevision: current?.catalogRevision ?? null,
        policyRevision: current?.policyRevision ?? null,
        busy: ports.statusOf(spaceId) === "starting" || ports.statusOf(spaceId) === "stopping",
      });
    }
  };
  let host: ReturnType<typeof createHomeLlmHost>;
  host = createHomeLlmHost(home, {
    listSpaceIds: async () => ports.listSpaceIds(),
    instances,
    assertWritable: () => ports.assertWritable(),
    submitApply: async (command, requestId): Promise<WorkbenchJob> => {
      await host.executeApply(command, (spaceId) => ports.restart(spaceId));
      return {
        id: requestId,
        requestId,
        kind: "llm.apply",
        status: "succeeded",
        phase: "succeeded",
        message: "",
        affectedSpaceIds: command.spaceIds,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        canCancel: false,
      };
    },
  });
  return {
    async llm(request: LlmApiRequest): Promise<LlmApiResult> {
      sync();
      if (isLlmWriteMethod(request.method)) ports.assertWritable();
      return host.dispatch(request) as Promise<LlmApiResult>;
    },
    async llmCredential(request: LlmCredentialRequest): Promise<LlmApiResult> {
      sync();
      ports.assertWritable();
      return host.dispatchCredential(request) as Promise<LlmApiResult>;
    },
  };
}
