import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchHomeSettings } from "../src/shared/workbench-product.ts";
import {
  parseWorkbenchProductCommand,
  parseWorkbenchProductOutcome,
  parseWorkbenchProductRequest,
  parseWorkbenchProductResult,
} from "../src/shared/workbench-product-schemas.ts";
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
} from "../src/adapters/node/workbench-protocol.ts";
import { MAX_WORKBENCH_SHARE_BASE64 } from "../src/shared/workbench-product.ts";

const settings: WorkbenchHomeSettings = {
  portStart: 3100,
  portEnd: 3199,
  packageSource: "official",
  catalogUrl: "",
};

const space = (id: string, generation = 1): WorkbenchRevisionSpace => ({
  id,
  displayName: id,
  icon: "",
  isolation: "verified",
  generation,
  status: "stopped",
  managed: true,
  needsIsolation: false,
  isHost: id === "hub",
  hasWebApp: true,
});

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);

test("protocol version is 2", () => {
  assert.equal(WORKBENCH_PROTOCOL_VERSION, 2);
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
    needsIsolation: false,
    managed: true,
    status: "stopped",
    generation: 1,
    isolation: "verified",
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
    settings: { portStart: 3100, portEnd: 3199, packageSource: "official", catalogUrl: "" },
  });
  assert.equal(valid.kind, "settings.update");
  assert.throws(() =>
    parseWorkbenchProductCommand({
      kind: "settings.update",
      settings: { portStart: 3100, portEnd: 3199, packageSource: "official", catalogUrl: "" },
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
