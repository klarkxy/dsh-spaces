import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { decode, encode } from "@klarkxy/dsh-blueprint/codec";
import type { BlueprintDocument } from "@klarkxy/dsh-blueprint/document";
import type { WorkbenchProductRequest, WorkbenchProductResult } from "../../src/shared/workbench-product.ts";
import type { WorkbenchBlueprintApplyOutcome, WorkbenchBlueprintSourcePayload } from "../../src/shared/workbench-blueprint.ts";
import type { WorkbenchApi, WorkbenchJob, WorkbenchState } from "../../src/shared/workbench.ts";
import { BLUEPRINT_JSON_MAX_BYTES, BLUEPRINT_SHARE_MAX_BYTES, type Blueprint } from "@klarkxy/dsh-blueprint/v1/types";
import { BlueprintSession, decodeBlueprintFileBytes, limitDecodedText, type BlueprintHost } from "../../packages/plugin/src/workbench/blueprint-session.ts";
import { BlueprintsPage } from "../../packages/plugin/src/workbench/blueprint/page.tsx";
import { WorkbenchView } from "../../packages/plugin/src/workbench/components.tsx";
import { WorkbenchController } from "../../packages/plugin/src/workbench/store.ts";
import { t } from "../../packages/plugin/src/workbench/i18n.ts";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const observation = { serviceEpoch: "aa".repeat(32), expectedRevision: "bb".repeat(32) };
const hostVersions = { dsh: "0.2.0-rc.2", spaces: "0.4.0", node: "24.0.0", os: "win32", arch: "x64", base: "0.2.0-rc.2", webApp: "0.2.0-rc.2" };
const v2: BlueprintDocument = {
  kind: "dsh-blueprint", formatVersion: 2, metadata: { name: "组合" },
  packages: [
    { name: "@example/tool", version: "1.2.3", source: "npm" },
    { name: "@deepseek-ai/dsh-fs", version: "0.2.0-rc.2", source: "builtin" },
  ], bundles: ["@deepseek-ai/dsh-fs", "@example/tool"],
};
const v1: Blueprint = {
  kind: "dsh-blueprint", formatVersion: 1, metadata: { name: "预设", version: "3.0.0" },
  packages: [{ name: "@example/tool", version: "1.2.3", source: { type: "npm" } }],
  profile: { base: "web", bundles: ["@example/tool"], patch: [{ id: "example-tool", config: { model: null } }], settings: {} },
  inputs: [{ id: "local-model", type: "model", label: "Model", required: true }],
  bindings: [{ input: "local-model", target: { kind: "default-model" } }], relations: [],
};
const source: WorkbenchBlueprintSourcePayload = {
  method: "blueprint.source", spaceId: "alpha",
  packages: v2.packages.map((item) => ({ ...item, inBundles: true, hasBundlePatch: true, eligibility: { available: true }, lifecycleScripts: [] })),
  bundles: [{ name: "@deepseek-ai/dsh-fs", order: 0, eligible: true }, { name: "@example/tool", order: 1, eligible: true }],
  patch: { exists: true, shareable: true }, settingsNamespaces: [{ namespace: "tool", eligible: true, shareable: true, convertible: true }],
  localObservations: [{ kind: "directory", pointer: "/profile/patch/0/config/path", reason: "local path" }], host: hostVersions,
};

function harness(product?: (request: WorkbenchProductRequest) => Promise<WorkbenchProductResult>, hostOverrides: Partial<BlueprintHost> = {}) {
  const requests: WorkbenchProductRequest[] = [];
  const applies: string[] = [];
  const downloads: string[] = [];
  const copies: string[] = [];
  const host: BlueprintHost = {
    product: async (request) => {
      requests.push(request);
      if (product) return product(request);
      if (request.method === "blueprint.source") return { ...source, observation };
      if (request.method === "blueprint.inspect") return { method: request.method, blueprint: v2, diagnostics: [], observation };
      if (request.method === "blueprint.generate") return {
        method: request.method, blueprint: v2, json: JSON.stringify(v2), shareCode: encode(v2), fileName: "combo.json", diagnostics: [], observation,
      };
      if (request.method === "blueprint.preview") return {
        method: request.method, blueprint: v2, packages: [], inputs: [], missingInputs: [], diagnostics: [], host: hostVersions,
        planId: "plan-v2", expiresAt: "2099-01-01T00:00:00Z", observation,
      };
      throw new Error(request.method);
    },
    submitApply: async (planId) => { applies.push(planId); },
    uuid: () => "test", now: () => 0, downloadFile: (name) => { downloads.push(name); },
    writeClipboard: async (value) => { copies.push(value); }, locale: () => "zh", canMutate: () => true,
    serviceEpoch: () => observation.serviceEpoch, emit: () => undefined,
    ...hostOverrides,
  };
  const session = new BlueprintSession(host);
  const controller = { blueprint: session, canMutate: () => true } as WorkbenchController;
  const html = () => renderToStaticMarkup(<BlueprintsPage locale="zh" ui={session.getSnapshot()} controller={controller} spaces={[]} />);
  return { session, requests, applies, downloads, copies, html };
}

test("v2 file and paste detection use the share byte limit and retain malformed input", () => {
  const text = "DSHBP2:" + "a".repeat(BLUEPRINT_JSON_MAX_BYTES);
  assert.equal(decodeBlueprintFileBytes(new TextEncoder().encode(text)).ok, true);
  const atLimit = "DSHBP2:" + "a".repeat(BLUEPRINT_SHARE_MAX_BYTES - "DSHBP2:".length);
  assert.equal(decodeBlueprintFileBytes(new TextEncoder().encode(atLimit)).ok, true);
  assert.deepEqual(decodeBlueprintFileBytes(new TextEncoder().encode(atLimit + "a")), { ok: false, code: "too-large-share" });
  assert.deepEqual(limitDecodedText("DSHBP2:" + "a".repeat(BLUEPRINT_SHARE_MAX_BYTES)), {
    ok: false, code: "too-large-share", text: "DSHBP2:" + "a".repeat(BLUEPRINT_SHARE_MAX_BYTES),
  });
  assert.equal(limitDecodedText("DSHBP2:" + "中".repeat(BLUEPRINT_SHARE_MAX_BYTES / 2)).ok, false);
  assert.deepEqual(decodeBlueprintFileBytes(new TextEncoder().encode("DSHBP2:!")), { ok: true, text: "DSHBP2:!", kind: "share" });
  assert.equal(decodeBlueprintFileBytes(new TextEncoder().encode("\uFEFFDSHBP2:!")).ok, false);
  assert.deepEqual(decodeBlueprintFileBytes(Uint8Array.of(0xff)), { ok: false, code: "utf8" });
});

test("default v2 generation excludes preset drafts and shares a standalone-compatible document", async () => {
  const h = harness();
  h.session.openGenerate("alpha"); await flush();
  assert.equal(h.session.getSnapshot().formatVersion, 2);
  h.session.generate(); await flush();
  const request = h.requests.find((item) => item.method === "blueprint.generate");
  assert.ok(request?.method === "blueprint.generate");
  assert.equal(request.formatVersion, 2);
  assert.deepEqual(request.selection, { packages: ["@example/tool", "@deepseek-ai/dsh-fs"], includePatch: false, settingsNamespaces: [] });
  assert.equal(request.metadata.version, undefined);
  assert.equal(request.bindingOverrides, undefined);
  assert.deepEqual(decode(h.session.getSnapshot().generate!.shareCode), v2);
  assert.ok(h.html().includes(t("zh", "blueprints.pluginCombination")));
  assert.match(h.html(), /data-blueprint-share-code="true" style="overflow-wrap:anywhere;white-space:pre-wrap;min-width:0"/);
  assert.ok(h.html().includes(h.session.getSnapshot().generate!.shareCode));
  assert.equal(h.html().includes(t("zh", "blueprints.advancedPointer")), false);
  h.session.copyShareCode(); h.session.saveJson(); await flush();
  assert.deepEqual(h.copies.map(decode), [v2]);
  assert.deepEqual(h.downloads, ["combo.json"]);
});

test("legacy export retains preset drafts and excludes builtin packages visibly", async () => {
  const h = harness(); h.session.openGenerate("alpha"); await flush();
  h.session.setFormatVersion(1); h.session.setMetaVersion("3.0.0");
  h.session.setBinding(0, { enabled: true });
  h.session.generate(); await flush();
  const request = h.requests.find((item) => item.method === "blueprint.generate");
  assert.ok(request?.method === "blueprint.generate");
  assert.deepEqual(request.selection, { packages: ["@example/tool"], includePatch: true, settingsNamespaces: ["tool"] });
  assert.equal(request.metadata.version, "3.0.0");
  assert.equal(request.bindingOverrides?.length, 1);
  assert.ok(h.html().includes(t("zh", "blueprints.builtinV2Only")));
  h.session.setFormatVersion(2);
  assert.equal(h.session.getSnapshot().generate, null);
  h.session.setFormatVersion(1);
  assert.equal(h.session.getSnapshot().includePatch, true);
  assert.deepEqual(h.session.getSnapshot().selectedNamespaces, ["tool"]);
  assert.equal(h.session.getSnapshot().bindings[0]?.enabled, true);
});

test("late generation cannot publish output after format changes", async () => {
  let resolve!: (result: WorkbenchProductResult) => void;
  const h = harness(async (request) => {
    if (request.method === "blueprint.source") return { ...source, observation };
    return new Promise((done) => { resolve = done; });
  });
  h.session.openGenerate("alpha"); await flush(); h.session.generate();
  h.session.setFormatVersion(1);
  resolve({ method: "blueprint.generate", blueprint: v2, json: JSON.stringify(v2), shareCode: encode(v2), fileName: "combo.json", diagnostics: [], observation });
  await flush();
  assert.equal(h.session.getSnapshot().generate, null);
  assert.equal(h.session.getSnapshot().generateStatus, "idle");
  h.session.copyShareCode(); h.session.saveJson();
  assert.deepEqual(h.copies, []); assert.deepEqual(h.downloads, []);
});

test("v2 import renders builtin sources without an invented version and creates only after preview", async () => {
  const h = harness(); h.session.setContent(encode(v2)); h.session.inspect(); await flush();
  const page = h.html();
  assert.ok(page.includes("builtin")); assert.ok(page.includes("0.2.0-rc.2"));
  assert.equal(page.includes(`<dt>${t("zh", "blueprints.version")}</dt>`), false);
  assert.equal(page.includes("data-blueprint-input="), false);
  h.session.setName("from-blueprint"); h.session.preview(); await flush();
  const request = h.requests.find((item) => item.method === "blueprint.preview");
  assert.ok(request?.method === "blueprint.preview"); assert.deepEqual(request.values, {});
  assert.deepEqual(h.applies, []);
  h.session.apply(); await flush(); h.session.apply();
  assert.deepEqual(h.applies, ["plan-v2"]);
});

test("v1 import continues to collect receiver-local model inputs", async () => {
  const h = harness(async () => ({ method: "blueprint.inspect", blueprint: v1, diagnostics: [], observation }));
  h.session.setContent(JSON.stringify(v1)); h.session.inspect(); await flush();
  h.session.setName("legacy"); h.session.setModelInput("local-model", "connection", "model"); h.session.preview(); await flush();
  const request = h.requests.find((item) => item.method === "blueprint.preview");
  assert.ok(request?.method === "blueprint.preview");
  assert.deepEqual(request.values, { "local-model": { connectionId: "connection", modelId: "model" } });
  assert.ok(h.html().includes("3.0.0"));
});

test("Spaces management exposes blueprint creation and the controller opens use mode", async () => {
  const state: WorkbenchState = {
    protocolVersion: 2, ...observation, revision: observation.expectedRevision, availability: "ready", role: "manager", managerId: "hub",
    owner: { kind: "web", since: "2026-10-09T00:00:00Z" }, writable: true, mode: "verified-full", dshVersion: "0.2.0-rc.2",
    maintenance: false, reasons: [], spaces: [], jobs: [],
  };
  const controller = new WorkbenchController({ state: async () => state } as unknown as WorkbenchApi, {
    uuid: () => "test", now: () => 0, storage: { getItem: () => null, setItem: () => undefined }, hidden: () => false,
    onVisibilityChange: () => () => undefined, addMessageListener: () => () => undefined, openUrl: () => undefined,
  });
  try {
    await controller.poll(); controller.setHomeTab("spaces");
    const html = renderToStaticMarkup(<WorkbenchView ui={controller.getSnapshot()} controller={controller} />);
    assert.ok(html.includes(t("zh", "blueprints.createFrom")));
    controller.blueprint.setMode("generate"); controller.openBlueprintUse();
    assert.equal(controller.getSnapshot().settingsTab, "blueprints");
    assert.equal(controller.getSnapshot().blueprint.mode, "use");
    assert.equal(controller.getSnapshot().selected, "home");
  } finally { controller.stop(); }
});

test("a second apply tracks its request through tab changes and polling historical success before the submit response", async () => {
  let jobs: WorkbenchJob[] = [];
  let requestNumber = 0;
  let finishSubmit!: (job: WorkbenchJob) => void;
  let pendingFailure!: WorkbenchJob;
  const outcome = (spaceId: string, failed = false): WorkbenchBlueprintApplyOutcome => ({
    kind: "blueprint.apply", spaceId,
    stages: { "space-create": { status: "succeeded" }, packages: { status: failed ? "failed" : "succeeded", ...(failed ? { error: "Package installation failed." } : {}) }, presets: { status: failed ? "not-run" : "succeeded" }, start: { status: "not-run" } },
    installed: [], packageResults: [], writes: [], host: hostVersions, source: { name: spaceId },
  });
  const makeJob = (requestId: string, failed: boolean): WorkbenchJob => ({
    id: `job-${requestId}`, requestId, kind: "blueprint.apply", status: failed ? "failed" : "succeeded", phase: failed ? "packages" : "done",
    message: failed ? "Package installation failed." : "", affectedSpaceIds: [], canCancel: false,
    createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:01Z",
    result: { product: outcome(failed ? "live-fixture" : "live-empty", failed) },
  });
  const api = {
    state: async (): Promise<WorkbenchState> => ({
      protocolVersion: 2, serviceEpoch: observation.serviceEpoch, revision: observation.expectedRevision,
      availability: "ready", role: "manager", managerId: "hub", owner: { kind: "web", since: "2026-10-09T00:00:00Z" },
      writable: true, mode: "verified-full", dshVersion: "0.2.0-rc.2", maintenance: false, reasons: [], spaces: [], jobs,
    }),
    product: async (request: WorkbenchProductRequest): Promise<WorkbenchProductResult> => {
      if (request.method === "blueprint.inspect") return { method: request.method, blueprint: v2, diagnostics: [], observation };
      if (request.method === "blueprint.preview") return { method: request.method, blueprint: v2, packages: [], inputs: [], missingInputs: [], diagnostics: [], host: hostVersions, planId: `plan-${request.name}`, expiresAt: "2099-01-01T00:00:00Z", observation };
      throw new Error(request.method);
    },
    submit: async (_command: unknown, requestId: string): Promise<WorkbenchJob> => {
      const job = makeJob(requestId, jobs.length > 0);
      if (jobs.length === 0) { jobs = [job]; return job; }
      pendingFailure = job;
      return new Promise((resolve) => { finishSubmit = resolve; });
    },
  } as unknown as WorkbenchApi;
  const controller = new WorkbenchController(api, {
    uuid: () => `request-${++requestNumber}`, now: () => 0, storage: { getItem: () => null, setItem: () => undefined }, hidden: () => false,
    onVisibilityChange: () => () => undefined, addMessageListener: () => () => undefined, openUrl: () => undefined,
  });
  const html = () => renderToStaticMarkup(<WorkbenchView ui={controller.getSnapshot()} controller={controller} />);
  try {
    await controller.poll(); controller.openBlueprintUse();
    controller.blueprint.setContent(encode(v2)); controller.blueprint.inspect(); await flush();
    controller.blueprint.setName("live-empty"); controller.blueprint.preview(); await flush();
    controller.blueprint.apply(); await flush();
    assert.equal(controller.getSnapshot().blueprint.applyOutcome?.spaceId, "live-empty");
    assert.ok(html().includes("data-blueprint-created=\"true\""));

    controller.blueprint.setContent(JSON.stringify(v2));
    assert.equal(html().includes("data-blueprint-created=\"true\""), false);
    controller.blueprint.inspect(); await flush();
    controller.blueprint.setName("live-fixture"); controller.blueprint.preview(); await flush();
    controller.blueprint.apply();
    controller.blueprint.setMode("generate"); controller.blueprint.setMode("use");
    await controller.poll(); // Pending submit; only the historical success is available.
    assert.equal(controller.getSnapshot().blueprint.applyStatus, "submitting");
    assert.equal(controller.getSnapshot().blueprint.applyOutcome, null);
    assert.equal(html().includes("data-blueprint-created=\"true\""), false);
    jobs = [...jobs, pendingFailure]; // Real state listed the old success first.
    await controller.poll();
    assert.equal(controller.getSnapshot().blueprint.applyStatus, "failed");
    assert.equal(controller.getSnapshot().blueprint.applyJobId, jobs[1]!.id);
    assert.equal(controller.getSnapshot().blueprint.applyOutcome?.spaceId, "live-fixture");
    assert.equal(html().includes("data-blueprint-created=\"true\""), false);
    assert.ok(html().includes("Package installation failed."));

    const failure = jobs[1]!;
    controller.blueprint.onApplyJob({ ...failure, status: "queued", result: undefined });
    assert.equal(controller.getSnapshot().blueprint.applyStatus, "failed");
    finishSubmit({ ...failure, status: "queued", result: undefined }); await flush();
    assert.equal(controller.getSnapshot().blueprint.applyStatus, "failed");
    assert.equal(controller.getSnapshot().blueprint.applyOutcome?.spaceId, "live-fixture");
    controller.blueprint.cancelStaged(); await controller.poll();
    assert.equal(controller.getSnapshot().blueprint.applyStatus, "idle");
    assert.equal(controller.getSnapshot().blueprint.applyOutcome, null);
  } finally { controller.stop(); }
});

test("matching queued and running jobs remain observable after an uncertain submit transport failure", async () => {
  let session!: BlueprintSession;
  let submits = 0;
  const h = harness(undefined, { submitApply: async (planId) => {
    submits += 1;
    session.trackApplyRequest(planId, "lost-response-request");
    throw new Error("submit response transport lost");
  } });
  session = h.session;
  session.setContent(encode(v2)); session.inspect(); await flush();
  session.setName("network"); session.preview(); await flush(); session.apply(); await flush();
  assert.equal(session.getSnapshot().applyStatus, "failed");
  assert.equal(session.getSnapshot().applyJobId, null);
  const job: WorkbenchJob = {
    id: "actual-network-job", requestId: "lost-response-request", kind: "blueprint.apply", status: "queued", phase: "queued",
    message: "", affectedSpaceIds: [], canCancel: false, createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:01Z",
  };
  session.onApplyJob({ ...job, requestId: "unrelated" });
  assert.equal(session.getSnapshot().applyJobId, null);
  session.onApplyJob(job);
  assert.equal(session.getSnapshot().applyStatus, "running");
  assert.equal(session.getSnapshot().applyJobId, job.id);
  assert.equal(session.getSnapshot().applyError, null);
  session.onApplyJob({ ...job, status: "running", phase: "packages" });
  assert.equal(session.getSnapshot().applyStatus, "running");
  session.onApplyJob({ ...job, status: "failed", phase: "packages", message: "Package installation failed." });
  assert.equal(session.getSnapshot().applyStatus, "failed");
  assert.equal(session.getSnapshot().applyError, "Package installation failed.");
  session.onApplyJob(job);
  assert.equal(session.getSnapshot().applyStatus, "failed");
  session.apply();
  assert.equal(submits, 1);
});

test("a lost submit response cannot replace an already observed running job with a failure", async () => {
  let rejectSubmit!: (error: Error) => void;
  let session!: BlueprintSession;
  const h = harness(undefined, { submitApply: (planId) => {
    session.trackApplyRequest(planId, "running-request");
    return new Promise((_resolve, reject) => { rejectSubmit = reject; });
  } });
  session = h.session;
  session.setContent(encode(v2)); session.inspect(); await flush();
  session.setName("network"); session.preview(); await flush(); session.apply();
  session.onApplyJob({
    id: "running-job", requestId: "running-request", kind: "blueprint.apply", status: "running", phase: "packages",
    message: "", affectedSpaceIds: [], canCancel: false, createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:01Z",
  });
  rejectSubmit(new Error("submit response transport lost")); await flush();
  assert.equal(session.getSnapshot().applyStatus, "running");
  assert.equal(session.getSnapshot().applyJobId, "running-job");
  assert.equal(session.getSnapshot().applyError, null);
});
