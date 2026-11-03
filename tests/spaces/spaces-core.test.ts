import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  PatchForbiddenError,
  PatchVerifyError,
  applyIsolationPatch,
  assertDumpConfigIsolated,
  assertDumpPatched,
  configPathExpr,
  extractConfigField,
  extractRoot,
  isExpectedIsolationPath,
  isExpectedIsolationRoot,
  isolationExpr,
  patchTextLooksConfigIsolated,
  patchTextLooksIsolated,
} from "../../src/core/domain/isolation.ts";
import {
  applyMetaPatch,
  applyWorkbenchReorder,
  assertValidProfileName,
  compareScannedProfiles,
  completeWorkbenchOrder,
  defaultSpaceMeta,
  emptySpacesFile,
  normalizeSpacesFile,
  packageHasWebApp,
} from "../../src/core/domain/registry.ts";
import type { OperationLock } from "../../src/core/ports/operation-lock.ts";
import { t } from "../../src/shared/i18n/index.ts";

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "core");
const sharedRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "shared");

function coreSource(relative: string): string {
  return readFileSync(join(coreRoot, relative), "utf8");
}

function sharedSource(relative: string): string {
  return readFileSync(join(sharedRoot, relative), "utf8");
}

test("core stays free of Node fs/process, Electron, React, and Cordis", () => {
  const files = [
    "domain/isolation.ts",
    "domain/registry.ts",
    "domain/llm-resolution.ts",    "application/global-llm-service.ts",
    "ports/operation-lock.ts",
    "ports/llm-store.ts",
  ];
  const forbidden = /from ["'](?:node:fs|node:process|electron|react|react\/jsx-runtime|cordis)/;
  for (const file of files) {
    assert.equal(forbidden.test(coreSource(file)), false, file);
  }
  for (const file of ["llm-connections.ts", "llm-share.ts"]) {
    assert.equal(forbidden.test(sharedSource(file)), false, file);
  }
});

test("isolation expressions and dump verification stay host-independent", () => {
  assert.equal(isolationExpr("coding", "sessions"), "dshHomePath('hub/coding/sessions')");
  assert.equal(configPathExpr("coding", "settings.yaml"), "dshHomePath('hub/coding/settings.yaml')");
  assert.equal(
    isExpectedIsolationRoot("!!js dshHomePath('hub/coding/sessions')", "coding", "sessions"),
    true,
  );
  assert.equal(isExpectedIsolationRoot("dshHomePath('hub/coding/sessions')", "coding", "sessions"), false);
  assert.equal(
    isExpectedIsolationPath("!!js dshHomePath('hub/coding/settings.yaml')", "coding", "settings.yaml"),
    true,
  );
  assert.equal(patchTextLooksIsolated("hub/coding/sessions\nhub/coding/storages", "coding"), true);
  assert.equal(
    patchTextLooksConfigIsolated(
      "hub/coding/sessions\nhub/coding/storages\nhub/coding/settings.yaml\nhub/coding/.credentials.yaml",
      "coding",
    ),
    true,
  );

  const dump = `
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/coding/storages')
`;
  assert.equal(extractRoot(dump, "session-persistence-jsonl"), "!!js dshHomePath('hub/coding/sessions')");
  assert.doesNotThrow(() => assertDumpPatched(dump, "coding"));
  assert.throws(() => applyIsolationPatch("[]\n", "web", "patch"), PatchForbiddenError);
  const patched = applyIsolationPatch("- id: keep-me\n  config:\n    foo: 1\n", "coding", "patch");
  assert.match(patched, /hub\/coding\/sessions/);
  assert.match(patched, /hub\/coding\/storages/);
  assert.doesNotMatch(patched, /hub\/coding\/settings\.yaml/);
  assert.match(patched, /hub\/coding\/\.credentials\.yaml/);
  assert.equal(extractConfigField(patched, "settings", "path"), null);
  assert.doesNotThrow(() => assertDumpConfigIsolated(patched, "coding"));
  assert.throws(
    () =>
      applyIsolationPatch(
        `- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/coding/sessions')
`,
        "coding",
        "patch",
      ),
    PatchVerifyError,
  );
});

test("registry domain validates names and orders workbench records", () => {
  assert.throws(() => assertValidProfileName("Web"), { message: t("errors.nameInvalid") });
  assert.throws(() => assertValidProfileName("web"), { message: t("errors.nameReserved", { name: "web" }) });
  assertValidProfileName("notes");
  assert.equal(packageHasWebApp({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app"] } } }), true);
  assert.deepEqual(defaultSpaceMeta("web"), { displayName: "Home", order: -1 });

  const spaces = emptySpacesFile();
  applyMetaPatch(spaces, "coding", { displayName: "Code" });
  applyMetaPatch(spaces, "writing", { displayName: "Write" });
  applyWorkbenchReorder(spaces, completeWorkbenchOrder(["coding", "writing"], ["writing"]));
  assert.deepEqual(spaces.order, ["writing", "coding"]);

  const records = [
    { name: "coding", meta: { displayName: "Code", order: 1 } },
    { name: "web", meta: defaultSpaceMeta("web") },
    { name: "writing", meta: { displayName: "Write", order: 0 } },
  ];
  records.sort((a, b) => compareScannedProfiles(a, b, spaces.order));
  assert.deepEqual(records.map((row) => row.name), ["web", "writing", "coding"]);
  assert.throws(() => normalizeSpacesFile({ version: 2, order: [], meta: {} } as never), {
    message: t("errors.unsupportedSpacesVersion", { version: "2" }),
  });
});



