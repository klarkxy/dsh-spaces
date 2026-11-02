import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Inventory: every test file on disk must be referenced by some runner.
const inventoryRe = /\.test\.(?:ts|tsx|mjs)$/;
// Directory arguments follow `node --test` discovery, whose default pattern
// covers .test.{js,cjs,mjs,ts,cts,mts} but NOT .test.tsx (JSX needs a loader
// node's runner does not apply during directory discovery). A tsx test is
// therefore only covered when a script or workflow names the file explicitly.
const nodeDiscoveryRe = /\.test\.(?:js|cjs|mjs|ts|cts|mts)$/;

export function collectTestFiles(root, dir, { nodeDiscovery = false } = {}) {
  const re = nodeDiscovery ? nodeDiscoveryRe : inventoryRe;
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      found.push(...collectTestFiles(root, abs, { nodeDiscovery }));
    } else if (re.test(name)) {
      found.push(relative(root, abs).replace(/\\/g, "/"));
    }
  }
  return found;
}

// A script may name a test file directly or name a directory of test files.
// node --test expands a directory argument recursively (without tsx), so the
// checker expands it with the same semantics when deciding coverage.
const testFilePathRe = /^tests\/[\w./-]*\.test\.(?:tsx?|mjs|cjs|js)$/;
const testDirPathRe = /^tests\/(?:[\w-]+\/)+$/;
const testDirNoSlashRe = /^tests\/(?:[\w-]+\/)*[\w-]+$/;

export function checkTestLists({ root = defaultRoot, referrerTexts }) {
  const testFiles = collectTestFiles(root, join(root, "tests")).sort();
  const referenced = new Map();
  const addReference = (file, label) => {
    if (!referenced.has(file)) referenced.set(file, []);
    referenced.get(file).push(label);
  };
  const missing = [];

  for (const { label, text } of referrerTexts) {
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
        for (const file of collectTestFiles(root, abs, { nodeDiscovery: true })) addReference(file, label);
        continue;
      }

      if (testDirNoSlashRe.test(token)) {
        const abs = join(root, token);
        if (!existsSync(abs) || !statSync(abs).isDirectory()) {
          missing.push({ file: token, label });
          continue;
        }
        for (const file of collectTestFiles(root, abs, { nodeDiscovery: true })) addReference(file, label);
      }
      // Anything else (workflow path filters with globs, for example) is not a
      // test-runner argument and is intentionally ignored.
    }
  }

  const unlisted = testFiles.filter((file) => !referenced.has(file));
  return { testFiles, referenced, missing, unlisted };
}

function main() {
  const root = defaultRoot;
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  const referrerTexts = [];
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    referrerTexts.push({ label: `package.json script "${name}"`, text: command });
  }
  const workflowsDir = join(root, ".github", "workflows");
  for (const name of readdirSync(workflowsDir)) {
    if (!/\.(yml|yaml)$/.test(name)) continue;
    referrerTexts.push({ label: `.github/workflows/${name}`, text: readFileSync(join(workflowsDir, name), "utf8") });
  }
  for (const name of readdirSync(join(root, "scripts"))) {
    if (!/\.(mjs|cjs|js)$/.test(name)) continue;
    referrerTexts.push({ label: `scripts/${name}`, text: readFileSync(join(root, "scripts", name), "utf8") });
  }

  const { testFiles, referenced, missing, unlisted } = checkTestLists({ root, referrerTexts });

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
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
