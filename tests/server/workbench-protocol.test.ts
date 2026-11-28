import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchHomeSettings } from "../../src/shared/workbench-product.ts";
import {
  parseWorkbenchProductCommand,
  parseWorkbenchProductOutcome,
  parseWorkbenchProductRequest,
  parseWorkbenchProductResult,
} from "../../src/shared/workbench-product-schemas.ts";
import {
  WORKBENCH_PROTOCOL_CONFLICT,
  WORKBENCH_PROTOCOL_INVALID,
  WORKBENCH_PROTOCOL_VERSION,
  WorkbenchProtocolConflictError,
  WorkbenchProtocolInputError,
  assertMutationContext,
  computeWorkbenchRevision,
  deriveServiceEpoch,
  digestHomeIdentity,
  parseMutationContext,
  type WorkbenchRevisionSpace,
} from "../../src/adapters/node/server/workbench-protocol.ts";
import { MAX_WORKBENCH_SHARE_BASE64 } from "../../src/shared/workbench-product.ts";
import { parsePlanRequest } from "../../src/adapters/node/supervisor/input.ts";
import { workbenchJobResultSchema, workbenchPlanRequestSchema, workbenchPlanSchema, workbenchSpaceDetailSchema } from "../../packages/plugin/src/host/workbench-schemas.ts";

const settings: WorkbenchHomeSettings = {
  portStart: 3100,
  portEnd: 3199,
  packageSource: "official",
  catalogUrl: "",
  restoreRunningSpacesOnLaunch: true,
};

const space = (id: string, generation = 1): WorkbenchRevisionSpace => ({
  id,
  displayName: id,
  icon: "",
  generation,
  status: "stopped",
  managed: true,
  dshVersion: null, startWithDesktop: false,
  isHost: id === "hub",
  hasWebApp: true,
});

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);

test("protocol version is 2", () => {
  assert.equal(WORKBENCH_PROTOCOL_VERSION, 2);
});

test("global runtime installation is removed from HTTP and native plan inputs", () => {
  const removed = { kind: "runtime.install", version: "0.2.0-rc.2" };
  assert.throws(() => parsePlanRequest(removed), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "workbench/unsupported");
  assert.equal(workbenchPlanRequestSchema.safeParse(removed).success, false);
  assert.equal(workbenchPlanRequestSchema.safeParse({ kind: "space.runtime.set", spaceId: "space-demo", version: "0.2.0-rc.2" }).success, true);
  assert.equal(workbenchPlanRequestSchema.safeParse({ kind: "runtime.remove", version: "0.2.0-rc.2" }).success, true);
});

test("the host plugin accepts the models sync plan the Supervisor previews", () => {
  const request = { kind: "space.models.sync", spaceId: "space-demo" };
  assert.deepEqual(parsePlanRequest(request), request);
  assert.equal(workbenchPlanRequestSchema.safeParse(request).success, true);
  assert.equal(workbenchPlanRequestSchema.safeParse({ ...request, extra: true }).success, false);
  const plan = {
    id: "plan-1",
    kind: "space.models.sync",
    title: "space.models.sync",
    scope: "space",
    affectedSpaceIds: ["space-demo"],
    runningSpaceIds: ["space-demo"],
    modelsSync: {
      mainProfile: "web", routes: ["gw"], deepseek: false, defaultModel: "gw/m1",
      credentials: ["GW_KEY"], skipped: [{ route: "codex", reason: "login-grant" }], missingCredentials: ["OTHER_KEY"],
    },
    changes: ["Copy the model settings of the main space (web) into space-demo."],
    destructive: false,
    expiresAt: new Date(0).toISOString(),
    serviceEpoch: "a".repeat(64),
    stateRevision: "b".repeat(64),
  };
  assert.equal(workbenchPlanSchema.safeParse(plan).success, true);
  assert.equal(workbenchPlanSchema.safeParse({ ...plan, modelsSync: { ...plan.modelsSync, secret: "credential-value" } }).success, false);
  assert.equal(workbenchPlanSchema.safeParse({ ...plan, modelsSync: { ...plan.modelsSync, skipped: [{ route: "x", reason: "unknown" }] } }).success, false);
  const result = {
    spaceId: "space-demo",
    steps: [{ step: "models-sync", status: "done", detail: "main: web; routes: gw; default: gw/m1; credentials: 1" }],
  };
  assert.equal(workbenchJobResultSchema.safeParse(result).success, true);
  assert.equal(workbenchJobResultSchema.safeParse({ steps: [{ step: "x", status: "done", detail: "d".repeat(301) }] }).success, false);
});

test("space detail carries the target model state without credential values", () => {
  const detail = {
    space: { id: "space-demo", displayName: "Demo", isHost: false, hasWebApp: true, status: "running" },
    models: { status: "incomplete", routeNames: ["gw"], defaultModel: null, missingCredentials: ["GW_KEY"] },
    plugins: [], snapshots: [], diagnostics: [],
  };
  assert.equal(workbenchSpaceDetailSchema.safeParse(detail).success, true);
  assert.equal(workbenchSpaceDetailSchema.safeParse({ ...detail, models: { ...detail.models, secret: "credential-value" } }).success, false);
});

test("home digest is deterministic and does not leak the canonical path", () => {
  const home = "D:\\0 code\\dsh-spaces\\.sandbox\\dsh-home-fixture";
  const first = digestHomeIdentity(home);
  const second = digestHomeIdentity(home);
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first.includes("dsh-home-fixture"), false);
  assert.equal(first.includes(home), false);
  assert.notEqual(digestHomeIdentity(`${home}-b`), first);
});

test("service epoch is derived from the nonce without returning it", () => {
  const nonce = "secret-nonce-value-do-not-leak";
  const epoch = deriveServiceEpoch(nonce);
  assert.equal(epoch, deriveServiceEpoch(nonce));
  assert.match(epoch, /^[a-f0-9]{64}$/);
  assert.notEqual(epoch, nonce);
  assert.equal(epoch.includes(nonce), false);
  assert.notEqual(deriveServiceEpoch(`${nonce}-x`), epoch);
});

test("revision is deterministic for same-order copies and key permutation", () => {
  const ordered = [space("hub"), space("alpha", 1)];
  const first = computeWorkbenchRevision({ spaces: ordered, settings });
  const copy = computeWorkbenchRevision({
    spaces: ordered.map((item) => ({ ...item })),
    settings: { ...settings },
  });
  assert.equal(first, copy);
  assert.match(first, /^[a-f0-9]{64}$/);
  const keyPermuted: WorkbenchRevisionSpace = {
    hasWebApp: true,
    dshVersion: null, startWithDesktop: false,
    managed: true,
    status: "stopped",
    generation: 1,
    icon: "",
    displayName: "alpha",
    isHost: false,
    id: "alpha",
  };
  const sameKeys = computeWorkbenchRevision({ spaces: [space("hub"), keyPermuted], settings });
  assert.equal(sameKeys, first);
});

test("revision changes when space list order, generation, or settings change", () => {
  const ab = computeWorkbenchRevision({ spaces: [space("alpha"), space("beta")], settings });
  const ba = computeWorkbenchRevision({ spaces: [space("beta"), space("alpha")], settings });
  assert.notEqual(ab, ba);
  const generationMoved = computeWorkbenchRevision({
    spaces: [space("alpha", 2), space("beta")],
    settings,
  });
  assert.notEqual(generationMoved, ab);
  const settingsMoved = computeWorkbenchRevision({
    spaces: [space("alpha"), space("beta")],
    settings: { ...settings, portEnd: 3200 },
  });
  assert.notEqual(settingsMoved, ab);
});

test("revision ignores extra fields that are not space metadata or settings", () => {
  const base = computeWorkbenchRevision({ spaces: [space("alpha")], settings });
  const noisySpace = {
    ...space("alpha"),
    jobs: [{ id: "job-1" }],
    updatedAt: "2026-09-20T00:00:00.000Z",
    lastError: "log line",
  };
  const noisy = computeWorkbenchRevision({
    spaces: [noisySpace],
    settings: { ...settings, secret: "nope" } as WorkbenchHomeSettings & { secret: string },
  });
  assert.equal(noisy, base);
});

test("old epoch and stale revision throw a stable conflict", () => {
  const current = { serviceEpoch: digest, revision: otherDigest };
  assert.throws(
    () => assertMutationContext({ serviceEpoch: otherDigest, expectedRevision: otherDigest }, current),
    (error: unknown) =>
      error instanceof WorkbenchProtocolConflictError && error.code === WORKBENCH_PROTOCOL_CONFLICT,
  );
  assert.throws(
    () => assertMutationContext({ serviceEpoch: digest, expectedRevision: digest }, current),
    (error: unknown) =>
      error instanceof WorkbenchProtocolConflictError && error.code === WORKBENCH_PROTOCOL_CONFLICT,
  );
  assert.doesNotThrow(() =>
    assertMutationContext({ serviceEpoch: digest, expectedRevision: otherDigest }, current),
  );
});

test("mutation context rejects missing extra or malformed fields", () => {
  assert.throws(
    () => parseMutationContext({ serviceEpoch: digest }),
    (error: unknown) => error instanceof WorkbenchProtocolInputError && error.code === WORKBENCH_PROTOCOL_INVALID,
  );
  assert.throws(
    () => parseMutationContext({ serviceEpoch: digest, expectedRevision: otherDigest, extra: true }),
    (error: unknown) => error instanceof WorkbenchProtocolInputError && error.code === WORKBENCH_PROTOCOL_INVALID,
  );
  assert.throws(() => parseMutationContext({ serviceEpoch: "not-a-digest", expectedRevision: otherDigest }));
});

test("product command schema is closed and rejects paths, credentials, and tags", () => {
  const valid = parseWorkbenchProductCommand({
    kind: "settings.update",
    settings: { portStart: 3100, portEnd: 3199, packageSource: "official", catalogUrl: "", restoreRunningSpacesOnLaunch: true },
  });
  assert.equal(valid.kind, "settings.update");
  assert.throws(() =>
    parseWorkbenchProductCommand({
      kind: "settings.update",
      settings: { portStart: 3100, portEnd: 3199, packageSource: "official", catalogUrl: "", restoreRunningSpacesOnLaunch: true },
      extra: true,
    }),
  );
  assert.throws(() => parseWorkbenchProductCommand({ kind: "plugin.download", spec: "C:\\\\secret\\\\pkg.tgz" }));
  assert.throws(() => parseWorkbenchProductCommand({ kind: "plugin.download", spec: "/tmp/pkg.tgz" }));
  assert.throws(() =>
    parseWorkbenchProductCommand({
      kind: "catalog.refresh",
      url: "https://user:pass@example.com/catalog.json",
    }),
  );
  assert.throws(() => parseWorkbenchProductCommand({ kind: "plugin.download", catalogId: "example-plugin", version: "latest" }));
});

test("product request and outcome schemas reject unknown keys and oversized archives", () => {
  parseWorkbenchProductRequest({ method: "settings" });
  assert.throws(() => parseWorkbenchProductRequest({ method: "settings", extra: true }));
  assert.throws(() =>
    parseWorkbenchProductRequest({
      method: "share.previewImport",
      archiveBase64: `${"A".repeat(MAX_WORKBENCH_SHARE_BASE64 + 4)}`,
    }),
  );
  parseWorkbenchProductOutcome({
    kind: "plugin.library.remove",
    libraryId: "lib-1",
  });
  assert.throws(() =>
    parseWorkbenchProductOutcome({
      kind: "plugin.library.remove",
      libraryId: "lib-1",
      path: "D:\\\\hub\\\\plugins\\\\x.tgz",
    }),
  );
});

test("product result requires an observation and a closed method payload", () => {
  const observation = { serviceEpoch: digest, expectedRevision: otherDigest };
  parseWorkbenchProductResult({
    method: "library",
    items: [],
    observation,
  });
  assert.throws(() =>
    parseWorkbenchProductResult({
      method: "library",
      items: [],
    }),
  );
  assert.throws(() =>
    parseWorkbenchProductResult({
      method: "library",
      items: [],
      observation,
      leakedPath: "/home/user/.dsh",
    }),
  );
});

test("share and template results accept stored avatar size and keep its limit", () => {
  const icon="data:image/png;base64,"+"A".repeat(20000);
  const preview={manifest:{formatVersion:1,kind:"dsh-space",exportedAt:"2026-10-13T00:00:00.000Z",source:{},space:{displayName:"Avatar",icon}},plugins:[],hasConfig:false,unknownSources:[]};
  const observation={serviceEpoch:digest,expectedRevision:otherDigest};
  const result={method:"share.export",fileName:"avatar.dsh-space",archiveBase64:"AAAA",preview,observation};
  parseWorkbenchProductResult(result);
  parseWorkbenchProductResult({method:"templates",observation,templates:[{id:"avatar",name:"Avatar",displayName:"Avatar",plugins:[],createdAt:"2026-10-13T00:00:00.000Z",recipe:{schemaVersion:1,displayName:"Avatar",icon,plugins:[]}}]});
  assert.throws(()=>parseWorkbenchProductResult({...result,preview:{...preview,manifest:{...preview.manifest,space:{displayName:"Avatar",icon:"A".repeat(240001)}}}}));
});
