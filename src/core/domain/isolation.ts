import {
  parseDocument,
  Scalar,
  YAMLMap,
  YAMLSeq,
  isMap,
  isScalar,
  isSeq,
  type Document,
} from "yaml";
import { t } from "../../shared/i18n";

export const SESSION_ROW_ID = "session-persistence-jsonl";
export const STORAGE_ROW_ID = "storage-json";
export const SETTINGS_ROW_ID = "settings";
export const CREDENTIALS_ROW_ID = "credentials";

const JS_TAG = "tag:yaml.org,2002:js";
const DSH_HOME_PATH_RE = /^dshHomePath\(\s*(['"])([^'"]+)\1\s*\)$/;

/** Unevaluated `!!js` scalar. Resolve returns the source string; never Function/eval. */
const jsTag = {
  tag: JS_TAG,
  identify: () => false,
  default: false,
  resolve(value: string): string {
    return value;
  },
};

export class PatchForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchForbiddenError";
  }
}

export class PatchVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchVerifyError";
  }
}

export function isolationExpr(name: string, kind: "sessions" | "storages"): string {
  return `dshHomePath('hub/${name}/${kind}')`;
}

export function configPathExpr(name: string, filename: "settings.yaml" | ".credentials.yaml"): string {
  return `dshHomePath('hub/${name}/${filename}')`;
}

export function patchTextLooksIsolated(text: string, name: string): boolean {
  return text.includes(`hub/${name}/sessions`) && text.includes(`hub/${name}/storages`);
}

export function patchTextLooksConfigIsolated(text: string, name: string): boolean {
  return (
    patchTextLooksIsolated(text, name) &&
    text.includes(`hub/${name}/.credentials.yaml`)
  );
}

export function applyIsolationPatch(original: string, name: string, source: string): string {
  if (name === "web") {
    throw new PatchForbiddenError(t("errors.webSacred"));
  }
  const doc = parsePatchDocument(original, source);
  const seq = requireSeq(doc, source);
  const sessionRows = rowsWithId(seq, SESSION_ROW_ID);
  const storageRows = rowsWithId(seq, STORAGE_ROW_ID);
  const settingsRows = rowsWithId(seq, SETTINGS_ROW_ID);
  const credentialsRows = rowsWithId(seq, CREDENTIALS_ROW_ID);
  if (sessionRows.length > 1) {
    throw new PatchVerifyError(duplicateRowMessage(SESSION_ROW_ID, source));
  }
  if (storageRows.length > 1) {
    throw new PatchVerifyError(duplicateRowMessage(STORAGE_ROW_ID, source));
  }
  if (settingsRows.length > 1) {
    throw new PatchVerifyError(duplicateRowMessage(SETTINGS_ROW_ID, source));
  }
  if (credentialsRows.length > 1) {
    throw new PatchVerifyError(duplicateRowMessage(CREDENTIALS_ROW_ID, source));
  }

  upsertJsConfigField(seq, sessionRows[0], SESSION_ROW_ID, "root", isolationExpr(name, "sessions"));
  upsertJsConfigField(seq, storageRows[0], STORAGE_ROW_ID, "root", isolationExpr(name, "storages"));
  // Alpha settings persist in the active profile patch through ConfigEditor.
  // The removed file provider's path must not remain as a false isolation claim.
  const settingsConfig = settingsRows[0]?.get("config", true);
  if (isMap(settingsConfig)) settingsConfig.delete("path");
  upsertJsConfigField(
    seq,
    credentialsRows[0],
    CREDENTIALS_ROW_ID,
    "path",
    configPathExpr(name, ".credentials.yaml"),
  );

  const body = doc.toString({ lineWidth: 0 });
  return body.endsWith("\n") ? body : `${body}\n`;
}

export function extractRoot(dump: string, id: string): string | null {
  return extractConfigField(dump, id, "root");
}

export function extractConfigField(dump: string, id: string, field: string): string | null {
  const doc = parsePatchDocument(dump, "dump-config");
  const seq = requireSeq(doc, "dump-config");
  const rows = rowsWithId(seq, id);
  if (rows.length > 1) {
    throw new PatchVerifyError(duplicateRowMessage(id, "dump-config"));
  }
  if (rows.length === 0) return null;
  const config = rows[0].get("config", true);
  if (!isMap(config)) return null;
  const value = config.get(field, true);
  if (value == null) return null;
  return formatRoot(value);
}

export function assertDumpPatched(dump: string, name: string): void {
  const sessionRoot = extractRoot(dump, SESSION_ROW_ID);
  const storageRoot = extractRoot(dump, STORAGE_ROW_ID);
  if (!sessionRoot) {
    throw new PatchVerifyError(t("errors.missingDumpRow", { id: SESSION_ROW_ID, name }));
  }
  if (!storageRoot) {
    throw new PatchVerifyError(t("errors.missingDumpRow", { id: STORAGE_ROW_ID, name }));
  }
  if (!isExpectedIsolationRoot(sessionRoot, name, "sessions")) {
    throw new PatchVerifyError(
      t("errors.dumpRootMismatch", { id: SESSION_ROW_ID, actual: sessionRoot, name, kind: "sessions" }),
    );
  }
  if (!isExpectedIsolationRoot(storageRoot, name, "storages")) {
    throw new PatchVerifyError(
      t("errors.dumpRootMismatch", { id: STORAGE_ROW_ID, actual: storageRoot, name, kind: "storages" }),
    );
  }
}

/** Session/storage and credentials paths. Alpha settings are profile-owned. */
export function assertDumpConfigIsolated(dump: string, name: string): void {
  assertDumpPatched(dump, name);
  const settingsPath = extractConfigField(dump, SETTINGS_ROW_ID, "path");
  const credentialsPath = extractConfigField(dump, CREDENTIALS_ROW_ID, "path");
  if (settingsPath) throw new PatchVerifyError("Legacy settings.path is not an alpha isolation boundary.");
  if (!credentialsPath) {
    throw new PatchVerifyError(t("errors.missingDumpRow", { id: CREDENTIALS_ROW_ID, name }));
  }
  if (!isExpectedIsolationPath(credentialsPath, name, ".credentials.yaml")) {
    throw new PatchVerifyError(
      t("errors.dumpPathMismatch", {
        id: CREDENTIALS_ROW_ID,
        actual: credentialsPath,
        name,
        file: ".credentials.yaml",
      }),
    );
  }
}

export function isExpectedIsolationRoot(
  actual: string,
  name: string,
  kind: "sessions" | "storages",
): boolean {
  const expectedRel = `hub/${name}/${kind}`;
  // A string that looks like an expression is not an evaluated DSH home path.
  if (!actual.startsWith("!!js ")) return false;
  const match = actual.slice(5).trim().match(DSH_HOME_PATH_RE);
  return match?.[2] === expectedRel;
}

export function isExpectedIsolationPath(
  actual: string,
  name: string,
  filename: "settings.yaml" | ".credentials.yaml",
): boolean {
  const expectedRel = `hub/${name}/${filename}`;
  if (!actual.startsWith("!!js ")) return false;
  const match = actual.slice(5).trim().match(DSH_HOME_PATH_RE);
  return match?.[2] === expectedRel;
}

function duplicateRowMessage(id: string, source: string): string {
  return `duplicate row ${id} in ${source}`;
}

function parsePatchDocument(text: string, source: string): Document.Parsed {
  const doc = parseDocument(text, {
    prettyErrors: true,
    customTags: [jsTag],
    schema: "core",
  });
  if (doc.errors.length > 0) {
    throw new PatchVerifyError(
      `Could not parse ${source}: ${doc.errors.map((err) => err.message).join("; ")}`,
    );
  }
  return doc;
}

function requireSeq(doc: Document.Parsed, source: string): YAMLSeq {
  if (!isSeq(doc.contents)) {
    throw new PatchVerifyError(`${source} must be a YAML sequence`);
  }
  return doc.contents;
}

function rowsWithId(seq: YAMLSeq, id: string): YAMLMap[] {
  const rows: YAMLMap[] = [];
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    if (item.get("id") === id) rows.push(item);
  }
  return rows;
}

function upsertJsConfigField(
  seq: YAMLSeq,
  existing: YAMLMap | undefined,
  id: string,
  field: string,
  expr: string,
): void {
  if (existing) {
    setJsConfigField(existing, field, expr);
    return;
  }
  const row = new YAMLMap();
  row.set("id", id);
  const config = new YAMLMap();
  setJsFieldOnConfig(config, field, expr);
  row.set("config", config);
  seq.add(row);
}

function setJsConfigField(row: YAMLMap, field: string, expr: string): void {
  const configNode = row.get("config", true);
  if (isMap(configNode)) {
    setJsFieldOnConfig(configNode, field, expr);
    return;
  }
  if (configNode != null) {
    throw new PatchVerifyError(`Cannot safely update dynamic or non-mapping config for ${row.get("id")}`);
  }
  const config = new YAMLMap();
  setJsFieldOnConfig(config, field, expr);
  row.set("config", config);
}

function setJsFieldOnConfig(config: YAMLMap, field: string, expr: string): void {
  const current = config.get(field, true);
  if (isScalar(current)) {
    // Mutating the existing node retains its comments, anchors and quoting style.
    current.value = expr;
    current.tag = JS_TAG;
  } else {
    if (current != null) throw new PatchVerifyError(`Cannot safely replace a non-scalar ${field}`);
    config.set(field, jsScalar(expr));
  }
}

function jsScalar(expr: string): Scalar {
  const node = new Scalar(expr);
  node.tag = JS_TAG;
  node.type = Scalar.PLAIN;
  return node;
}

function formatRoot(node: unknown): string | null {
  if (isScalar(node)) {
    if (node.value == null) return null;
    const text = String(node.value);
    if (node.tag === JS_TAG || node.tag === "!!js") return `!!js ${text}`;
    return JSON.stringify(node.value);
  }
  return null;
}
