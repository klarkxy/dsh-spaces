import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isDataOnlySnapshot,
  restoreOptionsFor,
  settingsFormKey,
} from "../src/renderer/src/recovery.ts";
import { DEFAULT_HUB_SETTINGS } from "../src/shared/types.ts";
import type { SnapshotMeta } from "../src/shared/snapshots.ts";

function snapshot(partial: Partial<SnapshotMeta> = {}): SnapshotMeta {
  return {
    id: "4f8b2f6e-3d3a-4c1b-9a2e-1f0c7d5b8a91",
    createdAt: "2026-09-11T00:00:00.000Z",
    home: "/tmp/home",
    runtimeVersion: "0.1.0",
    binRelative: "bin/dsh",
    profiles: ["web"],
    size: 1024,
    presence: {
      profiles: true,
      sessions: true,
      storages: true,
      hub: true,
      "settings.yaml": true,
      "cordis.patch.yml": true,
    },
    ...partial,
  };
}

test("runtimeMissing defaults to a normal snapshot; flagged rows are data-only", () => {
  assert.equal(isDataOnlySnapshot(snapshot()), false);
  assert.equal(isDataOnlySnapshot(snapshot({ runtimeMissing: false })), false);
  assert.equal(isDataOnlySnapshot(snapshot({ runtimeMissing: true })), true);
});

test.skip("restore options require an explicit ack when the current runtime is missing", () => {
  assert.equal(restoreOptionsFor(true, false), undefined);
  assert.equal(restoreOptionsFor(true, true), undefined);
  assert.equal(restoreOptionsFor(false, false), null);
  assert.deepEqual(restoreOptionsFor(false, true), { allowDataOnlyBackup: true });
});

test("settingsFormKey is stable for equal settings and changes per edited field", () => {
  const base = { ...DEFAULT_HUB_SETTINGS };
  assert.equal(settingsFormKey(base), settingsFormKey({ ...base }));
  assert.notEqual(settingsFormKey(base), settingsFormKey({ ...base, portStart: base.portStart + 1 }));
  assert.notEqual(settingsFormKey(base), settingsFormKey({ ...base, portEnd: base.portEnd + 1 }));
  assert.notEqual(settingsFormKey(base), settingsFormKey({ ...base, packageSource: base.packageSource === "china" ? "official" : "china" }));
  assert.notEqual(settingsFormKey(base), settingsFormKey({ ...base, locale: "en" }));
  assert.notEqual(settingsFormKey(base), settingsFormKey({ ...base, theme: "dark" }));
  assert.notEqual(settingsFormKey(base), settingsFormKey({ ...base, catalogUrl: "https://example.com/catalog.json" }));
});

test("settingsFormKey ignores fields the settings form does not draft", () => {
  const base = { ...DEFAULT_HUB_SETTINGS };
  assert.equal(
    settingsFormKey(base),
    settingsFormKey({ ...base, quitKeepHintDismissed: !base.quitKeepHintDismissed }),
  );
});
