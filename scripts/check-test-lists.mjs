import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const testFileRe = /\.test\.(ts|tsx|mjs)$/;

// Test files live in domain subdirectories of tests/; collect them recursively.
function collectTestFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      found.push(...collectTestFiles(abs));
    } else if (testFileRe.test(name)) {
      found.push(relative(root, abs).replace(/\\/g, "/"));
    }
  }
  return found;
}

const testFiles = collectTestFiles(join(root, "tests")).sort();

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

// A script may name a test file directly or name a directory of test files.
// node --test expands a directory argument recursively, so the checker has to
// expand it too when it decides whether a test file is referenced.
const testFilePathRe = /^tests\/[\w./-]*\.test\.(?:tsx?|mjs|cjs|js)$/;
const testDirPathRe = /^tests\/(?:[\w-]+\/)+$/;
const testDirNoSlashRe = /^tests\/(?:[\w-]+\/)*[\w-]+$/;

const referenced = new Map();
const addReference = (file, label) => {
  if (!referenced.has(file)) referenced.set(file, []);
  referenced.get(file).push(label);
};

const missing = [];

for (const { label, text } of referrers) {
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^["'`]|["'`;]+$/g, "");
    if (!token.startsWith("tests/")) continue;

    if (testFilePathRe.test(token)) {
      if (!existsSync(join(root, token))) missing.push({ file: token, label });
      else addReference(token, label);
      continue;
    }

    if (testDirPathRe.test(token)) {
      const abs = join(root, token.replace(/\/$/, ""));
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        missing.push({ file: token, label });
        continue;
      }
      for (const file of collectTestFiles(abs)) addReference(file, label);
      continue;
    }

    if (testDirNoSlashRe.test(token)) {
      const abs = join(root, token);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        missing.push({ file: token, label });
        continue;
      }
      for (const file of collectTestFiles(abs)) addReference(file, label);
    }
    // Anything else (workflow path filters with globs, for example) is not a
    // test-runner argument and is intentionally ignored.
  }
}

const unlisted = testFiles.filter((file) => !referenced.has(file));

if (unlisted.length || missing.length) {
  for (const file of unlisted) {
    console.error(`unlisted test file: ${file} is not referenced by any package.json script or workflow`);
  }
  for (const { file, label } of missing) {
    console.error(`stale test reference: ${file} does not exist (referenced by ${label})`);
  }
  process.exitCode = 1;
} else {
  console.log(`check:test-lists: ${testFiles.length} test files referenced, ${referenced.size} references resolve (not a CI reachability check)`);
}
