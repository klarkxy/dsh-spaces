import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkTestLists, collectTestFiles } from "../../scripts/check-test-lists.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// node --test directory discovery does not pick up .test.tsx, so a tsx file
// covered only by a directory argument never actually runs. The checker must
// keep the inventory (which includes tsx) separate from directory coverage.
test("directory expansion follows node discovery and never covers .test.tsx", () => {
  const viaDirectory = collectTestFiles(root, join(root, "tests/spaces"), { nodeDiscovery: true });
  assert.ok(viaDirectory.length > 0);
  const leakedTsx = viaDirectory.filter((file) => file.endsWith(".tsx"));
  assert.deepEqual(leakedTsx, [], `directory discovery must not yield tsx: ${leakedTsx}`);
  const inventory = collectTestFiles(root, join(root, "tests/spaces"));
  assert.ok(inventory.some((file) => file.endsWith(".test.tsx")), "inventory must still see tsx files");
});

// Regression for the false pass: `tsx --test tests/spaces/` does not run
// tests/spaces/space-avatars.test.tsx, so dropping the explicit entry must be reported.
test("a tsx file covered only by a directory argument is reported unlisted", () => {
  const onlyDir = checkTestLists({ root, referrerTexts: [{ label: "probe", text: "tsx --test tests/spaces/" }] });
  assert.ok(onlyDir.unlisted.includes("tests/spaces/space-avatars.test.tsx"),
    "a tsx test covered only by the directory argument must stay unlisted");
  const dirPlusExplicit = checkTestLists({
    root,
    referrerTexts: [{ label: "probe", text: "tsx --test tests/spaces/ tests/spaces/space-avatars.test.tsx" }],
  });
  assert.ok(!dirPlusExplicit.unlisted.includes("tests/spaces/space-avatars.test.tsx"),
    "an explicit tsx reference still covers the file");
});

test("the checker passes on the real repository state", () => {
  const run = spawnSync(process.execPath, [join(root, "scripts/check-test-lists.mjs")], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
