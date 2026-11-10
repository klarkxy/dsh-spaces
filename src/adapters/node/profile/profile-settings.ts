import { lstatSync } from "../../../shared/node/filesystem";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit, YAMLMap, type Document, type Node } from "yaml";
import { atomicWrite } from "../atomic";
import { assertSafeSpaceId } from "./space-data-root";

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

/** Detached namespace view over the native profile patch. */
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
