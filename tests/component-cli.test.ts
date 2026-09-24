import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cliLoadError,
  dshPeerRangesFromPayload,
  unmetDshPeers,
} from "../src/adapters/node/component-cli.ts";

test("component peers reject an older CLI and accept the alpha release", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-cli-peers-"));
  const lib = join(root, "lib");
  mkdirSync(join(lib, "view-bridge"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@dsh-spaces/plugin",
    peerDependencies: { "@deepseek-ai/dsh-client-connection": "^0.1.7-alpha.1", zod: "^4.4.3" },
  }));
  writeFileSync(join(lib, "view-bridge", "package.json"), JSON.stringify({
    name: "@dsh-spaces/view-bridge",
    peerDependencies: { "@deepseek-ai/dsh-settings": "^0.1.7-alpha.1" },
  }));
  try {
    const ranges = dshPeerRangesFromPayload(lib);
    assert.equal(ranges.zod, undefined);
    const unmet = unmetDshPeers("0.1.5-rc.2", ranges);
    assert.ok(unmet.some(row => row.includes("dsh-settings")));
    assert.equal(unmetDshPeers("0.1.7-alpha.1", ranges).length, 0);
    assert.match(cliLoadError("0.1.5-rc.2", unmet), /0\.1\.5-rc\.2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
