import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  applySpaceRecipe,
  canonicalNpmInstallSpec,
  parseSpaceRecipe,
  publicSpaceTemplate,
  recipeFromShareParts,
  recipeFromTemplate,
  validateImportedPatch,
} from "../src/core/application/space-recipe.ts";
import { LLM_SHARE_NOTE } from "../src/core/domain/llm-share.ts";
import { SPACE_TEMPLATES_FILE, createSpaceFromTemplate, listSpaceTemplates } from "../src/main/space-templates.ts";
import {
  FULL_SPACES_PACKAGE,
  isFullSpacesManagerSpec,
  isUnresolvedPluginAlias,
} from "../src/shared/plugin-spec.ts";
import type { SpaceRecipe, SpaceSharePlugin, SpaceTemplate } from "../src/shared/space-share.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-recipe-"));
  temps.push(dir);
  return dir;
}

const outline: SpaceSharePlugin = {
  packageName: "dsh-outline",
  resolvedVersion: "1.2.3",
  source: "npm",
  installSpec: "dsh-outline@1.2.3",
};

function recipe(overrides: Partial<SpaceRecipe> = {}): SpaceRecipe {
  return parseSpaceRecipe({
    schemaVersion: 1,
    displayName: "Lab",
    plugins: [outline],
    ...overrides,
  });
}

test("old plugin lists become schemaVersion 1 recipes", () => {
  const template: SpaceTemplate = {
    id: "dev",
    name: "Dev",
    displayName: "Dev box",
    plugins: [outline],
    createdAt: "2026-09-15T00:00:00.000Z",
  };
  const parsed = recipeFromTemplate(template);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.displayName, "Dev box");
  assert.deepEqual(parsed.plugins, [outline]);
  assert.equal(parsed.patch, undefined);
});

test("unknown recipe schema keeps the original meaning of reject", () => {
  assert.throws(
    () => parseSpaceRecipe({ schemaVersion: 2, displayName: "Lab", plugins: [] }),
    /Unsupported space recipe schema 2/,
  );
});

test("damaged recipe objects are rejected instead of repaired", () => {
  assert.throws(() => parseSpaceRecipe({ schemaVersion: 1, plugins: [] }), /display name/i);
  assert.throws(
    () => parseSpaceRecipe({ schemaVersion: 1, displayName: "Lab", plugins: [{ packageName: "x" }] }),
    /invalid source|Original bytes/i,
  );
});

test("apply installs exact npm specs and stops at the first failure", async () => {
  const created: string[] = [];
  const installed: string[] = [];
  const result = await applySpaceRecipe(
    recipe({
      plugins: [
        outline,
        { packageName: "bad-plugin", resolvedVersion: "1.0.0", source: "npm", installSpec: "bad-plugin@1.0.0" },
        { packageName: "later", resolvedVersion: "1.0.0", source: "npm", installSpec: "later@1.0.0" },
      ],
    }),
    {
      createSpace: async (input) => {
        created.push(input.name);
      },
      installPlugin: async (_spaceId, spec) => {
        if (spec.startsWith("bad-plugin@")) throw new Error("incompatible");
        installed.push(spec);
      },
    },
    { name: "lab" },
  );
  assert.deepEqual(created, ["lab"]);
  assert.deepEqual(installed, ["dsh-outline@1.2.3"]);
  assert.equal(result.definition, "imported");
  assert.equal(result.plugins, "failed");
  assert.equal(result.start, "not-run");
  assert.match(result.errors.join("\n"), /incompatible/);
});

test("mismatched installSpec and git plugins are not executed", async () => {
  const installed: string[] = [];
  const result = await applySpaceRecipe(
    recipe({
      plugins: [
        { packageName: "good", resolvedVersion: "1.0.0", source: "npm", installSpec: "evil@1.0.0" },
        { packageName: "from-git", resolvedVersion: "1.0.0", source: "git", installSpec: "github:example/from-git" },
        { packageName: "ok", resolvedVersion: "1.0.0", source: "npm", installSpec: "ok@1.0.0" },
      ],
    }),
    {
      createSpace: async () => undefined,
      installPlugin: async (_spaceId, spec) => {
        installed.push(spec);
      },
    },
    { name: "lab" },
  );
  assert.deepEqual(installed, ["ok@1.0.0"]);
  assert.equal(result.plugins, "pending-manual");
  assert.deepEqual(
    result.pendingManual.map((row) => row.packageName),
    ["good", "from-git"],
  );
});

test("imported config is isolated for the new space id before write", async () => {
  const patches: string[] = [];
  const result = await applySpaceRecipe(
    recipe({
      plugins: [],
      patch: "- id: example\n  config:\n    foo: 1\n",
    }),
    {
      createSpace: async () => undefined,
      installPlugin: async () => undefined,
      writePatch: (_spaceId, patch) => {
        patches.push(patch);
      },
    },
    { name: "lab" },
  );
  assert.equal(result.definition, "imported");
  assert.equal(patches.length, 1);
  assert.match(patches[0] ?? "", /hub\/lab\/sessions/);
  assert.doesNotMatch(patches[0] ?? "", /hub\/web\//);
});

test("invalid isolation is rejected before create", async () => {
  let created = 0;
  const result = await applySpaceRecipe(
    recipe({ patch: "isolation: keep\nuser: setting\n" }),
    {
      createSpace: async () => {
        created += 1;
      },
      installPlugin: async () => undefined,
    },
    { name: "lab" },
  );
  assert.equal(created, 0);
  assert.equal(result.definition, "failed");
  assert.equal(result.plugins, "not-run");
});

test("LLM requirements stay unmapped and do not carry sender bindings", async () => {
  const written: unknown[] = [];
  const llm = {
    schemaVersion: 1 as const,
    kind: "dsh-space-llm-requirements" as const,
    sourceSharedMode: "all" as const,
    requirements: [
      {
        requirementId: "req-1",
        displayName: "Shared",
        protocol: "openai-completions",
        endpoint: "http://127.0.0.1:9/v1",
        modelIds: ["demo-large"],
        authKind: "api-key" as const,
        usedAsDefault: true,
      },
    ],
    defaultRequirementId: "req-1",
    adapterRequired: "llm-pi-ai" as const,
    note: LLM_SHARE_NOTE,
  };
  const result = await applySpaceRecipe(recipe({ plugins: [], llm }), {
    createSpace: async () => undefined,
    installPlugin: async () => undefined,
    writeLlmShare: async (_spaceId, manifest) => {
      written.push(manifest);
    },
  }, { name: "lab" });
  assert.equal(result.definition, "imported");
  assert.equal(result.llm?.mappingRequired, true);
  assert.equal(result.llm?.mapped, false);
  assert.equal(result.llm?.requirements[0]?.requirementId, "req-1");
  const payload = JSON.stringify(written);
  assert.equal(payload.includes("conn-"), false);
  assert.equal(payload.includes("SPACES_LLM_"), false);
  assert.equal(payload.includes("apiKey"), false);
});

test("share parts from formatVersion 1 round-trip as a recipe", () => {
  const parsed = recipeFromShareParts({
    displayName: "Coding",
    plugins: [outline],
    source: { dshVersion: "0.1.5-rc.2" },
  });
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(canonicalNpmInstallSpec(parsed.plugins[0]!), "dsh-outline@1.2.3");
});

test("full Spaces manager specs and unresolved aliases are not installable recipe plugins", () => {
  assert.equal(isFullSpacesManagerSpec("@dsh-spaces/plugin"), true);
  assert.equal(isFullSpacesManagerSpec("@dsh-spaces/plugin@0.2.0"), true);
  assert.equal(isFullSpacesManagerSpec("npm:@dsh-spaces/plugin"), true);
  assert.equal(isFullSpacesManagerSpec("dsh-outline"), false);
  assert.equal(
    canonicalNpmInstallSpec({
      packageName: FULL_SPACES_PACKAGE,
      resolvedVersion: "0.2.0",
      source: "npm",
      installSpec: `${FULL_SPACES_PACKAGE}@0.2.0`,
    }),
    null,
  );
  assert.equal(isUnresolvedPluginAlias("npm:@dsh-spaces/plugin"), true);
  assert.equal(isUnresolvedPluginAlias("node:foo"), true);
  assert.equal(isUnresolvedPluginAlias("file:../hub/plugins/foo.tgz"), true);
  assert.equal(isUnresolvedPluginAlias("dsh-outline@1.2.3"), false);
});

test("web and reserved names cannot be recipe targets", async () => {
  const result = await applySpaceRecipe(recipe({ plugins: [] }), {
    createSpace: async () => {
      throw new Error("should not create");
    },
    installPlugin: async () => undefined,
  }, { name: "web" });
  assert.equal(result.definition, "failed");
  assert.match(result.errors.join("\n"), /web/);
  assert.throws(() => validateImportedPatch("- id: x\n", "web"), /web/);
});

test("old templates.json without schemaVersion or recipe still lists and creates", async () => {
  const dir = home();
  mkdirSync(join(dir, "hub"), { recursive: true });
  const original = `${JSON.stringify({
    templates: [
      {
        id: "dev",
        name: "Dev",
        displayName: "Dev box",
        plugins: [outline],
        createdAt: "2026-09-15T00:00:00.000Z",
      },
    ],
  })}\n`;
  const path = join(dir, "hub", SPACE_TEMPLATES_FILE);
  writeFileSync(path, original);
  const listed = listSpaceTemplates(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.recipe, undefined);
  assert.equal(readFileSync(path, "utf8"), original);
  const created: string[] = [];
  const installed: string[] = [];
  const result = await createSpaceFromTemplate(listed[0]!, "lab", {
    createSpace: async (input) => {
      created.push(input.name);
    },
    installPlugin: async (_spaceId, spec) => {
      installed.push(spec);
    },
  });
  assert.deepEqual(created, ["lab"]);
  assert.deepEqual(installed, ["dsh-outline@1.2.3"]);
  assert.equal(result.plugins, "completed");
});

test("recipes refuse secret config instead of stripping it", () => {
  assert.throws(
    () =>
      parseSpaceRecipe({
        schemaVersion: 1,
        displayName: "Lab",
        plugins: [],
        patch: "apiKey: fake-test-secret-123\n",
      }),
    /secret|credential|apiKey/i,
  );
});

test("public templates project local paths and URL credentials out of plugin specs", () => {
  const template: SpaceTemplate = {
    id: "dev",
    name: "Dev",
    displayName: "Dev box",
    plugins: [
      outline,
      {
        packageName: "local-one",
        resolvedVersion: "1.0.0",
        source: "manual",
        requestedSpec: "file:../../hub/plugins/foo.tgz",
        installSpec: "https://user:pass@example.com/foo.tgz",
      },
    ],
    createdAt: "2026-09-15T00:00:00.000Z",
    recipe: {
      schemaVersion: 1,
      displayName: "Dev box",
      plugins: [
        outline,
        {
          packageName: "local-one",
          resolvedVersion: "1.0.0",
          source: "manual",
          requestedSpec: "file:../../hub/plugins/foo.tgz",
          installSpec: "https://user:pass@example.com/foo.tgz",
        },
      ],
      patch: "- id: example\n  config:\n    foo: 1\n",
    },
  };
  const publicView = publicSpaceTemplate(template);
  assert.equal(publicView.plugins.some((row) => row.requestedSpec?.includes("file:")), false);
  assert.equal(publicView.plugins.some((row) => row.installSpec?.includes("user:pass")), false);
  assert.equal(publicView.recipe?.plugins.some((row) => row.installSpec?.includes("://")), false);
  assert.match(publicView.recipe?.patch ?? "", /foo: 1/);
  assert.equal(template.plugins[1]?.installSpec?.includes("user:pass"), true);
});
