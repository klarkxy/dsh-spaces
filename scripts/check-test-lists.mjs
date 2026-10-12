import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const testFileRe = /^[^/\\]+\.test\.(ts|tsx|mjs)$/;
const testFiles = readdirSync(join(root, "tests"))
  .filter((name) => testFileRe.test(name))
  .map((name) => `tests/${name}`)
  .sort();

const referrers = [];
for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  referrers.push({ label: `package.json script "${name}"`, text: command });
}
const workflowsDir = join(root, ".github", "workflows");
for (const name of readdirSync(workflowsDir)) {
  if (!/\.(yml|yaml)$/.test(name)) continue;
  referrers.push({ label: `.github/workflows/${name}`, text: readFileSync(join(workflowsDir, name), "utf8") });
}
for (const name of readdirSync(join(root, "scripts"))) {
  if (!/\.(mjs|cjs|js)$/.test(name)) continue;
  const path = join(root, "scripts", name);
  referrers.push({ label: `scripts/${name}`, text: readFileSync(path, "utf8") });
}

const referencedTestRe = /tests\/[\w./-]+\.test\.(?:tsx?|mjs|cjs|js)/g;
const referenced = new Map();
for (const { label, text } of referrers) {
  for (const match of text.matchAll(referencedTestRe)) {
    const file = match[0];
    if (!referenced.has(file)) referenced.set(file, []);
    referenced.get(file).push(label);
  }
}

const unlisted = testFiles.filter((file) => !referenced.has(file));
const missing = [...referenced.keys()].filter((file) => !existsSync(join(root, file)));

if (unlisted.length || missing.length) {
  for (const file of unlisted) {
    console.error(`unlisted test file: ${file} is not referenced by any package.json script or workflow`);
  }
  for (const file of missing) {
    console.error(`stale test reference: ${file} does not exist (referenced by ${referenced.get(file).join(", ")})`);
  }
  process.exitCode = 1;
} else {
  console.log(`check:test-lists: ${testFiles.length} test files covered, ${referenced.size} references resolve`);
}
