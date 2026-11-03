import { isExactRuntimeVersion } from "../../../../shared/runtime";
import type { WorkbenchCommand } from "../../../../shared/workbench";
import { isWorkbenchProductCommand } from "../../../../shared/workbench-product";
import { parseWorkbenchProductCommand } from "../../../../shared/workbench-product-schemas";
import { WorkbenchJobError } from "./contract";
import { ENTITY_ID_RE, isPlainObject, parseStringArray } from "./util";

const SECRET_COMMAND_KEYS = new Set(["key", "apiKey", "secret", "credential", "token", "authorization"]);

export function parseCommand(input: unknown): WorkbenchCommand {
  if (!isPlainObject(input)) throw new WorkbenchJobError("workbench/invalid-input");
  assertCommandHasNoSecrets(input);
  const kind = input.kind;
  switch (kind) {
    case "space.create": {
      expectKeys(input, ["kind", "input"]);
      return { kind, input: parseCreateInput(input.input) };
    }
    case "space.update": {
      expectKeys(input, ["kind", "spaceId"], ["displayName", "icon"]);
      return {
        kind,
        spaceId: parseEntityId(input.spaceId),
        ...(input.displayName !== undefined ? { displayName: parseOptionalString(input.displayName) } : {}),
        ...(input.icon !== undefined ? { icon: parseOptionalString(input.icon) } : {}),
      };
    }
    case "space.reorder": {
      expectKeys(input, ["kind", "spaceIds"]);
      const spaceIds = parseStringArray(input.spaceIds);
      if (!spaceIds) throw new WorkbenchJobError("workbench/invalid-input");
      for (const spaceId of spaceIds) parseEntityId(spaceId);
      return { kind, spaceIds };
    }
    case "space.start": {
      expectKeys(input, ["kind", "spaceId"]);
      return { kind, spaceId: parseEntityId(input.spaceId) };
    }
    case "plan.execute": {
      expectKeys(input, ["kind", "planId"]);
      return { kind, planId: parseEntityId(input.planId) };
    }
    case "controller.acquire":
    case "recovery.resume":
    case "space.verify":
      throw new WorkbenchJobError("workbench/unsupported");
    case "llm.apply": {
      expectKeys(input, ["kind", "spaceIds", "catalogRevision", "observations"]);
      const spaceIds = parseStringArray(input.spaceIds);
      if (!spaceIds || spaceIds.length === 0) throw new WorkbenchJobError("workbench/invalid-input");
      for (const spaceId of spaceIds) parseEntityId(spaceId);
      if (!Number.isInteger(input.catalogRevision) || Number(input.catalogRevision) < 0) {
        throw new WorkbenchJobError("workbench/invalid-input");
      }
      const observations = parseApplyObservations(input.observations);
      return {
        kind,
        spaceIds,
        catalogRevision: Number(input.catalogRevision),
        observations,
      };
    }
    default:
      if (typeof kind === "string" && isWorkbenchProductCommand({ kind })) {
        try {
          return parseWorkbenchProductCommand(input);
        } catch {
          throw new WorkbenchJobError("workbench/invalid-input");
        }
      }
      throw new WorkbenchJobError("workbench/invalid-input");
  }
}

function parseApplyObservations(value: unknown): Extract<WorkbenchCommand, { kind: "llm.apply" }>["observations"] {
  if (!Array.isArray(value)) throw new WorkbenchJobError("workbench/invalid-input");
  return value.map((item) => {
    if (!isPlainObject(item)) throw new WorkbenchJobError("workbench/invalid-input");
    expectKeys(item, ["spaceId", "status", "generation", "catalogRevision", "busy", "serviceEpoch"]);
    parseEntityId(item.spaceId);
    const status = item.status;
    if (
      status !== "running" &&
      status !== "starting" &&
      status !== "stopping" &&
      status !== "stopped" &&
      status !== "crashed" &&
      status !== "unknown"
    ) {
      throw new WorkbenchJobError("workbench/invalid-input");
    }
    if (typeof item.busy !== "boolean" || !Number.isInteger(item.generation)) {
      throw new WorkbenchJobError("workbench/invalid-input");
    }
    if (item.catalogRevision !== null && (!Number.isInteger(item.catalogRevision) || Number(item.catalogRevision) < 0)) {
      throw new WorkbenchJobError("workbench/invalid-input");
    }
    if (typeof item.serviceEpoch !== "string" || !/^[a-f0-9]{64}$/.test(item.serviceEpoch)) {
      throw new WorkbenchJobError("workbench/invalid-input");
    }
    return {
      spaceId: String(item.spaceId),
      status,
      generation: Number(item.generation),
      catalogRevision: item.catalogRevision === null ? null : Number(item.catalogRevision),
      busy: item.busy,
      serviceEpoch: item.serviceEpoch,
    };
  });
}

function assertCommandHasNoSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertCommandHasNoSecrets(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_COMMAND_KEYS.has(key)) {
      throw new WorkbenchJobError("workbench/invalid-input");
    }
    assertCommandHasNoSecrets(nested);
  }
}


function parseCreateInput(input: unknown): { name: string; displayName?: string; icon?: string; useSharedLlm?: boolean; modelSource?: 'main'|'shared'|'local'; browser?: boolean; base?: 'web'|'browser'; baseVersion?: string } {
  if (!isPlainObject(input)) throw new WorkbenchJobError("workbench/invalid-input");
  expectKeys(input, ["name"], ["displayName", "icon", "useSharedLlm", "modelSource", "browser", "base", "baseVersion"]);
  const name = parseOptionalString(input.name);
  if (!name) throw new WorkbenchJobError("workbench/invalid-input");
  const parsed: { name: string; displayName?: string; icon?: string; useSharedLlm?: boolean; modelSource?: 'main'|'shared'|'local'; browser?: boolean; base?: 'web'|'browser'; baseVersion?: string } = { name };
  if(input.modelSource!==undefined){if(!['main','shared','local'].includes(String(input.modelSource))||input.useSharedLlm!==undefined)throw new WorkbenchJobError('workbench/invalid-input');parsed.modelSource=input.modelSource as 'main'|'shared'|'local';}
  if (input.displayName !== undefined) parsed.displayName = parseOptionalString(input.displayName);
  if (input.icon !== undefined) parsed.icon = parseOptionalString(input.icon);
  if (input.useSharedLlm !== undefined) {
    if (typeof input.useSharedLlm !== "boolean") throw new WorkbenchJobError("workbench/invalid-input");
    parsed.useSharedLlm = input.useSharedLlm;
  }
  if (input.base !== undefined) {
    if (input.base !== 'web' && input.base !== 'browser') throw new WorkbenchJobError('workbench/invalid-input');
    parsed.base = input.base;
  }
  if (input.baseVersion !== undefined) {
    if (typeof input.baseVersion !== 'string' || !isExactRuntimeVersion(input.baseVersion)) throw new WorkbenchJobError('workbench/invalid-input');
    parsed.baseVersion = input.baseVersion;
  }
  if (input.browser !== undefined) {
    if (typeof input.browser !== "boolean") throw new WorkbenchJobError("workbench/invalid-input");
    parsed.browser = input.browser;
  }
  return parsed;
}


function parseEntityId(value: unknown): string {
  if (typeof value !== "string" || !ENTITY_ID_RE.test(value)) {
    throw new WorkbenchJobError("workbench/invalid-input");
  }
  return value;
}

function parseOptionalString(value: unknown): string {
  if (typeof value !== "string") throw new WorkbenchJobError("workbench/invalid-input");
  return value;
}


function expectKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new WorkbenchJobError("workbench/invalid-input");
  }
  for (const key of required) {
    if (!(key in value)) throw new WorkbenchJobError("workbench/invalid-input");
  }
}

export function affectedSpaceIds(command: WorkbenchCommand): string[] {
  switch (command.kind) {
    case "space.update":
    case "space.start":
    case "template.save":
      return [command.spaceId];
    case "space.reorder":
      return [...command.spaceIds];
    case "llm.apply":
      return [...command.spaceIds];
    default:
      return [];
  }
}
