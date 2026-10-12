import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const adapterDir = join(dirname(fileURLToPath(import.meta.url)), "../src/adapters/node");

test("no Node-adapter write path targets profiles/web", () => {
  const files = readdirSync(adapterDir).filter((name) => name.endsWith(".ts"));
  const offenders: string[] = [];
  for (const name of files) {
    const text = readFileSync(join(adapterDir, name), "utf8");
    if (name === "patch-writer.ts") {
      assert.match(text, /errors\.webSacred/);
      assert.match(text, /name === "web"/);
    }
    if (name === "profile-registry.ts") {
      assert.match(text, /errors\.refuseDeleteWebProfile/);
    }
    const writesWeb =
      /writeFileSync\([^)]*profiles[\\/]web/.test(text) ||
      /atomicWrite\([^)]*profiles[\\/]web/.test(text);
    if (writesWeb) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
