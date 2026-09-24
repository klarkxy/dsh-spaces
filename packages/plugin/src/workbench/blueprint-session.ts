/** Ephemeral blueprint UI session. Not persisted. Per-request nonces, not only the workbench cycle. */
import {
  BLUEPRINT_INPUT_ID_RE,
  BLUEPRINT_JSON_MAX_BYTES,
  BLUEPRINT_SHARE_MAX_BYTES,
  type Blueprint,
  type BlueprintInput,
  type BlueprintInputType,
  type BlueprintInputValues,
} from "../../../../src/shared/blueprint";
import type { LlmDescribeResult } from "../../../../src/shared/llm-api";
import type { WorkbenchJob } from "../../../../src/shared/workbench";
import type {
  WorkbenchProductObservation,
  WorkbenchProductRequest,
  WorkbenchProductResult,
} from "../../../../src/shared/workbench-product";
import type {
  BlueprintGenerateBindingOverride,
  BlueprintLocalObservation,
  WorkbenchBlueprintApplyOutcome,
  WorkbenchBlueprintGeneratePayload,
  WorkbenchBlueprintInspectPayload,
  WorkbenchBlueprintPreviewPayload,
  WorkbenchBlueprintSourcePayload,
} from "../../../../src/shared/workbench-blueprint";
import { localizeError, t, type WorkbenchLocale, type WorkbenchMessageKey } from "./i18n";

export const BLUEPRINT_SPACE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
export const BLUEPRINT_RESERVED_SPACE_NAMES = new Set([
  "web",
  "hub",
  "headless",
  "node_modules",
  "spaces-hub",
]);

const SHARE_PREFIX = "DSHBP1:";
const TRIM_EDGE = /^(?:[ \t\n\r])+|(?:[ \t\n\r])+$/g;
const WS_BYTES = new Set([0x09, 0x0a, 0x0d, 0x20]);

export type BlueprintMode = "use" | "generate";
export type BlueprintDecodeCode = "bom" | "utf8" | "too-large-json" | "too-large-share" | "empty";
export type BlueprintRequestStatus = "idle" | "loading" | "ready" | "error";
export type BlueprintApplyUiStatus = "idle" | "submitting" | "running" | "succeeded" | "failed";

export type BlueprintDecodeResult =
  | { ok: true; text: string; kind: "json" | "share" }
  | { ok: false; code: BlueprintDecodeCode; text?: string };

export type BlueprintListedModel = {
  connectionId: string;
  connectionName: string;
  modelId: string;
};

export type BlueprintBindingDraft = {
  pointer: string;
  id: string;
  label: string;
  type: BlueprintInputType;
  required: boolean;
  defaultText: string;
  enabled: boolean;
  detected: boolean;
};

export type BlueprintInputDraft = {
  present: boolean;
  text: string;
  booleanValue: boolean;
  model: { connectionId: string; modelId: string } | null;
};

export interface BlueprintUiState {
  mode: BlueprintMode;
  content: string;
  fileName: string | null;
  contentError: string | null;
  inspectStatus: BlueprintRequestStatus;
  inspect: WorkbenchBlueprintInspectPayload | null;
  inspectError: string | null;
  name: string;
  displayName: string;
  inputDrafts: { [id: string]: BlueprintInputDraft };
  models: BlueprintListedModel[];
  modelsStatus: BlueprintRequestStatus;
  modelsError: string | null;
  previewStatus: BlueprintRequestStatus;
  preview: WorkbenchBlueprintPreviewPayload | null;
  previewObservation: WorkbenchProductObservation | null;
  previewError: string | null;
  previewInvalid: boolean;
  applyStatus: BlueprintApplyUiStatus;
  applyJobId: string | null;
  applyPlanId: string | null;
  applyOutcome: WorkbenchBlueprintApplyOutcome | null;
  applyError: string | null;
  sourceSpaceId: string;
  sourceStatus: BlueprintRequestStatus;
  source: WorkbenchBlueprintSourcePayload | null;
  sourceObservation: WorkbenchProductObservation | null;
  sourceError: string | null;
  selectedPackages: string[];
  includePatch: boolean;
  selectedNamespaces: string[];
  bindings: BlueprintBindingDraft[];
  advanced: BlueprintBindingDraft;
  metaName: string;
  metaVersion: string;
  metaDescription: string;
  generateStatus: BlueprintRequestStatus;
  generate: WorkbenchBlueprintGeneratePayload | null;
  generateError: string | null;
  generateInvalid: boolean;
  copyError: string | null;
  downloadError: string | null;
  copied: boolean;
}

export interface BlueprintHost {
  product(request: WorkbenchProductRequest): Promise<WorkbenchProductResult>;
  submitApply(planId: string, observation: WorkbenchProductObservation): Promise<void>;
  describeLlm(): Promise<LlmDescribeResult>;
  uuid(): string;
  now(): number;
  downloadFile(fileName: string, archiveBase64: string): void;
  writeClipboard(text: string): Promise<void>;
  locale(): WorkbenchLocale;
  canMutate(): boolean;
  serviceEpoch(): string | null;
  emit(): void;
}

const REQUEST_KINDS = ["inspect", "preview", "generate", "source", "models"] as const;
type RequestKind = (typeof REQUEST_KINDS)[number];

function emptyBinding(detected: boolean): BlueprintBindingDraft {
  return {
    pointer: "",
    id: "",
    label: "",
    type: "string",
    required: false,
    defaultText: "",
    enabled: false,
    detected,
  };
}

function emptyInputDraft(): BlueprintInputDraft {
  return { present: false, text: "", booleanValue: false, model: null };
}

export function createBlueprintUiState(): BlueprintUiState {
  return {
    mode: "use",
    content: "",
    fileName: null,
    contentError: null,
    inspectStatus: "idle",
    inspect: null,
    inspectError: null,
    name: "",
    displayName: "",
    inputDrafts: {},
    models: [],
    modelsStatus: "idle",
    modelsError: null,
    previewStatus: "idle",
    preview: null,
    previewObservation: null,
    previewError: null,
    previewInvalid: false,
    applyStatus: "idle",
    applyJobId: null,
    applyPlanId: null,
    applyOutcome: null,
    applyError: null,
    sourceSpaceId: "",
    sourceStatus: "idle",
    source: null,
    sourceObservation: null,
    sourceError: null,
    selectedPackages: [],
    includePatch: false,
    selectedNamespaces: [],
    bindings: [],
    advanced: emptyBinding(false),
    metaName: "",
    metaVersion: "1.0.0",
    metaDescription: "",
    generateStatus: "idle",
    generate: null,
    generateError: null,
    generateInvalid: false,
    copyError: null,
    downloadError: null,
    copied: false,
  };
}

export function isHttpsHref(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const slice = bytes.subarray(offset, offset + chunk);
    let piece = "";
    for (let i = 0; i < slice.length; i += 1) piece += String.fromCharCode(slice[i]!);
    binary += piece;
  }
  return btoa(binary);
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function skipAsciiWs(bytes: Uint8Array, start: number): number {
  let index = start;
  while (index < bytes.length && WS_BYTES.has(bytes[index]!)) index += 1;
  return index;
}

function startsWithAscii(bytes: Uint8Array, start: number, ascii: string): boolean {
  if (start + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i += 1) {
    if (bytes[start + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function looksLikeShareBytes(bytes: Uint8Array): boolean {
  const start = skipAsciiWs(bytes, hasUtf8Bom(bytes) ? 3 : 0);
  return startsWithAscii(bytes, start, SHARE_PREFIX);
}

export function decodeBlueprintFileBytes(bytes: Uint8Array): BlueprintDecodeResult {
  const bom = hasUtf8Bom(bytes);
  const payload = bom ? bytes.subarray(3) : bytes;
  const share = looksLikeShareBytes(bytes);
  if (!share && payload.length > BLUEPRINT_JSON_MAX_BYTES) {
    return { ok: false, code: "too-large-json" };
  }
  if (share && payload.length > BLUEPRINT_SHARE_MAX_BYTES) {
    return { ok: false, code: "too-large-share" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
  } catch {
    return { ok: false, code: "utf8" };
  }
  if (bom) return { ok: false, code: "bom", text: `\uFEFF${text}` };
  return limitDecodedText(text);
}

export function limitDecodedText(text: string): BlueprintDecodeResult {
  if (text.length === 0) return { ok: false, code: "empty", text };
  if (text.charCodeAt(0) === 0xfeff) return { ok: false, code: "bom", text };
  const trimmed = text.replace(TRIM_EDGE, "");
  if (trimmed.length === 0) return { ok: false, code: "empty", text };
  if (trimmed.startsWith(SHARE_PREFIX)) {
    if (trimmed.length > BLUEPRINT_SHARE_MAX_BYTES) return { ok: false, code: "too-large-share", text };
    return { ok: true, text, kind: "share" };
  }
  if (new TextEncoder().encode(text).length > BLUEPRINT_JSON_MAX_BYTES) {
    return { ok: false, code: "too-large-json", text };
  }
  return { ok: true, text, kind: "json" };
}

export function listedProviderModels(describe: LlmDescribeResult): BlueprintListedModel[] {
  const listed: BlueprintListedModel[] = [];
  for (const connection of describe.connections) {
    if (!connection.enabled) continue;
    if (connection.auth.kind === "api-key" && connection.auth.configured !== true) continue;
    const models = connection.providerConfig.models;
    if (!Array.isArray(models)) continue;
    for (const item of models) {
      let modelId = "";
      if (typeof item === "string") modelId = item;
      else if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
        modelId = item.id;
      }
      if (!modelId) continue;
      listed.push({
        connectionId: connection.id,
        connectionName: connection.displayName,
        modelId,
      });
    }
  }
  return listed;
}

export function parseFiniteNumber(text: string): number | null {
  const raw = text.trim();
  if (raw === "") return null;
  if (raw === "+" || raw === "-" || raw === "." || raw === "-." || raw === "+.") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value;
}

export function collectBlueprintValues(
  blueprint: Blueprint | null,
  drafts: { [id: string]: BlueprintInputDraft },
): { values: BlueprintInputValues; invalidNumber: string | null } {
  const values: BlueprintInputValues = {};
  if (!blueprint) return { values, invalidNumber: null };
  for (const input of blueprint.inputs) {
    const draft = drafts[input.id];
    if (!draft || !draft.present) continue;
    if (input.type === "number") {
      if (draft.text.trim() === "") continue;
      const parsed = parseFiniteNumber(draft.text);
      if (parsed === null) return { values, invalidNumber: input.id };
      values[input.id] = parsed;
      continue;
    }
    if (input.type === "boolean") {
      values[input.id] = draft.booleanValue;
      continue;
    }
    if (input.type === "model") {
      if (!draft.model) continue;
      values[input.id] = draft.model;
      continue;
    }
    values[input.id] = draft.text;
  }
  return { values, invalidNumber: null };
}

export function validateBlueprintSpaceName(name: string): "ok" | "invalid" | "reserved" {
  if (!BLUEPRINT_SPACE_NAME_RE.test(name)) return "invalid";
  if (BLUEPRINT_RESERVED_SPACE_NAMES.has(name)) return "reserved";
  return "ok";
}

export function isBlueprintApplyOutcome(
  value: { kind: string } | null | undefined,
): value is WorkbenchBlueprintApplyOutcome {
  return value?.kind === "blueprint.apply";
}

export function blueprintHasGithub(blueprint: Blueprint | null): boolean {
  return Boolean(blueprint?.packages.some((item) => item.source.type === "github"));
}

export function previewIsExpired(expiresAt: string | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const expires = Date.parse(expiresAt);
  return !Number.isFinite(expires) || now >= expires;
}

export function previewPlanMatchesApply(ui: BlueprintUiState): boolean {
  const planId = ui.preview?.planId;
  return Boolean(planId && ui.applyPlanId === planId && ui.applyStatus !== "idle");
}

function observationOf(result: WorkbenchProductResult): WorkbenchProductObservation {
  return result.observation;
}

function pointerInputId(pointer: string, used: Set<string>): string {
  const last = pointer.split("/").filter(Boolean).pop() ?? "input";
  let slug = last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!BLUEPRINT_INPUT_ID_RE.test(slug)) slug = `local-${slug.replace(/[^a-z0-9-]/g, "")}`.replace(/-+$/g, "");
  if (!BLUEPRINT_INPUT_ID_RE.test(slug)) slug = "local-input";
  let candidate = slug;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${slug}-${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

function conversionDraftsFromObservations(items: BlueprintLocalObservation[]): BlueprintBindingDraft[] {
  const used = new Set<string>();
  const drafts: BlueprintBindingDraft[] = [];
  for (const item of items) {
    if (item.kind !== "directory") continue;
    drafts.push({
      pointer: item.pointer,
      id: pointerInputId(item.pointer, used),
      label: item.reason,
      type: "directory",
      required: true,
      defaultText: "",
      enabled: false,
      detected: true,
    });
  }
  return drafts;
}

function draftsForBlueprint(
  blueprint: Blueprint,
  previous: { [id: string]: BlueprintInputDraft },
): { [id: string]: BlueprintInputDraft } {
  const next: { [id: string]: BlueprintInputDraft } = {};
  for (const input of blueprint.inputs) {
    next[input.id] = previous[input.id] ?? emptyInputDraft();
  }
  return next;
}

export class BlueprintSession {
  private snapshot: BlueprintUiState = createBlueprintUiState();
  private readonly seq: Record<RequestKind, number> = {
    inspect: 0,
    preview: 0,
    generate: 0,
    source: 0,
    models: 0,
  };
  private readonly controllers: Record<RequestKind, AbortController> = {
    inspect: new AbortController(),
    preview: new AbortController(),
    generate: new AbortController(),
    source: new AbortController(),
    models: new AbortController(),
  };

  constructor(private readonly host: BlueprintHost) {}

  getSnapshot = (): BlueprintUiState => this.snapshot;

  abortPending = (): void => {
    for (const kind of REQUEST_KINDS) this.begin(kind);
  };

  setMode = (mode: BlueprintMode): void => {
    if (this.snapshot.mode === mode) return;
    if (mode === "use") {
      this.begin("source");
      this.begin("generate");
    } else {
      this.begin("inspect");
      this.begin("preview");
      this.begin("models");
    }
    this.patch({ mode, copyError: null, downloadError: null, copied: false });
    if (mode === "generate" && this.snapshot.sourceSpaceId) void this.loadSource();
  };

  setContent = (content: string): void => {
    this.begin("inspect");
    this.begin("preview");
    this.patch({
      content,
      contentError: null,
      inspectStatus: "idle",
      inspect: null,
      inspectError: null,
      previewStatus: "idle",
      preview: null,
      previewObservation: null,
      previewError: null,
      previewInvalid: true,
      applyError: null,
    });
  };

  readFileBytes = (bytes: Uint8Array, fileName: string): void => {
    const decoded = decodeBlueprintFileBytes(bytes);
    if (!decoded.ok) {
      this.begin("inspect");
      this.begin("preview");
      this.patch({
        fileName,
        content: decoded.text ?? this.snapshot.content,
        contentError: this.msg(this.decodeKey(decoded.code)),
        inspectStatus: "idle",
        inspect: null,
        inspectError: null,
        preview: null,
        previewObservation: null,
        previewStatus: "idle",
        previewInvalid: true,
      });
      return;
    }
    this.begin("inspect");
    this.begin("preview");
    this.patch({
      fileName,
      content: decoded.text,
      contentError: null,
      inspectStatus: "idle",
      inspect: null,
      inspectError: null,
      preview: null,
      previewObservation: null,
      previewStatus: "idle",
      previewInvalid: true,
    });
  };

  setName = (name: string): void => {
    this.invalidatePreview();
    this.patch({ name });
  };

  setDisplayName = (displayName: string): void => {
    this.invalidatePreview();
    this.patch({ displayName });
  };

  setStringInput = (id: string, text: string): void => {
    this.writeDraft(id, { present: true, text });
  };

  setBooleanInput = (id: string, value: boolean): void => {
    this.writeDraft(id, { present: true, booleanValue: value });
  };

  setModelInput = (id: string, connectionId: string, modelId: string): void => {
    this.writeDraft(id, { present: true, model: { connectionId, modelId } });
  };

  unsetInput = (id: string): void => {
    this.writeDraft(id, { present: false, text: "", booleanValue: false, model: null });
  };

  inspect = (): void => {
    const limited = limitDecodedText(this.snapshot.content);
    if (!limited.ok) {
      this.patch({ contentError: this.msg(this.decodeKey(limited.code)), inspectStatus: "idle" });
      return;
    }
    const content = this.snapshot.content;
    const { token, signal } = this.begin("inspect");
    const epoch = this.host.serviceEpoch();
    this.patch({
      inspectStatus: "loading",
      inspectError: null,
      contentError: null,
      preview: null,
      previewObservation: null,
      previewInvalid: true,
    });
    void this.run("inspect", token, signal, async () => {
      const result = await this.host.product({ method: "blueprint.inspect", content });
      if (this.stale("inspect", token, signal)) return;
      if (this.snapshot.mode !== "use") return;
      if (this.snapshot.content !== content) return;
      if (epoch && this.host.serviceEpoch() && epoch !== this.host.serviceEpoch()) return;
      if (result.method !== "blueprint.inspect") {
        this.patch({ inspectStatus: "error", inspect: null, inspectError: this.mismatch("blueprint.inspect", result.method) });
        return;
      }
      this.patch({
        inspectStatus: "ready",
        inspect: result,
        inspectError: null,
        inputDrafts: draftsForBlueprint(result.blueprint, this.snapshot.inputDrafts),
        preview: null,
        previewObservation: null,
        previewStatus: "idle",
        previewInvalid: true,
      });
      if (result.blueprint.inputs.some((input) => input.type === "model")) void this.loadModels();
    });
  };

  preview = (): void => {
    if (!this.host.canMutate()) {
      this.patch({ previewError: this.msg("app.readOnlyError"), previewStatus: "idle" });
      return;
    }
    const inspect = this.snapshot.inspect;
    if (!inspect) {
      this.patch({ previewError: this.msg("blueprints.needInspect") });
      return;
    }
    const name = this.snapshot.name.trim().toLowerCase();
    const nameState = validateBlueprintSpaceName(name);
    if (nameState !== "ok") {
      this.patch({
        previewError: this.msg(nameState === "reserved" ? "app.nameReserved" : "app.nameInvalid"),
      });
      return;
    }
    const collected = collectBlueprintValues(inspect.blueprint, this.snapshot.inputDrafts);
    if (collected.invalidNumber) {
      this.patch({ previewError: this.msg("blueprints.invalidNumber") });
      return;
    }
    const content = this.snapshot.content;
    const displayName = this.snapshot.displayName.trim();
    const values = collected.values;
    const { token, signal } = this.begin("preview");
    const epoch = this.host.serviceEpoch();
    this.patch({ previewStatus: "loading", previewError: null, previewInvalid: false });
    void this.run("preview", token, signal, async () => {
      const request: WorkbenchProductRequest = {
        method: "blueprint.preview",
        content,
        name,
        ...(displayName ? { displayName: displayName.slice(0, 80) } : {}),
        values,
      };
      const result = await this.host.product(request);
      if (this.stale("preview", token, signal)) return;
      if (this.snapshot.mode !== "use") return;
      if (this.snapshot.content !== content || this.snapshot.name.trim().toLowerCase() !== name) return;
      if (this.snapshot.displayName.trim() !== displayName) return;
      const latest = collectBlueprintValues(this.snapshot.inspect?.blueprint ?? inspect.blueprint, this.snapshot.inputDrafts);
      if (latest.invalidNumber || JSON.stringify(latest.values) !== JSON.stringify(values)) return;
      if (epoch && this.host.serviceEpoch() && epoch !== this.host.serviceEpoch()) return;
      if (result.method !== "blueprint.preview") {
        this.patch({ previewStatus: "error", preview: null, previewObservation: null, previewError: this.mismatch("blueprint.preview", result.method) });
        return;
      }
      this.patch({
        previewStatus: "ready",
        preview: result,
        previewObservation: observationOf(result),
        previewError: null,
        previewInvalid: false,
        applyError: null,
      });
    });
  };

  apply = (): void => {
    if (this.snapshot.applyStatus === "submitting" || this.snapshot.applyStatus === "running") return;
    if (previewPlanMatchesApply(this.snapshot)) return;
    if (!this.host.canMutate()) {
      this.patch({ applyError: this.msg("app.readOnlyError") });
      return;
    }
    const preview = this.snapshot.preview;
    const observation = this.snapshot.previewObservation;
    if (!preview || !observation || this.snapshot.previewInvalid) {
      this.patch({ applyError: this.msg("blueprints.needPreview") });
      return;
    }
    if (!preview.planId || preview.missingInputs.length > 0) {
      this.patch({ applyError: this.msg("blueprints.needPlan") });
      return;
    }
    if (previewIsExpired(preview.expiresAt, this.host.now())) {
      this.patch({ applyError: this.msg("blueprints.previewExpired"), previewInvalid: true });
      return;
    }
    const liveEpoch = this.host.serviceEpoch();
    if (liveEpoch && liveEpoch !== observation.serviceEpoch) {
      this.patch({ applyError: this.msg("blueprints.epochChanged"), previewInvalid: true });
      return;
    }
    const planId = preview.planId;
    this.patch({
      applyStatus: "submitting",
      applyPlanId: planId,
      applyError: null,
      applyOutcome: null,
      applyJobId: null,
    });
    void this.host.submitApply(planId, observation).then(
      () => {
        if (this.snapshot.applyPlanId !== planId) return;
        if (this.snapshot.applyStatus === "submitting") this.patch({ applyStatus: "running" });
      },
      (error: unknown) => {
        if (this.snapshot.applyPlanId !== planId) return;
        this.patch({
          applyStatus: "failed",
          applyError: error instanceof Error ? error.message : this.msg("app.genericError"),
        });
      },
    );
  };

  onApplyJob = (job: WorkbenchJob): void => {
    if (job.kind !== "blueprint.apply") return;
    if (this.snapshot.applyJobId && this.snapshot.applyJobId !== job.id) return;
    if (!this.snapshot.applyPlanId && this.snapshot.applyStatus === "idle") return;
    const active = job.status === "queued" || job.status === "running";
    const product = job.result?.product;
    const outcome = isBlueprintApplyOutcome(product) ? product : this.snapshot.applyOutcome;
    if (active) {
      this.patch({
        applyStatus: "running",
        applyJobId: job.id,
        applyOutcome: outcome,
      });
      return;
    }
    if (job.status === "succeeded") {
      this.patch({
        applyStatus: "succeeded",
        applyJobId: job.id,
        applyOutcome: outcome,
        applyError: null,
      });
      return;
    }
    this.patch({
      applyStatus: "failed",
      applyJobId: job.id,
      applyOutcome: outcome,
      applyError: job.error?.message || job.message || this.msg("jobs.failed"),
    });
  };

  cancelStaged = (): void => {
    this.begin("preview");
    this.patch({
      previewStatus: "idle",
      preview: null,
      previewObservation: null,
      previewError: null,
      previewInvalid: false,
      applyStatus: this.snapshot.applyStatus === "running" || this.snapshot.applyStatus === "submitting"
        ? this.snapshot.applyStatus
        : "idle",
      applyError: this.snapshot.applyStatus === "running" || this.snapshot.applyStatus === "submitting"
        ? this.snapshot.applyError
        : null,
      applyOutcome:
        this.snapshot.applyStatus === "running" || this.snapshot.applyStatus === "submitting"
          ? this.snapshot.applyOutcome
          : null,
    });
  };

  openGenerate = (spaceId: string): void => {
    if (!spaceId || spaceId === "web") return;
    this.begin("generate");
    this.patch({
      mode: "generate",
      sourceSpaceId: spaceId,
      generate: null,
      generateStatus: "idle",
      generateInvalid: true,
      copied: false,
      copyError: null,
      downloadError: null,
    });
    void this.loadSource();
  };

  setSourceSpaceId = (sourceSpaceId: string): void => {
    this.begin("source");
    this.begin("generate");
    this.patch({
      sourceSpaceId,
      source: null,
      sourceObservation: null,
      sourceStatus: "idle",
      sourceError: null,
      selectedPackages: [],
      includePatch: false,
      selectedNamespaces: [],
      bindings: [],
      generate: null,
      generateStatus: "idle",
      generateInvalid: true,
      copied: false,
    });
    if (sourceSpaceId) void this.loadSource();
  };

  setPackageSelected = (name: string, selected: boolean): void => {
    const selectedPackages = selected
      ? [...new Set([...this.snapshot.selectedPackages, name])]
      : this.snapshot.selectedPackages.filter((item) => item !== name);
    this.invalidateGenerate();
    this.patch({ selectedPackages });
  };

  setIncludePatch = (includePatch: boolean): void => {
    this.invalidateGenerate();
    this.patch({ includePatch });
  };

  setNamespaceSelected = (namespace: string, selected: boolean): void => {
    const selectedNamespaces = selected
      ? [...new Set([...this.snapshot.selectedNamespaces, namespace])]
      : this.snapshot.selectedNamespaces.filter((item) => item !== namespace);
    this.invalidateGenerate();
    this.patch({ selectedNamespaces });
  };

  setBinding = (index: number, patch: Partial<BlueprintBindingDraft>): void => {
    const bindings = this.snapshot.bindings.map((row, rowIndex) =>
      rowIndex === index ? this.normalizeBinding({ ...row, ...patch }) : row,
    );
    this.invalidateGenerate();
    this.patch({ bindings });
  };

  setAdvanced = (patch: Partial<BlueprintBindingDraft>): void => {
    this.invalidateGenerate();
    this.patch({ advanced: this.normalizeBinding({ ...this.snapshot.advanced, ...patch, detected: false }) });
  };

  setMetaName = (metaName: string): void => {
    this.invalidateGenerate();
    this.patch({ metaName });
  };

  setMetaVersion = (metaVersion: string): void => {
    this.invalidateGenerate();
    this.patch({ metaVersion });
  };

  setMetaDescription = (metaDescription: string): void => {
    this.invalidateGenerate();
    this.patch({ metaDescription });
  };

  loadSource = (): void => {
    const spaceId = this.snapshot.sourceSpaceId;
    if (!spaceId || spaceId === "web") {
      this.patch({ sourceError: this.msg("blueprints.needSource"), sourceStatus: "idle" });
      return;
    }
    const { token, signal } = this.begin("source");
    const epoch = this.host.serviceEpoch();
    this.patch({ sourceStatus: "loading", sourceError: null });
    void this.run("source", token, signal, async () => {
      const result = await this.host.product({ method: "blueprint.source", spaceId });
      if (this.stale("source", token, signal)) return;
      if (this.snapshot.mode !== "generate") return;
      if (this.snapshot.sourceSpaceId !== spaceId) return;
      if (epoch && this.host.serviceEpoch() && epoch !== this.host.serviceEpoch()) return;
      if (result.method !== "blueprint.source") {
        this.patch({
          sourceStatus: "error",
          source: null,
          sourceObservation: null,
          sourceError: this.mismatch("blueprint.source", result.method),
        });
        return;
      }
      const bindings = conversionDraftsFromObservations(result.localObservations);
      const selectedPackages = result.packages
        .filter((item) => item.eligibility.available)
        .map((item) => item.name);
      const selectedNamespaces = result.settingsNamespaces
        .filter((item) => item.eligible && item.shareable)
        .map((item) => item.namespace);
      this.patch({
        sourceStatus: "ready",
        source: result,
        sourceObservation: observationOf(result),
        sourceError: null,
        selectedPackages,
        includePatch: result.patch.exists && result.patch.shareable,
        selectedNamespaces,
        bindings,
        generate: null,
        generateInvalid: true,
        metaName: this.snapshot.metaName || spaceId,
      });
    });
  };

  generate = (): void => {
    const source = this.snapshot.source;
    const spaceId = this.snapshot.sourceSpaceId;
    if (!source || !spaceId) {
      this.patch({ generateError: this.msg("blueprints.needSource") });
      return;
    }
    const name = this.snapshot.metaName.trim();
    const version = this.snapshot.metaVersion.trim();
    if (!name || !version) {
      this.patch({ generateError: this.msg("blueprints.needMeta") });
      return;
    }
    const description = this.snapshot.metaDescription.trim();
    const bindingOverrides = this.collectBindingOverrides();
    const selection = {
      packages: [...this.snapshot.selectedPackages],
      includePatch: this.snapshot.includePatch,
      settingsNamespaces: [...this.snapshot.selectedNamespaces],
    };
    const { token, signal } = this.begin("generate");
    const epoch = this.host.serviceEpoch();
    this.patch({ generateStatus: "loading", generateError: null, copied: false, copyError: null, downloadError: null });
    void this.run("generate", token, signal, async () => {
      const result = await this.host.product({
        method: "blueprint.generate",
        spaceId,
        selection,
        metadata: {
          name,
          version,
          ...(description ? { description } : {}),
        },
        ...(bindingOverrides.length > 0 ? { bindingOverrides } : {}),
      });
      if (this.stale("generate", token, signal)) return;
      if (this.snapshot.mode !== "generate") return;
      if (this.snapshot.sourceSpaceId !== spaceId) return;
      if (this.snapshot.metaName.trim() !== name || this.snapshot.metaVersion.trim() !== version) return;
      if (JSON.stringify(this.snapshot.selectedPackages) !== JSON.stringify(selection.packages)) return;
      if (this.snapshot.includePatch !== selection.includePatch) return;
      if (JSON.stringify(this.snapshot.selectedNamespaces) !== JSON.stringify(selection.settingsNamespaces)) return;
      if (epoch && this.host.serviceEpoch() && epoch !== this.host.serviceEpoch()) return;
      if (result.method !== "blueprint.generate") {
        this.patch({ generateStatus: "error", generate: null, generateError: this.mismatch("blueprint.generate", result.method) });
        return;
      }
      this.patch({
        generateStatus: "ready",
        generate: result,
        generateError: null,
        generateInvalid: false,
      });
    });
  };

  copyShareCode = (): void => {
    const generate = this.snapshot.generate;
    if (!generate || this.snapshot.generateInvalid) return;
    const text = generate.shareCode;
    void this.host.writeClipboard(text).then(
      () => {
        if (this.snapshot.generate?.shareCode !== text) return;
        this.patch({ copied: true, copyError: null });
      },
      () => {
        this.patch({ copied: false, copyError: this.msg("blueprints.copyFailed") });
      },
    );
  };

  saveJson = (): void => {
    const generate = this.snapshot.generate;
    if (!generate || this.snapshot.generateInvalid) return;
    try {
      this.host.downloadFile(generate.fileName, utf8ToBase64(generate.json));
      this.patch({ downloadError: null });
    } catch {
      this.patch({ downloadError: this.msg("blueprints.downloadFailed") });
    }
  };

  onServiceEpoch = (epoch: string): void => {
    const previewEpoch = this.snapshot.previewObservation?.serviceEpoch;
    if (previewEpoch && previewEpoch !== epoch) {
      this.begin("preview");
      this.patch({ previewInvalid: true, applyError: this.snapshot.applyStatus === "idle" ? this.msg("blueprints.epochChanged") : this.snapshot.applyError });
    }
    const sourceEpoch = this.snapshot.sourceObservation?.serviceEpoch;
    if (sourceEpoch && sourceEpoch !== epoch) {
      this.begin("source");
      this.begin("generate");
      this.patch({ generateInvalid: true });
    }
  };

  canApply(): boolean {
    const preview = this.snapshot.preview;
    if (!preview || this.snapshot.previewInvalid || !this.snapshot.previewObservation) return false;
    if (!preview.planId || preview.missingInputs.length > 0) return false;
    if (previewIsExpired(preview.expiresAt, this.host.now())) return false;
    if (this.snapshot.applyStatus === "submitting" || this.snapshot.applyStatus === "running") return false;
    if (previewPlanMatchesApply(this.snapshot)) return false;
    return true;
  }

  private loadModels(): void {
    const { token, signal } = this.begin("models");
    this.patch({ modelsStatus: "loading", modelsError: null });
    void this.run("models", token, signal, async () => {
      const describe = await this.host.describeLlm();
      if (this.stale("models", token, signal)) return;
      if (this.snapshot.mode !== "use") return;
      this.patch({
        models: listedProviderModels(describe),
        modelsStatus: "ready",
        modelsError: null,
      });
    });
  }

  private collectBindingOverrides(): BlueprintGenerateBindingOverride[] {
    const rows = [...this.snapshot.bindings, this.snapshot.advanced];
    const overrides: BlueprintGenerateBindingOverride[] = [];
    for (const row of rows) {
      if (!row.enabled) continue;
      if (!row.pointer.startsWith("/profile/")) continue;
      if (!BLUEPRINT_INPUT_ID_RE.test(row.id)) continue;
      const input: BlueprintInput = {
        id: row.id,
        type: row.type,
        label: row.label.trim() || row.id,
        required: row.required,
      };
      if (row.type !== "directory" && row.type !== "model" && row.defaultText !== "") {
        if (row.type === "number") {
          const parsed = parseFiniteNumber(row.defaultText);
          if (parsed === null) continue;
          input.default = parsed;
        } else if (row.type === "boolean") {
          input.default = row.defaultText === "true";
        } else {
          input.default = row.defaultText;
        }
      }
      overrides.push({ pointer: row.pointer, input });
    }
    return overrides;
  }

  private normalizeBinding(row: BlueprintBindingDraft): BlueprintBindingDraft {
    const type = row.type;
    const defaultText = type === "directory" || type === "model" ? "" : row.defaultText;
    return { ...row, type, defaultText };
  }

  private writeDraft(id: string, patch: Partial<BlueprintInputDraft>): void {
    const current = this.snapshot.inputDrafts[id] ?? emptyInputDraft();
    this.invalidatePreview();
    this.patch({
      inputDrafts: { ...this.snapshot.inputDrafts, [id]: { ...current, ...patch } },
    });
  }

  private invalidatePreview(): void {
    this.begin("preview");
    this.patch({
      previewInvalid: true,
      preview: this.snapshot.preview,
      previewError: this.snapshot.preview ? this.msg("blueprints.previewExpired") : this.snapshot.previewError,
    });
  }

  private invalidateGenerate(): void {
    this.begin("generate");
    this.patch({
      generateInvalid: true,
      generate: null,
      copied: false,
      copyError: null,
      downloadError: null,
    });
  }

  private decodeKey(code: BlueprintDecodeCode): WorkbenchMessageKey {
    if (code === "bom") return "blueprints.bom";
    if (code === "utf8") return "blueprints.utf8";
    if (code === "too-large-json") return "blueprints.tooLargeJson";
    if (code === "too-large-share") return "blueprints.tooLargeShare";
    return "blueprints.empty";
  }

  private begin(kind: RequestKind): { token: number; signal: AbortSignal } {
    this.controllers[kind].abort();
    this.controllers[kind] = new AbortController();
    const token = this.seq[kind] + 1;
    this.seq[kind] = token;
    return { token, signal: this.controllers[kind].signal };
  }

  private stale(kind: RequestKind, token: number, signal: AbortSignal): boolean {
    return signal.aborted || token !== this.seq[kind];
  }

  private async run(kind: RequestKind, token: number, signal: AbortSignal, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (this.stale(kind, token, signal)) return;
      const message = this.hostError(error);
      if (kind === "inspect") this.patch({ inspectStatus: "error", inspectError: message });
      else if (kind === "preview") this.patch({ previewStatus: "error", previewError: message });
      else if (kind === "generate") this.patch({ generateStatus: "error", generateError: message });
      else if (kind === "source") this.patch({ sourceStatus: "error", sourceError: message });
      else this.patch({ modelsStatus: "error", modelsError: message, models: [] });
    }
  }

  private hostError(error: unknown): string {
    if (error && typeof error === "object") {
      const record = error as { code?: unknown; message?: unknown };
      return localizeError(this.host.locale(), {
        code: typeof record.code === "string" ? record.code : null,
        message: typeof record.message === "string" ? record.message : null,
      });
    }
    return this.msg("app.genericError");
  }

  private mismatch(expected: string, actual: string): string {
    return localizeError(this.host.locale(), {
      code: "workbench/unavailable",
      message: `Expected ${expected}, received ${actual}.`,
    });
  }

  private msg(key: WorkbenchMessageKey): string {
    return t(this.host.locale(), key);
  }

  private patch(partial: Partial<BlueprintUiState>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.host.emit();
  }
}
