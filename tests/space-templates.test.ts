import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  SPACE_TEMPLATES_FILE,
  createSpaceFromTemplate,
  listSpaceTemplates,
  saveSpaceTemplate,
  spaceTemplateId,
} from "../src/adapters/node/space-templates.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-templates-"));
  temps.push(dir);
  return dir;
}

function writeProfile(dshHome: string, name: string): void {
  const dir = join(dshHome, "profiles", name);
  mkdirSync(join(dir, "node_modules", "dsh-outline"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      dependencies: {
        "@deepseek-ai/dsh-base": "0.1.5-rc.2",
        "dsh-outline": "1.2.3",
      },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-outline"] } },
    }),
  );
  writeFileSync(join(dir, "node_modules", "dsh-outline", "package.json"), JSON.stringify({ name: "dsh-outline", version: "1.2.3" }));
}

test("saving a template copies composition and does not rewrite existing spaces", () => {
  const dir = home();
  writeProfile(dir, "coding");
  const template = saveSpaceTemplate(dir, "coding", "Dev", { displayName: "Dev box" });
  assert.equal(template.plugins.some((row) => row.packageName === "dsh-outline"), true);
  assert.equal(template.plugins.some((row) => row.packageName === "@deepseek-ai/dsh-base"), false);
  writeProfile(dir, "coding");
  const again = saveSpaceTemplate(dir, "coding", "Dev", { displayName: "Renamed template" });
  assert.equal(again.displayName, "Renamed template");
  assert.equal(listSpaceTemplates(dir).length, 1);
  const manifest = JSON.parse(
    readFileSync(join(dir, "profiles", "coding", "package.json"), "utf8"),
  ) as { dsh: { profile: { bundles: string[] } } };
  assert.ok(manifest.dsh.profile.bundles.includes("dsh-outline"));
});

test("creating from a template copies plugins onto a new space only", async () => {
  const installed: string[] = [];
  const created: string[] = [];
  const result = await createSpaceFromTemplate(
    {
      id: "dev",
      name: "Dev",
      displayName: "Dev box",
      plugins: [
        {
          packageName: "dsh-outline",
          resolvedVersion: "1.2.3",
          source: "npm",
          installSpec: "dsh-outline@1.2.3",
        },
      ],
      createdAt: "2026-09-15T00:00:00.000Z",
    },
    "lab",
    {
      createSpace: async (input) => {
        created.push(input.name);
      },
      installPlugin: async (_spaceId, spec) => {
        installed.push(spec);
      },
    },
  );
  assert.deepEqual(created, ["lab"]);
  assert.deepEqual(installed, ["dsh-outline@1.2.3"]);
  assert.equal(result.plugins, "completed");
});

test("corrupt template bytes fail instead of returning empty and are not overwritten", () => {
  const dir = home();
  mkdirSync(join(dir, "hub"), { recursive: true });
  const path = join(dir, "hub", SPACE_TEMPLATES_FILE);
  const original = "{not-json";
  writeFileSync(path, original);
  assert.throws(() => listSpaceTemplates(dir), /invalid|unchanged/i);
  writeProfile(dir, "coding");
  assert.throws(() => saveSpaceTemplate(dir, "coding", "Dev"), /invalid|unchanged/i);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("invalid template fields fail instead of becoming a partial template", () => {
  const dir = home();
  mkdirSync(join(dir, "hub"), { recursive: true });
  const path = join(dir, "hub", SPACE_TEMPLATES_FILE);
  writeFileSync(path, JSON.stringify({ templates: [{ id: "dev", name: "Dev", plugins: [] }] }));
  assert.throws(() => listSpaceTemplates(dir), /invalid template|unchanged/i);
});

test("chinese names and truncated slugs get stable ids and do not overwrite a different template", () => {
  const dir = home();
  writeProfile(dir, "coding");
  const first = saveSpaceTemplate(dir, "coding", "开发环境", { displayName: "Dev ZH" });
  const second = saveSpaceTemplate(dir, "coding", "测试环境", { displayName: "Test ZH" });
  assert.notEqual(first.id, second.id);
  assert.equal(first.id, spaceTemplateId("开发环境"));
  assert.equal(listSpaceTemplates(dir).length, 2);
  const longA = `${"a".repeat(40)}-one`;
  const longB = `${"a".repeat(40)}-two`;
  const a = saveSpaceTemplate(dir, "coding", longA, { displayName: "A" });
  const b = saveSpaceTemplate(dir, "coding", longB, { displayName: "B" });
  assert.notEqual(a.id, b.id);
  assert.equal(listSpaceTemplates(dir).some((row) => row.name === longA), true);
  assert.equal(listSpaceTemplates(dir).some((row) => row.name === longB), true);
});

test("saving the same logical template name updates that template only", () => {
  const dir = home();
  writeProfile(dir, "coding");
  const first = saveSpaceTemplate(dir, "coding", "Dev", { displayName: "Original" });
  const second = saveSpaceTemplate(dir, "coding", "Dev", { displayName: "Updated" });
  assert.equal(second.id, first.id);
  const listed = listSpaceTemplates(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.displayName, "Updated");
});

test("template creation does not execute a mismatched installSpec", async () => {
  const installed: string[] = [];
  const result = await createSpaceFromTemplate(
    {
      id: "dev",
      name: "Dev",
      displayName: "Dev box",
      plugins: [
        { packageName: "good", resolvedVersion: "1.0.0", source: "npm", installSpec: "evil@1.0.0" },
        { packageName: "ok", resolvedVersion: "1.0.0", source: "npm", installSpec: "ok@1.0.0" },
      ],
      createdAt: "2026-09-15T00:00:00.000Z",
    },
    "lab",
    {
      createSpace: async () => undefined,
      installPlugin: async (_spaceId, spec) => {
        installed.push(spec);
      },
    },
  );
  assert.deepEqual(installed, ["ok@1.0.0"]);
  assert.equal(result.plugins, "pending-manual");
});

test("unknown templates schema keeps original bytes", () => {
  const dir = home();
  mkdirSync(join(dir, "hub"), { recursive: true });
  const path = join(dir, "hub", SPACE_TEMPLATES_FILE);
  const original = JSON.stringify({ schemaVersion: 2, templates: [] });
  writeFileSync(path, original);
  assert.throws(() => listSpaceTemplates(dir), /Unsupported space templates schema 2/);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("saving a template with secret config is rejected and original bytes stay", () => {
  const dir = home();
  writeProfile(dir, "coding");
  mkdirSync(join(dir, "hub"), { recursive: true });
  const path = join(dir, "hub", SPACE_TEMPLATES_FILE);
  const original = `${JSON.stringify({ templates: [] })}\n`;
  writeFileSync(path, original);
  writeFileSync(join(dir, "profiles", "coding", "cordis.patch.yml"), "apiKey: fake-test-secret-123\n");
  assert.throws(() => saveSpaceTemplate(dir, "coding", "example", { includeConfig: true }), /secret|credential|apiKey/i);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(readFileSync(path, "utf8").includes("fake-test-secret-123"), false);
});

test("non-secret template config is kept and written back on create", async () => {
  const dir = home();
  writeProfile(dir, "coding");
  writeFileSync(join(dir, "profiles", "coding", "cordis.patch.yml"), "- id: example\n  config:\n    foo: 1\n");
  const template = saveSpaceTemplate(dir, "coding", "Dev", { displayName: "Dev box", includeConfig: true });
  assert.match(template.recipe?.patch ?? "", /foo: 1/);
  assert.equal((template.recipe?.patch ?? "").includes("apiKey"), false);
  const patches: string[] = [];
  const result = await createSpaceFromTemplate(template, "lab", {
    createSpace: async () => undefined,
    installPlugin: async () => undefined,
    writePatch: (_spaceId, patch) => {
      patches.push(patch);
    },
  });
  assert.equal(result.plugins, "completed");
  assert.equal(patches.length, 1);
  assert.match(patches[0] ?? "", /hub\/lab\/sessions/);
  assert.match(patches[0] ?? "", /foo: 1/);
});

test("template install failure is reported and does not rewrite other spaces", async () => {
  const result = await createSpaceFromTemplate(
    {
      id: "dev",
      name: "Dev",
      displayName: "Dev box",
      plugins: [
        { packageName: "good", resolvedVersion: "1.0.0", source: "npm", installSpec: "good@1.0.0" },
        { packageName: "bad", resolvedVersion: "1.0.0", source: "npm", installSpec: "bad@1.0.0" },
      ],
      createdAt: "2026-09-15T00:00:00.000Z",
    },
    "lab",
    {
      createSpace: async () => undefined,
      installPlugin: async (_spaceId, spec) => {
        if (spec.startsWith("bad@")) throw new Error("template plugin failed");
      },
    },
  );
  assert.equal(result.spaceId, "lab");
  assert.equal(result.plugins, "failed");
  assert.match(result.errors.join("\n"), /template plugin failed/);
});
