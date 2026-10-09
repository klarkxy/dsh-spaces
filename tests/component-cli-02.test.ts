import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dshPeerRangesFromPackages, unmetDshPeers } from "../src/adapters/node/component-cli.ts";

test("component compatibility checks bare DSH peers as well as named subsystems", (t) => {
  const root = mkdtempSync(join(tmpdir(), "spaces-peer-02-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "package.json");
  writeFileSync(path, JSON.stringify({ peerDependencies: {
    "@deepseek-ai/dsh": "^0.1.7-alpha.1", "@deepseek-ai/dsh-settings": ">=0.2.0-rc.2",
  } }));
  assert.deepEqual(unmetDshPeers("0.2.0-rc.2", dshPeerRangesFromPackages([path])), ["@deepseek-ai/dsh@^0.1.7-alpha.1"]);
});

test("component compatibility follows official workspace tokens and rejects empty/invalid ranges", () => {
  for (const range of ["workspace:^", "workspace:~", "workspace:*"]) {
    assert.deepEqual(unmetDshPeers("0.2.0-rc.2", { "@deepseek-ai/dsh": range }), []);
  }
  for (const range of ["", "workspace:1.0.0", "not-a-range"]) {
    assert.equal(unmetDshPeers("0.2.0-rc.2", { "@deepseek-ai/dsh": range }).length, 1);
  }
});
