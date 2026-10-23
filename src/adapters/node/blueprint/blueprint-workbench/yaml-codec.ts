import { parseDocument, isMap, isScalar, isSeq, Scalar } from "yaml";
import { CREDENTIALS_ROW_ID, configPathExpr, isolationExpr, isExpectedIsolationPath, isExpectedIsolationRoot, SESSION_ROW_ID, SETTINGS_ROW_ID, STORAGE_ROW_ID } from "../../../../core/domain/isolation";
import type { BlueprintJson, BlueprintJsonObject, BlueprintPatch, BlueprintPatchEntry, BlueprintPatchInsert } from "../../../../shared/blueprint";
import type { BlueprintLocalObservation } from "../../../../shared/workbench-blueprint";
import { MANAGED_ENTRY_SET, JS_TAG, CREDENTIAL_KEY_RE } from "./constants";
import { looksLikeModulePath, looksLikeLocalPath } from "./utils";
import { publicError } from "./errors";

const jsTag = {
  tag: JS_TAG,
  identify: () => false,
  default: false,
  resolve(value: string): string {
    return value;
  },
};

export function yamlPatchToBlueprint(
  text: string,
  spaceId: string,
  dynamics: string[],
  observations: BlueprintLocalObservation[],
): BlueprintPatch {
  const doc = parseDocument(text, { customTags: [jsTag], prettyErrors: true, schema: "core" });
  if (doc.errors.length) throw publicError("The space patch could not be read.");
  if (!isSeq(doc.contents)) throw publicError("The space patch is not a YAML sequence.");
  const patch: BlueprintPatch = [];
  doc.contents.items.forEach((item, index) => {
    const pointer = `/profile/patch/${index}`;
    if (!isMap(item)) {
      dynamics.push(pointer);
      return;
    }
    if (item.has("insert")) {
      const insertNode = item.get("insert", true);
      if (!isSeq(insertNode)) {
        dynamics.push(`${pointer}/insert`);
        return;
      }
      const insert: BlueprintPatchEntry[] = [];
      insertNode.items.forEach((entry, insertIndex) => {
        const converted = convertPatchEntry(entry, `${pointer}/insert/${insertIndex}`, spaceId, dynamics, observations);
        if (converted) insert.push(converted);
      });
      const op: BlueprintPatchInsert = { insert };
      if (item.has("id")) {
        const id = isScalar(item.get("id", true)) ? String(item.get("id") ?? "") : "";
        if (id) op.id = id;
      }
      if (insert.length) patch.push(op);
      return;
    }
    const converted = convertPatchEntry(item, pointer, spaceId, dynamics, observations);
    if (converted) patch.push(converted);
  });
  return patch;
}

function convertPatchEntry(
  node: unknown,
  pointer: string,
  spaceId: string,
  dynamics: string[],
  observations: BlueprintLocalObservation[],
): BlueprintPatchEntry | null {
  if (!isMap(node)) {
    dynamics.push(pointer);
    return null;
  }
  const keys = node.items.map((pair) => (isScalar(pair.key) ? String(pair.key.value ?? "") : "")).filter(Boolean);
  const allowed = new Set(["id", "name", "config", "group", "disabled", "inject", "intercept", "isolate"]);
  if (keys.some((key) => !allowed.has(key))) {
    observations.push({ pointer, kind: "unknown", reason: "This patch entry has fields that cannot be shared." });
    dynamics.push(pointer);
    return null;
  }
  const id = isScalar(node.get("id", true)) ? String(node.get("id") ?? "") : "";
  if (!id) {
    dynamics.push(`${pointer}/id`);
    return null;
  }
  if (MANAGED_ENTRY_SET.has(id)) {
    const stripped = stripOwnedEntry(node, id, spaceId, `${pointer}`, dynamics, observations);
    return stripped;
  }
  const entry: BlueprintPatchEntry = { id };
  if (node.has("name")) {
    const name = node.get("name");
    if (typeof name !== "string") {
      dynamics.push(`${pointer}/name`);
      return null;
    }
    if (looksLikeModulePath(name)) {
      observations.push({ pointer: `${pointer}/name`, kind: "unknown", reason: "Patch module references must be package names." });
      dynamics.push(`${pointer}/name`);
      return null;
    }
    entry.name = name;
  }
  if (node.has("disabled")) entry.disabled = yamlBoolOrNull(node, "disabled");
  if (node.has("group")) entry.group = yamlBoolOrNull(node, "group");
  if (node.has("config")) {
    if (entry.group === true && isSeq(node.get("config", true))) {
      const children: BlueprintPatchEntry[] = [];
      const seq = node.get("config", true);
      if (isSeq(seq)) {
        seq.items.forEach((child, index) => {
          const converted = convertPatchEntry(child, `${pointer}/config/${index}`, spaceId, dynamics, observations);
          if (converted) children.push(converted);
        });
      }
      entry.config = children as unknown as BlueprintJson;
    } else {
      const config = yamlToJson(node.get("config", true), `${pointer}/config`, dynamics);
      if (hasJsExpr(config, `${pointer}/config`, dynamics)) return null;
      entry.config = config;
    }
  }
  if (node.has("inject")) entry.inject = yamlToJson(node.get("inject", true), `${pointer}/inject`, dynamics) as BlueprintPatchEntry["inject"];
  if (node.has("intercept")) entry.intercept = yamlToJson(node.get("intercept", true), `${pointer}/intercept`, dynamics) as BlueprintJsonObject;
  if (node.has("isolate")) entry.isolate = yamlToJson(node.get("isolate", true), `${pointer}/isolate`, dynamics) as BlueprintPatchEntry["isolate"];
  return entry;
}

function stripOwnedEntry(
  node: unknown,
  id: string,
  spaceId: string,
  pointer: string,
  dynamics: string[],
  observations: BlueprintLocalObservation[],
): BlueprintPatchEntry | null {
  if (!isMap(node)) return null;
  const configNode = node.get("config", true);
  if (configNode != null && !isMap(configNode)) {
    dynamics.push(`${pointer}/config`);
    return null;
  }
  const extras: BlueprintJsonObject = {};
  if (isMap(configNode)) {
    for (const pair of configNode.items) {
      const key = isScalar(pair.key) ? String(pair.key.value ?? "") : "";
      if (!key) continue;
      if ((id === SESSION_ROW_ID || id === STORAGE_ROW_ID) && key === "root") {
        if (isOwnedIsolationScalar(pair.value, spaceId, id === SESSION_ROW_ID ? "sessions" : "storages")) continue;
        if (isJsScalar(pair.value)) {
          dynamics.push(`${pointer}/config/root`);
          return null;
        }
        extras[key] = yamlToJson(pair.value, `${pointer}/config/${key}`, dynamics) as BlueprintJson;
        continue;
      }
      if ((id === SETTINGS_ROW_ID || id === CREDENTIALS_ROW_ID) && key === "path") {
        const file = id === SETTINGS_ROW_ID ? "settings.yaml" : ".credentials.yaml";
        if (isOwnedPathScalar(pair.value, spaceId, file)) continue;
        if (isJsScalar(pair.value)) {
          dynamics.push(`${pointer}/config/path`);
          return null;
        }
        extras[key] = yamlToJson(pair.value, `${pointer}/config/${key}`, dynamics) as BlueprintJson;
        continue;
      }
      extras[key] = yamlToJson(pair.value, `${pointer}/config/${jsonPointerToken(key)}`, dynamics) as BlueprintJson;
    }
  }
  const extraKeys = node.items
    .map((pair) => (isScalar(pair.key) ? String(pair.key.value ?? "") : ""))
    .filter((key) => key && key !== "id" && key !== "config");
  if (extraKeys.length === 0 && Object.keys(extras).length === 0) {
    observations.push({ pointer, kind: "managed", reason: "Owned isolation fields were omitted." });
    return null;
  }
  const entry: BlueprintPatchEntry = { id };
  if (Object.keys(extras).length) entry.config = extras;
  return entry;
}

export function yamlToJson(node: unknown, pointer: string, dynamics: string[]): BlueprintJson {
  if (node == null) return null;
  if (isScalar(node)) {
    if (jsTagged(node)) {
      dynamics.push(pointer);
      return typeof node.value === "string" ? node.value : String(node.value ?? "");
    }
    const value = node.value;
    if (value == null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value === 0 ? 0 : value;
    if (typeof value === "bigint") {
      dynamics.push(pointer);
      return String(value);
    }
    return String(value);
  }
  if (isSeq(node)) {
    return node.items.map((item, index) => yamlToJson(item, `${pointer}/${index}`, dynamics));
  }
  if (isMap(node)) {
    const object: BlueprintJsonObject = {};
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value ?? "") : "";
      if (!key) continue;
      if (key === "__jsExpr") {
        dynamics.push(pointer);
        continue;
      }
      object[key] = yamlToJson(pair.value, `${pointer}/${jsonPointerToken(key)}`, dynamics);
    }
    return object;
  }
  dynamics.push(pointer);
  return null;
}

function yamlBoolOrNull(node: { get(key: string, keep?: boolean): unknown; has(key: string): boolean }, key: string): boolean | null {
  const raw = node.get(key, true);
  if (raw == null) return null;
  if (isScalar(raw)) {
    if (raw.value == null) return null;
    return raw.value === true;
  }
  const value = node.get(key);
  if (value == null) return null;
  return value === true;
}

function jsTagged(node: Scalar): boolean {
  return node.tag === JS_TAG || node.tag === "!js" || String(node.tag ?? "").includes("yaml.org,2002:js");
}

function isJsScalar(node: unknown): node is Scalar {
  return isScalar(node) && jsTagged(node);
}

function isOwnedIsolationScalar(node: unknown, spaceId: string, kind: "sessions" | "storages"): boolean {
  if (!isJsScalar(node) || typeof node.value !== "string") return false;
  const actual = `!!js ${node.value}`;
  return isExpectedIsolationRoot(actual, spaceId, kind) || node.value.trim() === isolationExpr(spaceId, kind);
}

function isOwnedPathScalar(node: unknown, spaceId: string, file: "settings.yaml" | ".credentials.yaml"): boolean {
  if (!isJsScalar(node) || typeof node.value !== "string") return false;
  const actual = `!!js ${node.value}`;
  return isExpectedIsolationPath(actual, spaceId, file) || node.value.trim() === configPathExpr(spaceId, file);
}

function visitJson(
  value: BlueprintJson,
  pointer: string,
  visit: (value: BlueprintJson, pointer: string, key?: string) => void,
): void {
  visit(value, pointer);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitJson(item, `${pointer}/${index}`, visit));
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      visitJson(value[key] as BlueprintJson, `${pointer}/${jsonPointerToken(key)}`, visit);
      visit(value[key] as BlueprintJson, `${pointer}/${jsonPointerToken(key)}`, key);
    }
  }
}

export function hasJsExpr(value: unknown, pointer: string, dynamics: string[]): boolean {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "__jsExpr")) {
    dynamics.push(pointer);
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item, index) => hasJsExpr(item, `${pointer}/${index}`, dynamics));
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).some((key) =>
      hasJsExpr((value as Record<string, unknown>)[key], `${pointer}/${jsonPointerToken(key)}`, dynamics),
    );
  }
  return false;
}

export function walkPatchEntries(patch: BlueprintPatch, visit: (entry: BlueprintPatchEntry, pointer: string) => void): void {
  walkAllPatchEntries(patch, visit);
}

export function walkAllPatchEntries(patch: BlueprintPatch, visit: (entry: BlueprintPatchEntry, pointer: string) => void): void {
  const visitEntry = (entry: BlueprintPatchEntry, pointer: string) => {
    visit(entry, pointer);
    if (entry.group === true && Array.isArray(entry.config)) {
      entry.config.forEach((child, index) => {
        if (child && typeof child === "object" && !Array.isArray(child) && "id" in child && !("insert" in child)) {
          visitEntry(child as unknown as BlueprintPatchEntry, `${pointer}/config/${index}`);
        }
      });
    }
  };
  patch.forEach((item, index) => {
    const pointer = `/profile/patch/${index}`;
    if ("insert" in item && Array.isArray(item.insert)) {
      item.insert.forEach((entry, insertIndex) => visitEntry(entry, `${pointer}/insert/${insertIndex}`));
      return;
    }
    visitEntry(item as BlueprintPatchEntry, pointer);
  });
}

export function patchEntryId(patch: BlueprintPatch, pointer: string): string | undefined {
  return patchEntryAt(patch, pointer)?.id;
}

export function patchEntryName(patch: BlueprintPatch, pointer: string): string | undefined {
  return patchEntryAt(patch, pointer)?.name;
}

function patchEntryAt(patch: BlueprintPatch, pointer: string): BlueprintPatchEntry | undefined {
  const match = /^\/profile\/patch\/(\d+)(?:\/insert\/(\d+))?/.exec(pointer);
  if (!match) return undefined;
  const item = patch[Number(match[1])];
  if (!item) return undefined;
  if (match[2] && "insert" in item) return item.insert[Number(match[2])];
  if ("id" in item && !("insert" in item)) return item;
  return undefined;
}

export function settingsNamespaceOf(pointer: string): string | undefined {
  const match = /^\/profile\/settings\/([^/]+)/.exec(pointer);
  return match ? decodePointerToken(match[1]!) : undefined;
}

export function pointerExists(root: unknown, pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  const tokens = pointer.slice(1).split("/").map((token) => decodePointerToken(token));
  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || String(index) !== token || index < 0 || index >= current.length) return false;
      current = current[index];
    } else if (current && typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return false;
      current = (current as BlueprintJsonObject)[token];
    } else {
      return false;
    }
  }
  return true;
}

export function parentJsonPointer(pointer: string): string | undefined {
  const index = pointer.lastIndexOf("/");
  if (index <= 0) return undefined;
  return pointer.slice(0, index);
}

export function lastJsonPointerToken(pointer: string): string | undefined {
  const index = pointer.lastIndexOf("/");
  if (index < 0 || index === pointer.length - 1) return undefined;
  return decodePointerToken(pointer.slice(index + 1));
}

export function configBindingSuffix(pointer: string): string | undefined {
  const index = pointer.indexOf("/config/");
  if (index >= 0) return pointer.slice(index);
  if (pointer.endsWith("/config")) return "/config";
  return undefined;
}

export function readPointer(root: BlueprintJson, pointer: string): BlueprintJson {
  const tokens = pointer.slice(1).split("/").map((token) => decodePointerToken(token));
  let current: BlueprintJson = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      current = current[index] as BlueprintJson;
    } else if (current && typeof current === "object") {
      current = (current as BlueprintJsonObject)[token] as BlueprintJson;
    } else {
      throw new Error("missing");
    }
  }
  return current;
}

export function setPointer(root: BlueprintJsonObject, pointer: string, value: BlueprintJson): void {
  const tokens = pointer.slice(1).split("/").map((token) => decodePointerToken(token));
  let current: BlueprintJson = root;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(current)) current = current[Number(token)] as BlueprintJson;
    else current = (current as BlueprintJsonObject)[token] as BlueprintJson;
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(current)) current[Number(last)] = value;
  else (current as BlueprintJsonObject)[last] = value;
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function jsonPointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function findLocalPointers(value: BlueprintJson, pointer: string): BlueprintLocalObservation[] {
  const found: BlueprintLocalObservation[] = [];
  visitJson(value, pointer, (item, path) => {
    if (typeof item === "string" && looksLikeLocalPath(item)) {
      found.push({ pointer: path, kind: "directory", reason: "Local paths must be declared as inputs." });
    }
  });
  return found;
}

export function jsonLooksCredential(value: BlueprintJson, pointer: string, observations: BlueprintLocalObservation[]): boolean {
  let found = false;
  visitJson(value, pointer, (item, path, key) => {
    if (key && CREDENTIAL_KEY_RE.test(key)) {
      observations.push({ pointer: path, kind: "unknown", reason: "Credential-like keys cannot be shared." });
      found = true;
    }
    if (typeof item === "string" && /sk-[A-Za-z0-9]{10,}/.test(item)) {
      observations.push({ pointer: path, kind: "unknown", reason: "Credential-like values cannot be shared." });
      found = true;
    }
  });
  return found;
}
