import assert from "node:assert/strict";
import { test } from "node:test";
import {
  restoreSelected,
  shouldShowIdleCard,
  shouldShowStartingCard,
} from "../src/shared/restore-selected.ts";
import type { ProfileRecord } from "../src/shared/types.ts";

function profile(name: string, status: ProfileRecord["status"]): Pick<ProfileRecord, "name" | "status"> {
  return { name, status };
}

test("restoreSelected keeps the user's pick even when another space is running", () => {
  const profiles = [profile("web", "running"), profile("notes", "stopped")];
  assert.equal(restoreSelected("notes", "web", profiles), "notes");
  assert.equal(restoreSelected("web", null, profiles), "web");
});

test("restoreSelected follows the view main is actually showing after a remount", () => {
  const profiles = [profile("web", "running"), profile("notes", "running")];
  assert.equal(restoreSelected(null, "notes", profiles), "notes");
  assert.equal(restoreSelected("gone", "web", profiles), "web");
});

test("restoreSelected stays empty when main is not showing a view", () => {
  const profiles = [profile("web", "running"), profile("notes", "running")];
  assert.equal(restoreSelected(null, null, profiles), null);
  assert.equal(restoreSelected(null, "gone", profiles), null);
});

test("opening or restarting a stopped space shows starting, not idle", () => {
  assert.equal(shouldShowStartingCard("stopped", true), true);
  assert.equal(shouldShowIdleCard("stopped", true), false);
  assert.equal(shouldShowStartingCard("starting", false), true);
  assert.equal(shouldShowIdleCard("stopped", false), true);
  assert.equal(shouldShowStartingCard("stopped", false), false);
});
