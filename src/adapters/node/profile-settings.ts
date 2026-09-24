import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit, YAMLMap, YAMLSeq, type Document, type Node } from "yaml";
import { atomicWrite } from "./atomic";
import { assertSafeSpaceId } from "./llm-policy-store";

const MIGRATION_MARKER = "dsh-spaces-settings-v1-sha256:";
const jsTag = { tag: "tag:yaml.org,2002:js", resolve: (value: string) => value };

/** Mutable profile/data paths must not traverse a junction or symbolic link. */
export function assertOwnedProfilePath(home: string, path: string): void {
  const root = resolve(home);
  const rel = relative(root, resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Profile path is outside its Home.");
  let cursor = root;
  for (const part of ["", ...rel.split(sep)]) {
    if (part) cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) throw new Error("Profile ownership path traverses a symbolic link or junction.");
  }
}

export function profileSettingsPath(home: string, name: string): string {
  assertSafeSpaceId(name);
  return join(home, "profiles", name, "cordis.patch.yml");
}

function parse(text: string, path: string): Document {
  const doc = parseDocument(text, { customTags: [jsTag], keepSourceTokens: true });
  if (doc.errors.length) throw new Error(`Invalid profile settings in ${path}: ${doc.errors[0]!.message}`);
  return doc;
}

function patchDocument(home: string, name: string): Document {
  const path = profileSettingsPath(home, name);
  const doc = parse(existsSync(path) ? readFileSync(path, "utf8") : "[]\n", path);
  if (!isSeq(doc.contents)) throw new Error(`Profile configuration must be a patch sequence: ${path}`);
  return doc as Document;
}

function configRows(doc: Document, omitAmbiguous = false): Map<string, YAMLMap> {
  if (!isSeq(doc.contents)) throw new Error("Profile configuration must be a patch sequence.");
  const rows = new Map<string, YAMLMap>();
  const ambiguous = new Set<string>();
  for (const row of doc.contents.items) {
    if (!isMap(row) || !row.has("config")) continue;
    const id = row.get("id");
    if (typeof id !== "string") continue;
    if (rows.has(id) || ambiguous.has(id)) {
      if (!omitAmbiguous) throw new Error(`Ambiguous profile configuration: duplicate entry ${id}`);
      rows.delete(id); ambiguous.add(id); continue;
    }
    rows.set(id, row);
  }
  return rows;
}

/** Detached namespace view over the native profile patch. No legacy reads or writes. */
export function readProfileSettings(home: string, name: string, omitAmbiguous = false): Document {
  const patch = patchDocument(home, name);
  const doc = parse("{}\n", profileSettingsPath(home, name)) as Document;
  for (const [id, row] of configRows(patch, omitAmbiguous)) doc.set(id, row.get("config", true)?.clone());
  return doc;
}

function requireStaticMap(value: unknown, label: string): YAMLMap<unknown, Node | null> {
  if (!isMap(value)) throw new Error(`Cannot edit dynamic or non-object configuration: ${label}`);
  visit(value, {
    Node(_key, node) {
      if (isAlias(node) || isScalar(node) && node.tag === jsTag.tag) {
        throw new Error(`Cannot edit dynamic configuration: ${label}`);
      }
    },
  });
  return value as YAMLMap<unknown, Node | null>;
}

function setSection(doc: Document, ns: string, section: unknown | null): void {
  const row = configRows(doc).get(ns);
  if (row) requireStaticMap(row.get("config", true), ns);
  if (section === null) {
    row?.delete("config");
    return;
  }
  const node = isMap(section) ? section.clone() : doc.createNode(section);
  requireStaticMap(node, ns);
  if (row) row.set("config", node);
  else doc.add(doc.createNode({ id: ns, config: section }));
}

/** Caller owns the existing Home operation lock and any running-profile preconditions. */
export function writeProfileSettings(home: string, name: string, sections: Record<string, unknown | null>): void {
  if (name === "web") throw new Error("The default web profile is protected.");
  const path = profileSettingsPath(home, name);
  const doc = patchDocument(home, name);
  for (const [ns, section] of Object.entries(sections)) setSection(doc, ns, section);
  atomicWrite(path, doc.toString({ lineWidth: 0 }));
}

function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }

function knownEntryIds(dump: string): Set<string> {
  const doc = parse(dump, "composed profile");
  const ids = new Set<string>();
  function entries(rows: unknown): void {
    if (!isSeq(rows)) return;
    for (const row of rows.items) {
      if (!isMap(row)) continue;
      const id = row.get("id");
      if (typeof id === "string") ids.add(id);
      if (row.get("group") === true) entries(row.get("config", true));
    }
  }
  entries(doc.contents);
  return ids;
}

function legacyEntry(ns: string): string {
  if (ns === "ui-developer-tools") return "ui-settings";
  if (ns === "ui-onboarding") return "ui-settings-general";
  if (ns === "shell") return process.platform === "win32" ? "pwsh-sandbox" : "bash-sandbox";
  return ns;
}

function docValue(value: unknown): unknown {
  if (isMap(value) || isSeq(value) || isScalar(value)) return value.toJSON();
  return value;
}

function mergeLegacy(existing: YAMLMap<unknown, Node | null>, incoming: YAMLMap<unknown, Node | null>, label: string): YAMLMap<unknown, Node | null> {
  const result = existing.clone() as YAMLMap<unknown, Node | null>;
  for (const pair of incoming.items) {
    const key = pair.key;
    if (!isScalar(key) || typeof key.value !== "string") throw new Error(`Invalid legacy settings key: ${label}`);
    const before = result.get(key.value, true);
    if (before == null) result.set(key.value, (pair.value?.clone() ?? null) as Node | null);
    else if (isMap(before) && isMap(pair.value)) result.set(key.value, mergeLegacy(requireStaticMap(before, label), requireStaticMap(pair.value, label), `${label}.${key.value}`));
    else if (!isDeepStrictEqual(docValue(before), docValue(pair.value))) {
      throw new Error(`Legacy settings conflict with profile configuration: ${label}.${key.value}`);
    }
  }
  return result;
}

/** One explicit, guarded migration during normal launch; interrupted commits are never replayed. */
export function migrateLegacyProfileSettings(home: string, name: string, dump: string): void {
  if (name === "web") throw new Error("The default web profile is protected.");
  const source = join(home, "hub", name, "settings.yaml");
  assertOwnedProfilePath(home, source);
  if (!existsSync(source)) return;
  const target = `${source}.migrated`;
  const path = profileSettingsPath(home, name);
  assertOwnedProfilePath(home, path);
  const before = readFileSync(path, "utf8");
  if (before.includes(MIGRATION_MARKER)) throw new Error("Interrupted settings migration: profile may already be updated; legacy evidence was preserved.");
  if (existsSync(target) || lstatSync(source).isSymbolicLink()) throw new Error("Legacy settings migration destination or ownership is not available.");
  const original = readFileSync(source, "utf8");
  const legacy = parse(original, source);
  const sections = requireStaticMap(legacy.contents, source);
  const doc = patchDocument(home, name);
  const rows = configRows(doc);
  const ids = knownEntryIds(dump);
  const mapped = new Set<string>();
  for (const pair of sections.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw new Error("Legacy settings namespace is not a string.");
    const ns = legacyEntry(pair.key.value);
    if (!ids.has(ns) || mapped.has(ns)) throw new Error(`Unsupported or duplicate legacy settings entry: ${ns}`);
    mapped.add(ns);
    const incoming = requireStaticMap(pair.value, ns);
    const existing = rows.get(ns)?.get("config", true);
    setSection(doc, ns, existing == null ? incoming : mergeLegacy(requireStaticMap(existing, ns), incoming, ns));
  }
  doc.commentBefore = [doc.commentBefore, ` ${MIGRATION_MARKER}${digest(original)}`].filter(Boolean).join("\n");
  // Recheck under the caller's ownership guard immediately before either mutation.
  if (existsSync(target) || lstatSync(source).isSymbolicLink()
    || readFileSync(source, "utf8") !== original || readFileSync(path, "utf8") !== before) {
    throw new Error("Legacy settings changed during migration; no profile update was committed.");
  }
  atomicWrite(path, doc.toString({ lineWidth: 0 }));
  renameSync(source, target);
}
