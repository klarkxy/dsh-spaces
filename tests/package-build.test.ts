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

test("the actual mac icon meets the packager minimum resolution", () => {
  const root=join(dirname(fileURLToPath(import.meta.url)),"..");
  const pkg=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
  const png=readFileSync(join(root,pkg.build.mac.icon));
  assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  const width=png.readUInt32BE(16), height=png.readUInt32BE(20);
  assert.ok(width>=512 && height>=512,`mac icon must be at least 512x512, got ${width}x${height}`);
  assert.equal(width,height);
});
