import { parsePublicationPlan } from "../../../core/domain/dashboard/validation";
import { sanitizeSpaceIcon } from "../../../shared/space-icon";
import type { WorkbenchPlanRequest } from "../../../shared/workbench";
import { parseSpaceId, SpacesPublicError } from "../spaces-control";
import { WorkbenchPublicError } from "./errors";

const ENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GLYPH_RE = /^[a-z0-9-]{1,32}$/;

export function parsePlanRequest(input: unknown): WorkbenchPlanRequest {
  const body = expectObject(input);
  const kind = body.kind;
  if (typeof kind !== "string") throw new WorkbenchPublicError("workbench/invalid-input");
  switch (kind) {
    case "dashboard.publication.set":
      return parsePublicationPlan(input);
    case "space.stop":
    case "space.restart":
      expectKeys(body, ["kind", "spaceId"]);
      return { kind, spaceId: parseSpaceName(body.spaceId) };
    case "space.delete":
      expectKeys(body, ["kind", "spaceId"], ["removeData"]);
      return {
        kind,
        spaceId: parseSpaceName(body.spaceId),
        removeData: body.removeData === undefined ? false : body.removeData === true,
      };
    case "controller.release":
    case "controller.shutdown":
    case "snapshot.restore":
    case "config.restore":
    case "runtime.upgrade":
      throw new WorkbenchPublicError("workbench/unsupported");
    case "service.shutdown":
      expectKeys(body, ["kind"]);
      return { kind };
    case "plugin.install":
      expectKeys(body, ["kind", "spaceIds", "catalogId", "version"]);
      return {
        kind,
        spaceIds: parseIdList(body.spaceIds).map((id) => parseSpaceName(id)),
        catalogId: parsePluginKey(body.catalogId),
        version: parseId(body.version),
      };
    case "plugin.remove":
      expectKeys(body, ["kind", "spaceId", "packageName"]);
      return { kind, spaceId: parseSpaceName(body.spaceId), packageName: parsePluginKey(body.packageName) };
    case "plugin.toggle":
      expectKeys(body, ["kind", "spaceId", "pluginId", "enabled"]);
      if (typeof body.enabled !== "boolean") throw new WorkbenchPublicError("workbench/invalid-input");
      return { kind, spaceId: parseSpaceName(body.spaceId), pluginId: parsePluginKey(body.pluginId), enabled: body.enabled };
    case "plugin.cleanup-manager":
      expectKeys(body, ["kind", "spaceId"]);
      return { kind, spaceId: parseSpaceName(body.spaceId) };
    case "snapshot.create":
      expectKeys(body, ["kind"]);
      return { kind };
    case "snapshot.delete":
      expectKeys(body, ["kind", "snapshotId"]);
      return { kind, snapshotId: parseId(body.snapshotId) };
    case "runtime.install":
      expectKeys(body, ["kind", "version"]);
      return { kind, version: parseId(body.version) };
    default:
      throw new WorkbenchPublicError("workbench/invalid-input");
  }
}

export function parseIcon(value: string): string {
  if (GLYPH_RE.test(value)) return value;
  return sanitizeSpaceIcon(value);
}

export function parseId(value: unknown): string {
  if (typeof value !== "string" || !ENTITY_RE.test(value)) {
    throw new WorkbenchPublicError("workbench/invalid-input");
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new WorkbenchPublicError("workbench/invalid-input");
  }
  return value;
}

export function parsePluginKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 214 ||
    !/^(?:@?[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value)) {
    throw new WorkbenchPublicError("workbench/invalid-input");
  }
  return value;
}

export function parseSpaceName(value: unknown): string {
  const id = parseId(value);
  try {
    return parseSpaceId(id);
  } catch (error) {
    if (error instanceof SpacesPublicError) throw new WorkbenchPublicError("workbench/invalid-input");
    throw error;
  }
}

export function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new WorkbenchPublicError("workbench/invalid-input");
  return value.map(parseId);
}

export function parseRequestId(value: unknown): string {
  if (typeof value !== "string" || !ENTITY_RE.test(value)) {
    throw new WorkbenchPublicError("workbench/invalid-input");
  }
  return value;
}

export function expectObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkbenchPublicError("workbench/invalid-input");
  }
  return value as Record<string, unknown>;
}

export function expectKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new WorkbenchPublicError("workbench/invalid-input");
  }
  for (const key of required) {
    if (!(key in value)) throw new WorkbenchPublicError("workbench/invalid-input");
  }
}
