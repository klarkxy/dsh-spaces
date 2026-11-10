import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { Document, isMap, isScalar, isSeq, parseDocument, visit, type Node, type YAMLMap } from "yaml";
import { atomicWrite } from "../atomic";
import { spaceDataRoot } from "../profile/space-data-root";
import { WorkbenchPublicError } from "../supervisor/errors";

/**
 * One-shot copy of the main space's model configuration into a managed
 * space: llm-pi-ai routes, the native DeepSeek configuration, the default
 * model and the credentials those routes reference. It runs at creation or
 * on an explicit user request, never on a schedule, and never rewrites a
 * space on its own afterwards. Routes the space added itself are kept.
 * Login grants (OAuth) are skipped and reported. Secret values only travel
 * from the main credentials file into the space's isolated credentials file;
 * summaries, errors and logs carry names only.
 */
export const PI_AI_ROW = "llm-pi-ai";
export const DEEPSEEK_ROW = "llm-deepseek";
export const DEFAULT_MODEL_ROW = "agent-default-model";
const CREDENTIALS_ROW = "credentials";
const PI_AI_RECORD_SCOPE = "llm-pi-ai";
const DEEPSEEK_DEFAULT_KEY_REF = "DEEPSEEK_API_KEY";
const CREDENTIALS_FILE = ".credentials.yaml";
const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOME_PATH_RE = /^dshHomePath\((['"])([^'"\\]+)\1\)$/;

export type ModelSyncSkipReason = "login-grant" | "expression" | "unsupported";
export interface ModelSyncSkip { route: string; reason: ModelSyncSkipReason }

export interface MainModelSnapshot {
  providers: Record<string, Record<string, unknown>>;
  deepseek: boolean;
  deepseekConfig?: Record<string, unknown>;
  defaultModel?: { provider: string; model: string; reasoningEffort?: string };
  defaultModelSkipped?: string;
  refs: Record<string, string>;
  records: Record<string, unknown>;
  skipped: ModelSyncSkip[];
  missingCredentials: string[];
}

/** Names only: safe for plans, job steps and logs. */
export interface ModelSyncSummary {
  mainProfile: string;
  routes: string[];
  deepseek: boolean;
  defaultModel?: string;
  defaultModelSkipped?: string;
  credentials: string[];
  skipped: ModelSyncSkip[];
  missingCredentials: string[];
}

export interface ModelSyncInput {
  home: string;
  mainProfile: string;
  spaceId: string;
  dumpConfig(profile: string): Promise<string>;
}

function fail(message: string): never {
  throw new WorkbenchPublicError("workbench/failed", message);
}

type Row = YAMLMap<unknown, unknown>;

function parse(text: string, source: string): Document {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length) fail(`${source} could not be parsed.`);
  return doc;
}

function rowsOf(doc: Document, source: string): Row[] {
  const contents = doc.contents;
  if (contents === null || contents === undefined) return [];
  if (!isSeq(contents)) fail(`${source} is not a patch list.`);
  return contents.items.filter((item): item is Row => isMap(item));
}

function onlyRow(doc: Document, id: string, source: string): Row | undefined {
  const found = rowsOf(doc, source).filter((row) => row.get("id") === id);
  if (found.length > 1) fail(`${source} has more than one ${id} row.`);
  return found[0];
}

const CORE_TAGS = new Set(["str", "int", "float", "bool", "null", "map", "seq", "omap", "pairs", "set", "timestamp", "binary"]
  .map((name) => `tag:yaml.org,2002:${name}`));

/** `!!js` resolves to tag:yaml.org,2002:js; anything outside the YAML core schema is host-evaluated. */
function isExpressionTag(tag: string | undefined): boolean {
  return Boolean(tag) && !CORE_TAGS.has(tag!);
}

/** Any non-core YAML tag (`!!js` expressions) is evaluated by the host and cannot be copied as data. */
export function hasExpression(node: unknown): boolean {
  let found = false;
  const check = (candidate: Node) => {
    if (isExpressionTag((candidate as { tag?: string }).tag)) found = true;
  };
  if (!node || typeof node !== "object") return false;
  if ("tag" in node) check(node as Node);
  visit(node as Node, { Node: (_key, candidate) => { check(candidate as Node); return found ? visit.BREAK : undefined; } });
  return found;
}

function configOf(row: Row | undefined): YAMLMap<unknown, unknown> | undefined {
  const config = row?.get("config", true);
  return isMap(config) ? config : undefined;
}

function plainString(node: unknown): string | undefined {
  if (!isScalar(node) || hasExpression(node) || typeof node.value !== "string") return undefined;
  return node.value;
}

function keyName(key: unknown): string {
  return isScalar(key) ? String(key.value) : String(key);
}

function mainCredentialsPath(dump: Document, home: string): string {
  const path = configOf(onlyRow(dump, CREDENTIALS_ROW, "main configuration"))?.get("path", true);
  if (path === undefined || path === null) return join(home, CREDENTIALS_FILE);
  if (!isScalar(path) || typeof path.value !== "string") fail("The main credentials location is not a path.");
  if (isExpressionTag((path as { tag?: string }).tag)) {
    const match = HOME_PATH_RE.exec(path.value.trim());
    const relative = match?.[2];
    if (!relative || isAbsolute(relative) || normalize(relative).split(/[\\/]/).includes("..")) {
      fail("The main credentials location could not be resolved.");
    }
    return join(home, relative);
  }
  if (!isAbsolute(path.value)) fail("The main credentials location could not be resolved.");
  return path.value;
}

interface CredentialsDocument { doc: Document; refs: Map<string, string>; records: Map<string, unknown> }

export function parseCredentials(text: string | undefined, source: string): CredentialsDocument {
  const doc = text === undefined || !text.trim() ? new Document({ version: 1 }) : parse(text, source);
  if (doc.contents === null || doc.contents === undefined) doc.contents = doc.createNode({ version: 1 }) as never;
  if (!isMap(doc.contents)) fail(`${source} is not a credentials document.`);
  if (doc.get("version") !== 1) fail(`${source} is not a version 1 credentials document.`);
  const refs = new Map<string, string>();
  const refsNode = doc.get("refs", true);
  if (isMap(refsNode)) {
    for (const pair of refsNode.items) {
      const value = isScalar(pair.value) ? pair.value.value : undefined;
      if (typeof value === "string") refs.set(keyName(pair.key), value);
    }
  }
  const records = new Map<string, unknown>();
  const recordsNode = doc.get("records", true);
  if (isMap(recordsNode)) {
    for (const pair of recordsNode.items) records.set(keyName(pair.key), (pair.value as Node | null)?.toJSON?.());
  }
  return { doc, refs, records };
}

/** Read the main space's composed configuration and credentials. Nothing is written. */
export function readMainModelSnapshot(
  dumpText: string,
  home: string,
  readFile: (path: string) => string | undefined = (path) => existsSync(path) ? readFileSync(path, "utf8") : undefined,
): MainModelSnapshot {
  const dump = parse(dumpText, "main configuration");
  const main = parseCredentials(readFile(mainCredentialsPath(dump, home)), "main credentials");
  const snapshot: MainModelSnapshot = { providers: {}, deepseek: false, refs: {}, records: {}, skipped: [], missingCredentials: [] };
  const missing = new Set<string>();
  const copyRef = (ref: unknown) => {
    if (typeof ref !== "string" || !REF_RE.test(ref)) return;
    const value = main.refs.get(ref);
    if (value === undefined) missing.add(ref);
    else snapshot.refs[ref] = value;
  };

  const providers = configOf(onlyRow(dump, PI_AI_ROW, "main configuration"))?.get("providers", true);
  if (isMap(providers)) {
    for (const pair of providers.items) {
      const route = keyName(pair.key);
      if (!isMap(pair.value)) { snapshot.skipped.push({ route, reason: "unsupported" }); continue; }
      if (hasExpression(pair.value)) { snapshot.skipped.push({ route, reason: "expression" }); continue; }
      const recordKey = `${PI_AI_RECORD_SCOPE}/${route}`;
      const record = main.records.get(recordKey) as { kind?: unknown } | undefined;
      if (record?.kind === "grant") { snapshot.skipped.push({ route, reason: "login-grant" }); continue; }
      const profile = pair.value.toJSON() as Record<string, unknown>;
      snapshot.providers[route] = profile;
      if (record?.kind === "api-key") snapshot.records[recordKey] = record;
      copyRef(profile.apiKeyEnv);
    }
  }

  const deepseekConfig = configOf(onlyRow(dump, DEEPSEEK_ROW, "main configuration"));
  if (deepseekConfig && hasExpression(deepseekConfig)) {
    snapshot.skipped.push({ route: DEEPSEEK_ROW, reason: "expression" });
  } else {
    const config = deepseekConfig?.items.length ? deepseekConfig.toJSON() as Record<string, unknown> : undefined;
    const ref = typeof config?.apiKeyEnv === "string" ? config.apiKeyEnv : DEEPSEEK_DEFAULT_KEY_REF;
    const key = REF_RE.test(ref) ? main.refs.get(ref) : undefined;
    if (config) snapshot.deepseekConfig = config;
    if (key !== undefined) snapshot.refs[ref] = key;
    else if (config) missing.add(ref);
    snapshot.deepseek = Boolean(config) || key !== undefined;
  }

  const selection = configOf(onlyRow(dump, DEFAULT_MODEL_ROW, "main configuration"));
  const provider = plainString(selection?.get("provider", true));
  const model = plainString(selection?.get("model", true));
  if (provider && model) {
    if (snapshot.skipped.some((skip) => skip.route === provider)) snapshot.defaultModelSkipped = provider;
    else {
      const reasoningEffort = plainString(selection?.get("reasoningEffort", true));
      snapshot.defaultModel = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
    }
  }
  for (const ref of Object.keys(snapshot.refs)) missing.delete(ref);
  snapshot.missingCredentials = [...missing].sort();
  return snapshot;
}

export function summarizeSnapshot(mainProfile: string, snapshot: MainModelSnapshot): ModelSyncSummary {
  return {
    mainProfile,
    routes: Object.keys(snapshot.providers),
    deepseek: snapshot.deepseek,
    ...(snapshot.defaultModel ? { defaultModel: `${snapshot.defaultModel.provider}/${snapshot.defaultModel.model}` } : {}),
    ...(snapshot.defaultModelSkipped ? { defaultModelSkipped: snapshot.defaultModelSkipped } : {}),
    credentials: [...Object.keys(snapshot.refs), ...Object.keys(snapshot.records)].sort(),
    skipped: snapshot.skipped,
    missingCredentials: snapshot.missingCredentials,
  };
}

/** Merge the snapshot into a space's user patch layer. Other rows and the space's own routes stay. */
export function applySnapshotToPatch(text: string, snapshot: MainModelSnapshot, source = "space patch"): string {
  const doc = parse(text, source);
  if (doc.contents === null || doc.contents === undefined) doc.contents = doc.createNode([]) as never;
  const seq = doc.contents;
  if (!isSeq(seq)) fail(`${source} is not a patch list.`);
  seq.flow = false;
  const ensureRow = (id: string): Row => {
    const existing = onlyRow(doc, id, source);
    if (existing) return existing;
    const row = doc.createNode({ id }) as Row;
    seq.items.push(row);
    return row;
  };
  const ensureConfig = (row: Row): YAMLMap<unknown, unknown> => {
    const current = row.get("config", true);
    if (current !== undefined && current !== null && !isMap(current)) fail(`${source} has a non-mapping config.`);
    if (isMap(current)) {
      if (hasExpression(current)) fail(`${source} uses an expression in a model row.`);
      return current;
    }
    const created = doc.createNode({}) as YAMLMap<unknown, unknown>;
    row.set("config", created);
    return created;
  };
  const routes = Object.entries(snapshot.providers);
  if (routes.length) {
    const config = ensureConfig(ensureRow(PI_AI_ROW));
    const existing = config.get("providers", true);
    if (existing !== undefined && existing !== null && !isMap(existing)) fail("The space llm-pi-ai providers is not a mapping.");
    let providers: YAMLMap<unknown, unknown>;
    if (isMap(existing)) providers = existing;
    else {
      providers = doc.createNode({}) as YAMLMap<unknown, unknown>;
      config.set("providers", providers);
    }
    for (const [route, profile] of routes) providers.set(route, doc.createNode(profile));
  }
  if (snapshot.deepseekConfig) {
    const config = ensureConfig(ensureRow(DEEPSEEK_ROW));
    for (const [key, value] of Object.entries(snapshot.deepseekConfig)) config.set(key, doc.createNode(value));
  }
  if (snapshot.defaultModel) {
    const config = ensureConfig(ensureRow(DEFAULT_MODEL_ROW));
    config.set("provider", snapshot.defaultModel.provider);
    config.set("model", snapshot.defaultModel.model);
    if (snapshot.defaultModel.reasoningEffort) config.set("reasoningEffort", snapshot.defaultModel.reasoningEffort);
    else config.delete("reasoningEffort");
  }
  const body = doc.toString({ lineWidth: 0 });
  return body.endsWith("\n") ? body : `${body}\n`;
}

/** Add the referenced credentials to a space's isolated credentials document. */
export function applySnapshotToCredentials(text: string | undefined, snapshot: MainModelSnapshot): string {
  const { doc } = parseCredentials(text, "space credentials");
  for (const [ref, value] of Object.entries(snapshot.refs)) doc.setIn(["refs", ref], value);
  for (const [key, record] of Object.entries(snapshot.records)) doc.setIn(["records", key], doc.createNode(record));
  const body = doc.toString({ lineWidth: 0 });
  return body.endsWith("\n") ? body : `${body}\n`;
}

function needsCredentials(snapshot: MainModelSnapshot): boolean {
  return Object.keys(snapshot.refs).length > 0 || Object.keys(snapshot.records).length > 0;
}

/** Read-only: what a sync would copy right now. */
export async function previewMainModelSync(input: ModelSyncInput): Promise<ModelSyncSummary> {
  const snapshot = readMainModelSnapshot(await input.dumpConfig(input.mainProfile), input.home);
  return summarizeSnapshot(input.mainProfile, snapshot);
}

/**
 * Copy once. The caller holds the Home operation lock and guarantees the
 * space is not running. Credentials are written before the patch; a failure
 * between the two writes is reported as is and nothing is rolled back.
 */
export async function syncMainModels(input: ModelSyncInput): Promise<ModelSyncSummary> {
  if (input.spaceId === "web" || input.spaceId === input.mainProfile) fail("The main space cannot be a sync target.");
  const patchPath = join(input.home, "profiles", input.spaceId, "cordis.patch.yml");
  if (!existsSync(patchPath)) fail(`The space ${input.spaceId} has no profile patch.`);
  const snapshot = readMainModelSnapshot(await input.dumpConfig(input.mainProfile), input.home);
  const patched = applySnapshotToPatch(readFileSync(patchPath, "utf8"), snapshot);
  if (needsCredentials(snapshot)) {
    const credentialsPath = join(spaceDataRoot(input.home, input.spaceId), CREDENTIALS_FILE);
    const current = existsSync(credentialsPath) ? readFileSync(credentialsPath, "utf8") : undefined;
    atomicWrite(credentialsPath, applySnapshotToCredentials(current, snapshot));
  }
  atomicWrite(patchPath, patched);
  return summarizeSnapshot(input.mainProfile, snapshot);
}

/** Job step details are public records capped at this length. */
export const MODEL_SYNC_DETAIL_MAX = 300;

/**
 * One public line for a job step: names and counts, never values. Long lists
 * fold into counts (routes first, then skip reasons, then missing keys) so the
 * line fits a job step and the skipped route names stay visible longest.
 */
export function describeModelSync(summary: ModelSyncSummary): string {
  const render = (fold: number): string => {
    const parts = [`main: ${summary.mainProfile}`];
    if (!summary.routes.length) parts.push("routes: none");
    else parts.push(fold >= 1 ? `routes: ${summary.routes.length}` : `routes: ${summary.routes.join(", ")}`);
    if (summary.deepseek) parts.push("deepseek");
    if (summary.defaultModel) parts.push(`default: ${summary.defaultModel}`);
    if (summary.credentials.length) parts.push(`credentials: ${summary.credentials.length}`);
    if (summary.skipped.length) {
      parts.push(fold >= 2
        ? `skipped: ${summary.skipped.map((skip) => skip.route).join(", ")}`
        : `skipped: ${summary.skipped.map((skip) => `${skip.route} (${skip.reason})`).join(", ")}`);
    }
    if (summary.missingCredentials.length) {
      parts.push(fold >= 3
        ? `not in main credentials file: ${summary.missingCredentials.length}`
        : `not in main credentials file: ${summary.missingCredentials.join(", ")}`);
    }
    return parts.join("; ");
  };
  for (let fold = 0; fold <= 3; fold += 1) {
    const line = render(fold);
    if (line.length <= MODEL_SYNC_DETAIL_MAX) return line;
  }
  return `${render(3).slice(0, MODEL_SYNC_DETAIL_MAX - 1)}…`;
}
