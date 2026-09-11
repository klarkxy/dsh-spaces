import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
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
import { t } from "../shared/i18n";
import { atomicWrite } from "./atomic";
import { runDsh } from "./dsh-cli";

export const SESSION_ROW_ID = "session-persistence-jsonl";
export const STORAGE_ROW_ID = "storage-json";

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

export class PatchWriter {
  constructor(private readonly dshHome: string) {}

  patchPath(name: string): string {
    return join(this.dshHome, "profiles", name, "cordis.patch.yml");
  }

  ensureWorkbenchPatch(name: string): void {
    if (name === "web") {
      throw new PatchForbiddenError(t("errors.webSacred"));
    }
    const path = this.patchPath(name);
    if (!existsSync(path)) {
      throw new Error(t("errors.missingPatch", { path }));
    }
    const original = readFileSync(path, "utf8");
    const doc = parsePatchDocument(original, path);
    const seq = requireSeq(doc, path);
    const sessionRows = rowsWithId(seq, SESSION_ROW_ID);
    const storageRows = rowsWithId(seq, STORAGE_ROW_ID);
    if (sessionRows.length > 1) {
      throw new PatchVerifyError(duplicateRowMessage(SESSION_ROW_ID, path));
    }
    if (storageRows.length > 1) {
      throw new PatchVerifyError(duplicateRowMessage(STORAGE_ROW_ID, path));
    }

    upsertIsolationRow(seq, sessionRows[0], SESSION_ROW_ID, isolationExpr(name, "sessions"));
    upsertIsolationRow(seq, storageRows[0], STORAGE_ROW_ID, isolationExpr(name, "storages"));

    const body = doc.toString({ lineWidth: 0 });
    const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
    writeFileSync(`${path}.bak-${stamp}-${randomUUID()}`, original, { encoding: "utf8", flag: "wx" });
    atomicWrite(path, body.endsWith("\n") ? body : `${body}\n`);
  }

  async verify(name: string): Promise<void> {
    if (name === "web") return;
    const dump = await dumpConfig(this.dshHome, name);
    assertDumpPatched(dump, name);
  }
}

export function extractRoot(dump: string, id: string): string | null {
  const doc = parsePatchDocument(dump, "dump-config");
  const seq = requireSeq(doc, "dump-config");
  const rows = rowsWithId(seq, id);
  if (rows.length > 1) {
    throw new PatchVerifyError(duplicateRowMessage(id, "dump-config"));
  }
  if (rows.length === 0) return null;
  const config = rows[0].get("config", true);
  if (!isMap(config)) return null;
  const root = config.get("root", true);
  if (root == null) return null;
  return formatRoot(root);
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

export async function dumpConfig(dshHome: string, name: string): Promise<string> {
  return runDsh(dshHome, ["--profile", name, "--dump-config"], { timeoutMs: 30_000 }).then(
    ({ stdout, stderr, code }) => {
      if (code !== 0) {
        throw new PatchVerifyError(t("errors.dumpConfigFailed", { code, detail: stderr.slice(0, 400) }));
      }
      return stdout;
    },
  );
}

function isolationExpr(name: string, kind: "sessions" | "storages"): string {
  return `dshHomePath('hub/${name}/${kind}')`;
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

function upsertIsolationRow(seq: YAMLSeq, existing: YAMLMap | undefined, id: string, expr: string): void {
  if (existing) {
    setRoot(existing, expr);
    return;
  }
  const row = new YAMLMap();
  row.set("id", id);
  const config = new YAMLMap();
  setRootOnConfig(config, expr);
  row.set("config", config);
  seq.add(row);
}

function setRoot(row: YAMLMap, expr: string): void {
  const configNode = row.get("config", true);
  if (isMap(configNode)) {
    setRootOnConfig(configNode, expr);
    return;
  }
  if (configNode != null) {
    throw new PatchVerifyError(`Cannot safely update dynamic or non-mapping config for ${row.get("id")}`);
  }
  const config = new YAMLMap();
  setRootOnConfig(config, expr);
  row.set("config", config);
}

function setRootOnConfig(config: YAMLMap, expr: string): void {
  const current = config.get("root", true);
  if (isScalar(current)) {
    // Mutating the existing node retains its comments, anchors and quoting style.
    current.value = expr;
    current.tag = JS_TAG;
  } else {
    if (current != null) throw new PatchVerifyError("Cannot safely replace a non-scalar root");
    config.set("root", jsScalar(expr));
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
