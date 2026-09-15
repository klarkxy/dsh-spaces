import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createSpaceFromTemplate,
  listSpaceTemplates,
  saveSpaceTemplate,
} from "../src/main/space-templates.ts";

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
