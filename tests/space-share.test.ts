import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  buildSpaceShare,
  canonicalNpmInstallSpec,
  exportSpaceArchive,
  importSpaceArchive,
  parseSpaceShare,
  pluginToShare,
  previewSpaceShare,
  uniqueSpaceName,
} from "../src/adapters/node/space-share.ts";
import { PLUGIN_LIBRARY_FILE } from "../src/adapters/node/plugin-library.ts";
import { packZip } from "../src/adapters/node/space-share-zip.ts";
import type { InstalledPlugin } from "../src/shared/types.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-space-share-"));
  temps.push(dir);
  return dir;
}

function writeProfile(
  dshHome: string,
  name: string,
  bundles: string[],
  dependencies: Record<string, string>,
  resolved: Record<string, string> = {},
): void {
  const dir = join(dshHome, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      dependencies,
      dsh: { profile: { bundles } },
    }),
  );
  for (const [pkg, version] of Object.entries(resolved)) {
    const pkgDir = join(dir, "node_modules", ...pkg.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version }));
  }
}

const samplePlugins: InstalledPlugin[] = [
  { name: "@deepseek-ai/dsh-base", version: "0.1.5-rc.2", protected: true },
  { name: "@deepseek-ai/dsh-web-app", version: "0.1.5-rc.2", protected: true },
  {
    name: "dsh-outline",
    requestedSpec: "1.2.3",
    resolvedVersion: "1.2.3",
    version: "1.2.3",
    protected: false,
  },
  {
    name: "custom-git",
    requestedSpec: "github:example/custom-git",
    resolvedVersion: null,
    version: null,
    protected: false,
  },
];

test("export records plugin composition and omits host packages", () => {
  const share = buildSpaceShare({
    displayName: "Coding",
    plugins: samplePlugins,
    dshVersion: "0.1.5-rc.2",
  });
  assert.equal(share.manifest.kind, "dsh-space");
  assert.deepEqual(
    share.plugins.map((row) => row.packageName),
    ["dsh-outline", "custom-git"],
  );
  assert.equal(share.plugins[0].source, "npm");
  assert.equal(share.plugins[0].resolvedVersion, "1.2.3");
  assert.equal(share.plugins[1].source, "git");
  assert.equal(share.patch, undefined);
});

test("export includes optional config only when requested", () => {
  const withConfig = buildSpaceShare({
    displayName: "Coding",
    plugins: samplePlugins,
    patch: "isolation: keep\nuser: setting\n",
    includeConfig: true,
  });
  assert.match(withConfig.patch ?? "", /user: setting/);
  const without = buildSpaceShare({
    displayName: "Coding",
    plugins: samplePlugins,
    patch: "isolation: keep\n",
    includeConfig: false,
  });
  assert.equal(without.patch, undefined);
});

test("exportSpaceArchive round-trips plugin order from a real profile", () => {
  const dir = home();
  writeProfile(
    dir,
    "coding",
    ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-outline"],
    {
      "@deepseek-ai/dsh-base": "0.1.5-rc.2",
      "@deepseek-ai/dsh-web-app": "0.1.5-rc.2",
      "dsh-outline": "1.2.3",
    },
    { "dsh-outline": "1.2.3" },
  );
  const archive = exportSpaceArchive(dir, "coding", { displayName: "Coding" });
  const parsed = parseSpaceShare(archive);
  assert.equal(parsed.manifest.space.displayName, "Coding");
  assert.deepEqual(
    parsed.plugins.map((row) => row.packageName),
    ["dsh-outline"],
  );
  assert.equal(parsed.plugins[0].resolvedVersion, "1.2.3");
});

test("preview lists unknown sources without treating the share as whole-Home recovery", () => {
  const share = buildSpaceShare({ displayName: "Lab", plugins: samplePlugins });
  const preview = previewSpaceShare(packZip([
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(share.manifest)}\n`) },
    { name: "plugins.json", data: Buffer.from(`${JSON.stringify(share.plugins)}\n`) },
  ]));
  assert.deepEqual(preview.unknownSources, ["custom-git"]);
  assert.equal(preview.hasConfig, false);
});

test("import splits definition, plugins, and start and does not start the space", async () => {
  const created: string[] = [];
  const installed: string[] = [];
  const share = buildSpaceShare({ displayName: "Imported Lab", plugins: samplePlugins });
  const archive = packZip([
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(share.manifest)}\n`) },
    { name: "plugins.json", data: Buffer.from(`${JSON.stringify(share.plugins)}\n`) },
  ]);
  const result = await importSpaceArchive(archive, {
    listSpaceIds: () => ["web", "coding"],
    createSpace: async (input) => {
      created.push(input.name);
    },
    installPlugin: async (_spaceId, spec) => {
      installed.push(spec);
    },
  });
  assert.equal(result.definition, "imported");
  assert.equal(result.plugins, "pending-manual");
  assert.equal(result.start, "not-run");
  assert.equal(created.length, 1);
  assert.deepEqual(installed, ["dsh-outline@1.2.3"]);
  assert.equal(result.pendingManual[0]?.packageName, "custom-git");
  assert.equal(result.spaceId, created[0]);
});

test("import keeps the space when a legal plugin combo fails to install", async () => {
  const created: string[] = [];
  const installed: string[] = [];
  const share = buildSpaceShare({
    displayName: "Broken Combo",
    plugins: [
      {
        name: "good-plugin",
        requestedSpec: "1.0.0",
        resolvedVersion: "1.0.0",
        version: "1.0.0",
        protected: false,
      },
      {
        name: "bad-plugin",
        requestedSpec: "1.0.0",
        resolvedVersion: "1.0.0",
        version: "1.0.0",
        protected: false,
      },
    ],
  });
  const archive = packZip([
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(share.manifest)}\n`) },
    { name: "plugins.json", data: Buffer.from(`${JSON.stringify(share.plugins)}\n`) },
  ]);
  const result = await importSpaceArchive(archive, {
    listSpaceIds: () => [],
    createSpace: async (input) => {
      created.push(input.name);
    },
    installPlugin: async (_spaceId, spec) => {
      if (spec.includes("bad-plugin")) throw new Error("incompatible");
      installed.push(spec);
    },
  });
  assert.equal(result.definition, "imported");
  assert.equal(result.plugins, "failed");
  assert.equal(result.start, "not-run");
  assert.equal(created.length, 1);
  assert.deepEqual(installed, ["good-plugin@1.0.0"]);
  assert.match(result.errors.join("\n"), /incompatible/);
});

test("invalid archive does not create a space", async () => {
  let created = 0;
  const result = await importSpaceArchive(Buffer.from("not-a-zip"), {
    listSpaceIds: () => [],
    createSpace: async () => {
      created += 1;
    },
    installPlugin: async () => undefined,
  });
  assert.equal(result.definition, "failed");
  assert.equal(result.plugins, "not-run");
  assert.equal(result.start, "not-run");
  assert.equal(created, 0);
});

test("invalid manifest field types do not escape the import result", async () => {
  let created = 0;
  const archive = packZip([
    {
      name: "manifest.json",
      data: Buffer.from(JSON.stringify({
        formatVersion: 1,
        kind: "dsh-space",
        exportedAt: "2026-09-15T00:00:00.000Z",
        source: {},
        space: { displayName: { unexpected: true } },
      })),
    },
    { name: "plugins.json", data: Buffer.from("[]") },
  ]);
  const result = await importSpaceArchive(archive, {
    listSpaceIds: () => [],
    createSpace: async () => {
      created += 1;
    },
    installPlugin: async () => undefined,
  });
  assert.equal(result.definition, "failed");
  assert.equal(result.plugins, "not-run");
  assert.equal(created, 0);
});

test("uniqueSpaceName avoids web and existing ids", () => {
  assert.equal(uniqueSpaceName("Coding", []), "coding");
  assert.equal(uniqueSpaceName("Coding", ["coding"]), "coding-2");
  assert.notEqual(uniqueSpaceName("Web", ["web"]), "web");
});

test("npm range requested specs round-trip as exact packageName@version", () => {
  const caret = pluginToShare({
    name: "dsh-outline",
    requestedSpec: "^1.2.3",
    resolvedVersion: "1.2.3",
    version: "1.2.3",
    protected: false,
  });
  assert.equal(caret?.source, "npm");
  assert.equal(caret?.installSpec, "dsh-outline@1.2.3");
  assert.equal(canonicalNpmInstallSpec(caret!), "dsh-outline@1.2.3");
  const tilde = pluginToShare({
    name: "dsh-outline",
    requestedSpec: "~1.2.3",
    resolvedVersion: "1.2.3",
    version: "1.2.3",
    protected: false,
  });
  assert.equal(tilde?.installSpec, "dsh-outline@1.2.3");
});

test("hub file cache specs round-trip only when the library proves an exact npm spec", () => {
  const dir = home();
  mkdirSync(join(dir, "profiles", "coding"), { recursive: true });
  mkdirSync(join(dir, "hub", "plugins"), { recursive: true });
  const tarball = "hub/plugins/dsh-outline@1.2.3.tgz";
  writeFileSync(join(dir, tarball), "fixture");
  const fileSpec = "file:../../hub/plugins/dsh-outline@1.2.3.tgz";
  const proved = pluginToShare(
    {
      name: "dsh-outline",
      requestedSpec: fileSpec,
      resolvedVersion: "1.2.3",
      version: "1.2.3",
      protected: false,
    },
    {
      library: [
        {
          id: "dsh-outline@1.2.3",
          spec: "dsh-outline@1.2.3",
          packageName: "dsh-outline",
          title: "outline",
          source: "catalog",
          tarball,
          downloadedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
      dshHome: dir,
      spaceId: "coding",
    },
  );
  assert.equal(proved?.source, "npm");
  assert.equal(proved?.installSpec, "dsh-outline@1.2.3");
  const unproved = pluginToShare({
    name: "dsh-outline",
    requestedSpec: fileSpec,
    resolvedVersion: "1.2.3",
    version: "1.2.3",
    protected: false,
  });
  assert.equal(unproved?.source, "manual");
  assert.equal(canonicalNpmInstallSpec(unproved!), null);
});

test("exportSpaceArchive keeps bundle order for range and hub-cache plugins", () => {
  const dir = home();
  writeProfile(
    dir,
    "coding",
    ["@deepseek-ai/dsh-base", "alpha-plugin", "beta-plugin"],
    {
      "@deepseek-ai/dsh-base": "0.1.5-rc.2",
      "alpha-plugin": "^1.2.3",
      "beta-plugin": "~2.0.0",
    },
    { "alpha-plugin": "1.2.3", "beta-plugin": "2.0.1" },
  );
  mkdirSync(join(dir, "hub"), { recursive: true });
  writeFileSync(
    join(dir, "hub", PLUGIN_LIBRARY_FILE),
    `${JSON.stringify({
      plugins: [
        {
          id: "alpha-plugin@1.2.3",
          spec: "alpha-plugin@1.2.3",
          packageName: "alpha-plugin",
          title: "alpha",
          source: "catalog",
          downloadedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
    })}\n`,
  );
  const parsed = parseSpaceShare(exportSpaceArchive(dir, "coding", { displayName: "Coding" }));
  assert.deepEqual(
    parsed.plugins.map((row) => row.packageName),
    ["alpha-plugin", "beta-plugin"],
  );
  assert.equal(parsed.plugins[0]?.installSpec, "alpha-plugin@1.2.3");
  assert.equal(parsed.plugins[1]?.installSpec, "beta-plugin@2.0.1");
});

test("import does not execute latest, git, other packages, or mismatched installSpec", async () => {
  const installed: string[] = [];
  const share = {
    manifest: {
      formatVersion: 1 as const,
      kind: "dsh-space" as const,
      exportedAt: "2026-09-15T00:00:00.000Z",
      source: {},
      space: { displayName: "Pinned" },
    },
    plugins: [
      { packageName: "good", resolvedVersion: "1.0.0", source: "npm" as const, installSpec: "good@latest" },
      { packageName: "also-good", resolvedVersion: "1.0.0", source: "npm" as const, installSpec: "evil@1.0.0" },
      {
        packageName: "from-git",
        resolvedVersion: "1.0.0",
        source: "git" as const,
        installSpec: "github:example/from-git",
      },
      { packageName: "ok", resolvedVersion: "1.0.0", source: "npm" as const, installSpec: "ok@1.0.0" },
    ],
  };
  const result = await importSpaceArchive(
    packZip([
      { name: "manifest.json", data: Buffer.from(`${JSON.stringify(share.manifest)}\n`) },
      { name: "plugins.json", data: Buffer.from(`${JSON.stringify(share.plugins)}\n`) },
    ]),
    {
      listSpaceIds: () => [],
      createSpace: async () => undefined,
      installPlugin: async (_spaceId, spec) => {
        installed.push(spec);
      },
    },
  );
  assert.equal(result.definition, "imported");
  assert.equal(result.plugins, "pending-manual");
  assert.deepEqual(installed, ["ok@1.0.0"]);
  assert.deepEqual(
    result.pendingManual.map((row) => row.packageName),
    ["good", "also-good", "from-git"],
  );
});

test("import does not auto-install the full Spaces manager", async () => {
  const installed: string[] = [];
  const result = await importSpaceArchive(
    packZip([
      {
        name: "manifest.json",
        data: Buffer.from(`${JSON.stringify({
          formatVersion: 1,
          kind: "dsh-space",
          exportedAt: "2026-09-15T00:00:00.000Z",
          source: {},
          space: { displayName: "Hub" },
        })}\n`),
      },
      {
        name: "plugins.json",
        data: Buffer.from(`${JSON.stringify([
          {
            packageName: "@dsh-spaces/plugin",
            resolvedVersion: "0.3.0",
            source: "npm",
            installSpec: "@dsh-spaces/plugin@0.3.0",
          },
        ])}\n`),
      },
    ]),
    {
      listSpaceIds: () => [],
      createSpace: async () => undefined,
      installPlugin: async (_spaceId, spec) => {
        installed.push(spec);
      },
    },
  );
  assert.equal(result.definition, "imported");
  assert.equal(result.plugins, "pending-manual");
  assert.deepEqual(installed, []);
  assert.equal(result.pendingManual[0]?.packageName, "@dsh-spaces/plugin");
});

test("invalid config is rejected before creating a space or installing plugins", async () => {
  let created = 0;
  let installed = 0;
  let wrotePatch = 0;
  const share = buildSpaceShare({ displayName: "Broken Patch", plugins: samplePlugins });
  const result = await importSpaceArchive(
    packZip([
      { name: "manifest.json", data: Buffer.from(`${JSON.stringify(share.manifest)}\n`) },
      { name: "plugins.json", data: Buffer.from(`${JSON.stringify(share.plugins)}\n`) },
      { name: "profile.patch.yml", data: Buffer.from("isolation: keep\nuser: setting\n") },
    ]),
    {
      listSpaceIds: () => [],
      createSpace: async () => {
        created += 1;
      },
      installPlugin: async () => {
        installed += 1;
      },
    },
    {
      writePatch: () => {
        wrotePatch += 1;
      },
    },
  );
  assert.equal(result.definition, "failed");
  assert.equal(result.plugins, "not-run");
  assert.equal(result.start, "not-run");
  assert.equal(created, 0);
  assert.equal(installed, 0);
  assert.equal(wrotePatch, 0);
  assert.equal(result.spaceId, undefined);
});

test("zip path traversal is rejected and original bytes are not imported", async () => {
  let created = 0;
  const archive = packZip([{ name: "../hub/settings.json", data: Buffer.from("stolen") }]);
  const result = await importSpaceArchive(archive, {
    listSpaceIds: () => [],
    createSpace: async () => {
      created += 1;
    },
    installPlugin: async () => undefined,
  });
  assert.equal(result.definition, "failed");
  assert.equal(created, 0);
  assert.match(result.errors.join("\n"), /unsafe path/i);
});

test("valid config is isolated in memory then written only after the space exists", async () => {
  const created: string[] = [];
  const patches: string[] = [];
  const share = buildSpaceShare({ displayName: "With Config", plugins: [] });
  const result = await importSpaceArchive(
    packZip([
      { name: "manifest.json", data: Buffer.from(`${JSON.stringify(share.manifest)}\n`) },
      { name: "plugins.json", data: Buffer.from(`${JSON.stringify(share.plugins)}\n`) },
      {
        name: "profile.patch.yml",
        data: Buffer.from("- id: example\n  config:\n    foo: 1\n"),
      },
    ]),
    {
      listSpaceIds: () => [],
      createSpace: async (input) => {
        created.push(input.name);
      },
      installPlugin: async () => undefined,
    },
    {
      writePatch: (spaceId, patch) => {
        assert.equal(created.includes(spaceId), true);
        patches.push(patch);
      },
    },
  );
  assert.equal(result.definition, "imported");
  assert.equal(created.length, 1);
  assert.equal(patches.length, 1);
  assert.match(patches[0] ?? "", /hub\/with-config\/sessions/);
});
