import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const mainDir = join(dirname(fileURLToPath(import.meta.url)), "../src/main");

test("no main-process write path targets profiles/web", () => {
  const files = readdirSync(mainDir).filter((name) => name.endsWith(".ts"));
  const offenders: string[] = [];
  for (const name of files) {
    const text = readFileSync(join(mainDir, name), "utf8");
    if (name === "patch-writer.ts") {
      assert.match(text, /web is sacred/);
      assert.match(text, /name === "web"/);
    }
    if (name === "profile-registry.ts") {
      assert.match(text, /refusing to delete the web profile/);
    }
    const writesWeb =
      /writeFileSync\([^)]*profiles[\\/]web/.test(text) ||
      /atomicWrite\([^)]*profiles[\\/]web/.test(text);
    if (writesWeb) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
