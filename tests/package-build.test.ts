import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("mac builder target keeps dmg and zip for electron-updater", () => {
  const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { build: { mac: { target: string[] } } };
  assert.ok(pkg.build.mac.target.includes("dmg"));
  assert.ok(pkg.build.mac.target.includes("zip"));
});
