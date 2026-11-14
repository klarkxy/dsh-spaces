import { isExactRuntimeVersion } from "../../../../shared/runtime";
import type { WorkbenchCommand } from "../../../../shared/workbench";
import { isWorkbenchProductCommand } from "../../../../shared/workbench-product";
import { parseWorkbenchProductCommand } from "../../../../shared/workbench-product-schemas";
import { WorkbenchJobError } from "./contract";
import { SPACE_NAME_RE, spaceIdFromName } from "../../../../shared/types";
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
      expectKeys(input, ["kind", "spaceId"], ["displayName", "icon", "startWithDesktop"]);
      return {
        kind,
        spaceId: parseEntityId(input.spaceId),
        ...(input.displayName !== undefined ? { displayName: parseOptionalString(input.displayName) } : {}),
        ...(input.icon !== undefined ? { icon: parseOptionalString(input.icon) } : {}),
        ...(input.startWithDesktop !== undefined ? { startWithDesktop: parseBoolean(input.startWithDesktop) } : {}),
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
    case "control.execute": {
      expectKeys(input, ["kind", "controlPlanId", "spaceId"]);
      return {
        kind,
        controlPlanId: parseEntityId(input.controlPlanId),
        spaceId: parseEntityId(input.spaceId),
      };
    }
    case "creator.create": {
      expectKeys(input, ["kind", "planId", "name"], ["displayName", "icon"]);
      const name = parseOptionalString(input.name);
      if (!SPACE_NAME_RE.test(name)) throw new WorkbenchJobError("workbench/invalid-input");
      return {
        kind,
        planId: parseEntityId(input.planId),
        name,
        ...(input.displayName !== undefined ? { displayName: parseOptionalString(input.displayName) } : {}),
        ...(input.icon !== undefined ? { icon: parseOptionalString(input.icon) } : {}),
      };
    }
    case "controller.acquire":
    case "recovery.resume":
    case "space.verify":
      throw new WorkbenchJobError("workbench/unsupported");
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


function parseCreateInput(input: unknown): { name: string; displayName?: string; icon?: string; modelSource?: 'main'|'local'; browser?: boolean; base?: 'web'|'browser'; baseVersion?: string } {
  if (!isPlainObject(input)) throw new WorkbenchJobError("workbench/invalid-input");
  expectKeys(input, ["name"], ["displayName", "icon", "modelSource", "browser", "base", "baseVersion"]);
  const name = parseOptionalString(input.name);
  if (!name) throw new WorkbenchJobError("workbench/invalid-input");
  const parsed: { name: string; displayName?: string; icon?: string; modelSource?: 'main'|'local'; browser?: boolean; base?: 'web'|'browser'; baseVersion?: string } = { name };
  if(input.modelSource!==undefined){if(!['main','local'].includes(String(input.modelSource)))throw new WorkbenchJobError('workbench/invalid-input');parsed.modelSource=input.modelSource as 'main'|'local';}
  if (input.displayName !== undefined) parsed.displayName = parseOptionalString(input.displayName);
  if (input.icon !== undefined) parsed.icon = parseOptionalString(input.icon);
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

function parseBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new WorkbenchJobError("workbench/invalid-input");
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
    case "space.create":
      return [spaceIdFromName(command.input.name)];
    case "creator.create":
    case "template.create":
    case "space.import":
      return [spaceIdFromName(command.name)];
    case "space.update":
    case "space.start":
    case "control.execute":
    case "template.save":
      return [command.spaceId];
    case "space.reorder":
      return [...command.spaceIds];
    default:
      return [];
  }
}
