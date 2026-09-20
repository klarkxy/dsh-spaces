import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { HomeOperationLock } from "../src/adapters/node/home-operation-lock.ts";
import { WorkbenchProductService, type WorkbenchProductPorts } from "../src/adapters/node/workbench-products.ts";
import type { WorkbenchJobContext } from "../src/adapters/node/workbench-jobs.ts";
import { archiveRelPath, upsertLibraryEntry } from "../src/adapters/node/plugin-library.ts";
import { CATALOG_CACHE_FILE } from "../src/adapters/node/plugin-catalog.ts";
import { packSpaceShare, pluginToShare } from "../src/adapters/node/space-share.ts";
import { packZip } from "../src/adapters/node/space-share-zip.ts";
import { SPACE_TEMPLATES_FILE } from "../src/adapters/node/space-templates.ts";
import { emptyCatalog, emptyPolicy } from "../src/core/domain/llm-connections.ts";
import { buildLlmShareManifest } from "../src/core/domain/llm-share.ts";
import type { LlmApiResult } from "../src/shared/llm-api.ts";
import type { WorkbenchSpace } from "../src/shared/workbench.ts";
import {
  MAX_WORKBENCH_SHARE_BYTES,
  type WorkbenchHomeSettings,
  type WorkbenchProductObservation,
  type WorkbenchProductOutcome,
} from "../src/shared/workbench-product.ts";
import { DEFAULT_HUB_SETTINGS } from "../src/shared/types.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-products-"));
  temps.push(dir);
  mkdirSync(join(dir, "hub"), { recursive: true });
  mkdirSync(join(dir, "profiles"), { recursive: true });
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

const emptyLlm = buildLlmShareManifest({ catalog: emptyCatalog(), policy: emptyPolicy() });

function jobCtx(): { ctx: WorkbenchJobContext; recorded: unknown[] } {
  const recorded: unknown[] = [];
  return {
    recorded,
    ctx: {
      signal: new AbortController().signal,
      phase() {},
      message() {},
      cancellable() {},
      result(value) {
        recorded.push(value);
      },
    },
  };
}

function observation(epoch = "epoch-1"): WorkbenchProductObservation {
  return { serviceEpoch: epoch, expectedRevision: "rev-1" };
}

function space(id: string, extra: Partial<WorkbenchSpace> = {}): WorkbenchSpace {
  return {
    id,
    displayName: id,
    isHost: false,
    hasWebApp: true,
    isolation: "verified",
    icon: "box",
    status: "stopped",
    generation: 1,
    managed: true,
    needsIsolation: false,
    ...extra,
  };
}

function createService(
  dshHome: string,
  overrides: Partial<WorkbenchProductPorts> & {
    spaces?: WorkbenchSpace[];
    created?: string[];
    installed?: string[];
    epoch?: string;
    now?: () => Date;
  } = {},
): WorkbenchProductService {
  const spaces = overrides.spaces ?? [space("coding")];
  const created = overrides.created ?? [];
  const installed = overrides.installed ?? [];
  const lock = new HomeOperationLock(dshHome);
  const ports: WorkbenchProductPorts = {
    home: dshHome,
    observation: overrides.observation ?? (() => observation(overrides.epoch)),
    managerId: overrides.managerId ?? (() => "manager"),
    listSpaces: overrides.listSpaces ?? (() => spaces),
    createSpace:
      overrides.createSpace ??
      (async (input) => {
        created.push(input.name);
        spaces.push(space(input.name, { displayName: input.displayName || input.name }));
      }),
    installPlugin:
      overrides.installPlugin ??
      (async (_spaceId, spec) => {
        installed.push(spec);
      }),
    llm: overrides.llm ?? (async () => emptyLlm as LlmApiResult),
    diagnostics:
      overrides.diagnostics ??
      ((spaceId) => ({
        spaceId,
        status: "stopped",
        logs: [],
        backups: [],
      })),
    withWrite: overrides.withWrite ?? ((label, action) => lock.run(label, action)),
    settingsChanged: overrides.settingsChanged,
    now: overrides.now,
    fetchImpl: overrides.fetchImpl,
    packGit: overrides.packGit,
    writePatch: overrides.writePatch,
    writeLlmShare: overrides.writeLlmShare,
  };
  return new WorkbenchProductService(ports);
}

function shareArchive(plugins = [
  {
    name: "dsh-outline",
    requestedSpec: "1.2.3",
    resolvedVersion: "1.2.3",
    version: "1.2.3",
    protected: false as const,
  },
  {
    name: "bad-plugin",
    requestedSpec: "1.0.0",
    resolvedVersion: "1.0.0",
    version: "1.0.0",
    protected: false as const,
  },
]) {
  const share = {
    displayName: "Imported Lab",
    plugins: plugins.map((plugin) => pluginToShare(plugin)!),
  };
  return packSpaceShare({
    manifest: {
      formatVersion: 1,
      kind: "dsh-space",
      exportedAt: "2026-09-15T00:00:00.000Z",
      source: { dshVersion: null },
      space: { displayName: share.displayName },
    },
    plugins: share.plugins,
  });
}

test("settings read returns client defaults and update preserves locale, theme, and unknown fields", async () => {
  const dir = home();
  writeFileSync(
    join(dir, "hub", "settings.json"),
    `${JSON.stringify({
      portStart: 3100,
      portEnd: 3199,
      quitBehavior: "keep",
      extraFlag: true,
      locale: "zh",
      theme: "dark",
      packageSource: "official",
      catalogUrl: "",
    })}\n`,
  );
  const changed: WorkbenchHomeSettings[] = [];
  const service = createService(dir, { settingsChanged: (settings) => changed.push(settings) });
  const before = await service.read({ method: "settings" });
  assert.equal(before.method, "settings");
  if (before.method !== "settings") return;
  assert.equal(before.clientDefaults.locale, "zh");
  assert.equal(before.clientDefaults.theme, "dark");
  const { ctx } = jobCtx();
  await service.execute(
    {
      kind: "settings.update",
      settings: { portStart: 4100, portEnd: 4199, packageSource: "china", catalogUrl: "https://example.com/c.json" },
    },
    ctx,
  );
  const stored = JSON.parse(readFileSync(join(dir, "hub", "settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal(stored.portStart, 4100);
  assert.equal(stored.packageSource, "china");
  assert.equal(stored.locale, "zh");
  assert.equal(stored.theme, "dark");
  assert.equal(stored.quitBehavior, "keep");
  assert.equal(stored.extraFlag, true);
  assert.deepEqual(changed[0]?.catalogUrl, "https://example.com/c.json");
});

test("catalog read uses seed when cache is missing and does not write", async () => {
  const dir = home();
  let fetched = 0;
  const service = createService(dir, {
    fetchImpl: async () => {
      fetched += 1;
      throw new Error("network should not run");
    },
  });
  const result = await service.read({ method: "catalog", query: "outline" });
  assert.equal(result.method, "catalog");
  if (result.method !== "catalog") return;
  assert.equal(result.catalog.source, "seed");
  assert.ok(result.catalog.entries.some((entry) => entry.id.includes("outline") || entry.installSpec === "dsh-outline"));
  assert.equal(existsSync(join(dir, "hub", CATALOG_CACHE_FILE)), false);
  assert.equal(fetched, 0);
});

test("corrupt catalog cache fails instead of returning seed", async () => {
  const dir = home();
  const path = join(dir, "hub", CATALOG_CACHE_FILE);
  writeFileSync(path, "{not-json");
  const service = createService(dir);
  await assert.rejects(service.read({ method: "catalog" }), /could not be read|invalid/i);
  assert.equal(readFileSync(path, "utf8"), "{not-json");
});

test("explicit catalog refresh failure does not fall back to seed", async () => {
  const dir = home();
  const service = createService(dir, {
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const { ctx } = jobCtx();
  await assert.rejects(service.execute({ kind: "catalog.refresh" }, ctx), /offline/);
  assert.equal(existsSync(join(dir, "hub", CATALOG_CACHE_FILE)), false);
});

test("library public view hides tarball paths and raw specs and does not sync", async () => {
  const dir = home();
  writeProfile(dir, "coding", ["dsh-outline"], { "dsh-outline": "1.2.3" }, { "dsh-outline": "1.2.3" });
  mkdirSync(join(dir, "hub", "plugins"), { recursive: true });
  writeFileSync(join(dir, "hub", "plugins", "secret.tgz"), "tarball");
  upsertLibraryEntry(dir, {
    id: "dsh-outline@1.2.3",
    spec: "dsh-outline@1.2.3",
    packageName: "dsh-outline",
    title: "outline",
    tarball: "hub/plugins/secret.tgz",
    source: "catalog",
    downloadedAt: "2026-09-15T00:00:00.000Z",
  });
  const before = readFileSync(join(dir, "hub", "plugin-library.json"), "utf8");
  const service = createService(dir, { spaces: [space("coding")] });
  const result = await service.read({ method: "library" });
  assert.equal(result.method, "library");
  if (result.method !== "library") return;
  const json = JSON.stringify(result);
  assert.equal(json.includes("hub/plugins"), false);
  assert.equal(json.includes("secret.tgz"), false);
  assert.equal(json.includes("tarball"), false);
  assert.equal("spec" in (result.items[0] ?? {}), false);
  assert.equal(result.items[0]?.version, "1.2.3");
  assert.deepEqual(result.items[0]?.installedIn, ["coding"]);
  assert.equal(readFileSync(join(dir, "hub", "plugin-library.json"), "utf8"), before);
});

test("plugin download rejects URLs, credentials, local paths, and commands", async () => {
  const dir = home();
  const service = createService(dir, {
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  const { ctx } = jobCtx();
  await assert.rejects(
    service.execute({ kind: "plugin.download", spec: "https://user:pass@example.com/pkg.tgz" }, ctx),
    /URL|credential|local path/i,
  );
  await assert.rejects(
    service.execute({ kind: "plugin.download", spec: "file:../hub/plugins/foo.tgz" }, ctx),
    /URL|credential|local path|not allowed/i,
  );
  await assert.rejects(
    service.execute({ kind: "plugin.download", spec: "npm:@dsh-spaces/plugin" }, ctx),
    /URL|credential|local path|not allowed/i,
  );
  await assert.rejects(
    service.execute({ kind: "plugin.download", spec: "dsh-outline; rm -rf /" }, ctx),
    /command|not allowed/i,
  );
});

test("plugin download pins an exact version through the existing download flow", async () => {
  const dir = home();
  const service = createService(dir, {
    fetchImpl: async (url) => {
      if (!url.endsWith(".tgz")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            name: "dsh-outline",
            versions: {
              "1.2.3": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-1.2.3.tgz" } },
            },
          }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({}),
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      };
    },
  });
  const { ctx, recorded } = jobCtx();
  const outcome = await service.execute({ kind: "plugin.download", spec: "dsh-outline@1.2.3" }, ctx);
  assert.equal(outcome.kind, "plugin.download");
  if (outcome.kind !== "plugin.download") return;
  assert.equal(outcome.item.packageName, "dsh-outline");
  assert.equal(outcome.item.version, "1.2.3");
  assert.equal("tarball" in outcome.item, false);
  assert.equal(JSON.stringify(recorded).includes(".tgz"), false);
});

test("library remove refuses plugins still in use", async () => {
  const dir = home();
  writeProfile(dir, "coding", ["dsh-outline"], { "dsh-outline": "1" });
  upsertLibraryEntry(dir, {
    id: "dsh-outline",
    spec: "dsh-outline",
    packageName: "dsh-outline",
    title: "dsh-outline",
    source: "installed",
    downloadedAt: "t",
  });
  const service = createService(dir, { spaces: [space("coding")] });
  const { ctx } = jobCtx();
  await assert.rejects(service.execute({ kind: "plugin.library.remove", libraryId: "dsh-outline" }, ctx), /installed|仍安装/);
});

test("library installedIn distinguishes exact cache versions", async () => {
  const dir = home();
  const pkg = "@dsh-spaces/plugin";
  const older = `${pkg}@0.3.0`;
  const candidate = `${pkg}@0.3.1-test.1`;
  mkdirSync(join(dir, "hub", "plugins"), { recursive: true });
  writeFileSync(join(dir, archiveRelPath(older)), "old");
  writeFileSync(join(dir, archiveRelPath(candidate)), "candidate");
  writeProfile(dir, "coding", [pkg], { [pkg]: older }, { [pkg]: "0.3.0" });
  writeProfile(dir, "notes", [pkg], { [pkg]: candidate }, { [pkg]: "0.3.1-test.1" });
  upsertLibraryEntry(dir, {
    id: older,
    spec: older,
    packageName: pkg,
    title: pkg,
    tarball: archiveRelPath(older),
    source: "catalog",
    downloadedAt: "t",
  });
  upsertLibraryEntry(dir, {
    id: candidate,
    spec: candidate,
    packageName: pkg,
    title: pkg,
    tarball: archiveRelPath(candidate),
    source: "catalog",
    downloadedAt: "t",
  });
  const service = createService(dir, { spaces: [space("coding"), space("notes")] });
  const result = await service.read({ method: "library" });
  assert.equal(result.method, "library");
  if (result.method !== "library") return;
  const byId = new Map(result.items.map((item) => [item.id, item]));
  assert.deepEqual(byId.get(older)?.installedIn, ["coding"]);
  assert.deepEqual(byId.get(candidate)?.installedIn, ["notes"]);
});

test("library remove deletes an unused exact candidate while an older exact install stays", async () => {
  const dir = home();
  const pkg = "@dsh-spaces/plugin";
  const older = `${pkg}@0.3.0`;
  const candidate = `${pkg}@0.3.1-test.1`;
  mkdirSync(join(dir, "hub", "plugins"), { recursive: true });
  const oldInstallTar = join(dir, "hub", "plugins", "dsh-spaces-plugin.tgz");
  writeFileSync(oldInstallTar, "old-install");
  writeFileSync(join(dir, archiveRelPath(older)), "old");
  writeFileSync(join(dir, archiveRelPath(candidate)), "candidate");
  writeProfile(
    dir,
    "coding",
    [pkg],
    { [pkg]: "file:../../hub/plugins/dsh-spaces-plugin.tgz" },
    { [pkg]: "0.3.0" },
  );
  upsertLibraryEntry(dir, {
    id: older,
    spec: older,
    packageName: pkg,
    title: pkg,
    tarball: archiveRelPath(older),
    source: "catalog",
    downloadedAt: "t",
  });
  upsertLibraryEntry(dir, {
    id: candidate,
    spec: candidate,
    packageName: pkg,
    title: pkg,
    tarball: archiveRelPath(candidate),
    source: "catalog",
    downloadedAt: "t",
  });
  const service = createService(dir, { spaces: [space("coding")] });
  const { ctx } = jobCtx();
  const outcome = await service.execute({ kind: "plugin.library.remove", libraryId: candidate }, ctx);
  assert.equal(outcome.kind, "plugin.library.remove");
  if (outcome.kind !== "plugin.library.remove") return;
  assert.equal(outcome.libraryId, candidate);
  assert.equal(existsSync(join(dir, archiveRelPath(candidate))), false);
  assert.equal(existsSync(join(dir, archiveRelPath(older))), true);
  assert.equal(existsSync(oldInstallTar), true);
  await assert.rejects(
    service.execute({ kind: "plugin.library.remove", libraryId: older }, ctx),
    /installed|仍安装/,
  );
});

test("share export returns a secret-free archive and a safe filename", async () => {
  const dir = home();
  writeProfile(
    dir,
    "coding",
    ["@deepseek-ai/dsh-base", "dsh-outline"],
    { "@deepseek-ai/dsh-base": "0.1.5-rc.2", "dsh-outline": "1.2.3" },
    { "dsh-outline": "1.2.3" },
  );
  const service = createService(dir, {
    spaces: [space("coding", { displayName: "My Coding" })],
    llm: async () => ({ ...emptyLlm, spaceId: "coding" }) as LlmApiResult,
  });
  const result = await service.read({ method: "share.export", spaceId: "coding" });
  assert.equal(result.method, "share.export");
  if (result.method !== "share.export") return;
  assert.equal(result.fileName, "My-Coding.dshspace");
  assert.equal(result.fileName.includes("/") || result.fileName.includes("\\"), false);
  const raw = Buffer.from(result.archiveBase64, "base64").toString("utf8");
  assert.equal(raw.includes("apiKey"), false);
  assert.equal(raw.includes("SPACES_LLM_"), false);
  assert.ok(result.preview.plugins.some((row) => row.packageName === "dsh-outline"));
});

test("import preview rejects oversized, unsafe zip paths, and unknown schemas", async () => {
  const dir = home();
  const service = createService(dir);
  await assert.rejects(
    service.read({ method: "share.previewImport", archiveBase64: "%%%%" }),
    /base64/i,
  );
  const slip = packZip([{ name: "../hub/settings.json", data: Buffer.from("x") }]);
  await assert.rejects(
    service.read({ method: "share.previewImport", archiveBase64: slip.toString("base64") }),
    /unsafe path/i,
  );
  const unknown = packZip([
    {
      name: "manifest.json",
      data: Buffer.from(
        JSON.stringify({
          formatVersion: 99,
          kind: "dsh-space",
          exportedAt: "2026-09-15T00:00:00.000Z",
          source: {},
          space: { displayName: "X" },
        }),
      ),
    },
    { name: "plugins.json", data: Buffer.from("[]") },
  ]);
  await assert.rejects(
    service.read({ method: "share.previewImport", archiveBase64: unknown.toString("base64") }),
    /Unsupported space share format/,
  );
  const huge = Buffer.alloc(MAX_WORKBENCH_SHARE_BYTES + 1, 1);
  await assert.rejects(
    service.read({ method: "share.previewImport", archiveBase64: huge.toString("base64") }),
    /too large/i,
  );
});

test("space.import consumes once, binds epoch and TTL, and keeps a partial failure", async () => {
  const dir = home();
  const created: string[] = [];
  const installed: string[] = [];
  let currentEpoch = "epoch-1";
  let now = new Date("2026-09-20T00:00:00.000Z");
  const archive = shareArchive();
  const service = createService(dir, {
    created,
    installed,
    spaces: [space("coding")],
    observation: () => observation(currentEpoch),
    now: () => now,
    installPlugin: async (_spaceId, spec) => {
      if (spec.includes("bad-plugin")) throw new Error("incompatible");
      installed.push(spec);
    },
    createSpace: async (input) => {
      created.push(input.name);
    },
  });
  const preview = await service.read({ method: "share.previewImport", archiveBase64: archive.toString("base64") });
  assert.equal(preview.method, "share.previewImport");
  if (preview.method !== "share.previewImport") return;
  const importId = preview.importId;
  const { ctx, recorded } = jobCtx();
  await assert.rejects(
    service.execute({ kind: "space.import", importId, name: "lab", displayName: "Lab" }, ctx),
    /incompatible/,
  );
  assert.deepEqual(created, ["lab"]);
  assert.deepEqual(installed, ["dsh-outline@1.2.3"]);
  const payload = recorded[0] as { spaceId?: string; product?: WorkbenchProductOutcome };
  assert.equal(payload.spaceId, "lab");
  assert.equal(payload.product?.kind, "space.import");
  if (payload.product?.kind !== "space.import") return;
  assert.equal(payload.product.import.definition, "imported");
  assert.equal(payload.product.import.plugins, "failed");
  assert.equal(payload.product.import.start, "not-run");
  const dumped = JSON.stringify(recorded);
  assert.equal(dumped.includes(archive.toString("base64")), false);
  assert.equal(dumped.includes("archive"), false);
  const { ctx: again } = jobCtx();
  await assert.rejects(
    service.execute({ kind: "space.import", importId, name: "lab-2" }, again),
    /already used/,
  );
  const preview2 = await service.read({ method: "share.previewImport", archiveBase64: archive.toString("base64") });
  if (preview2.method !== "share.previewImport") return;
  currentEpoch = "epoch-2";
  const { ctx: stale } = jobCtx();
  await assert.rejects(
    service.execute({ kind: "space.import", importId: preview2.importId, name: "other" }, stale),
    /previous service run/,
  );
  const preview3 = await service.read({ method: "share.previewImport", archiveBase64: archive.toString("base64") });
  if (preview3.method !== "share.previewImport") return;
  currentEpoch = "epoch-1";
  now = new Date("2026-09-20T00:06:00.000Z");
  const { ctx: expired } = jobCtx();
  await assert.rejects(
    service.execute({ kind: "space.import", importId: preview3.importId, name: "later" }, expired),
    /expired/,
  );
});

test("template save and create reuse the recipe pipeline", async () => {
  const dir = home();
  writeProfile(
    dir,
    "coding",
    ["@deepseek-ai/dsh-base", "dsh-outline"],
    { "@deepseek-ai/dsh-base": "0.1.5-rc.2", "dsh-outline": "1.2.3" },
    { "dsh-outline": "1.2.3" },
  );
  const created: string[] = [];
  const installed: string[] = [];
  const service = createService(dir, {
    spaces: [space("coding")],
    created,
    installed,
  });
  const { ctx } = jobCtx();
  const saved = await service.execute({ kind: "template.save", spaceId: "coding", name: "Dev" }, ctx);
  assert.equal(saved.kind, "template.save");
  const listed = await service.read({ method: "templates" });
  assert.equal(listed.method, "templates");
  if (listed.method !== "templates") return;
  assert.equal(listed.templates[0]?.recipe?.schemaVersion, 1);
  assert.equal(listed.templates[0]?.recipe?.patch, undefined);
  const { ctx: createCtx } = jobCtx();
  const createdResult = await service.execute(
    { kind: "template.create", templateId: listed.templates[0]!.id, name: "lab", displayName: "Lab" },
    createCtx,
  );
  assert.equal(createdResult.kind, "template.create");
  if (createdResult.kind !== "template.create") return;
  assert.equal(createdResult.import.definition, "imported");
  assert.deepEqual(created, ["lab"]);
  assert.ok(installed.includes("dsh-outline@1.2.3"));
});

test("pure product reads do not write settings, catalog, library, or templates", async () => {
  const dir = home();
  writeProfile(dir, "coding", ["dsh-outline"], { "dsh-outline": "1" }, { "dsh-outline": "1.0.0" });
  const settingsPath = join(dir, "hub", "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify({ ...DEFAULT_HUB_SETTINGS, locale: "en" })}\n`);
  const service = createService(dir, { spaces: [space("coding")] });
  const stamp = (file: string) => (existsSync(file) ? statSync(file).mtimeMs : 0);
  const before = {
    settings: stamp(settingsPath),
    catalog: existsSync(join(dir, "hub", CATALOG_CACHE_FILE)),
    library: existsSync(join(dir, "hub", "plugin-library.json")),
    templates: existsSync(join(dir, "hub", SPACE_TEMPLATES_FILE)),
  };
  await service.read({ method: "settings" });
  await service.read({ method: "catalog" });
  await service.read({ method: "library" });
  await service.read({ method: "templates" });
  await service.read({ method: "diagnostics", spaceId: "coding" });
  assert.equal(stamp(settingsPath), before.settings);
  assert.equal(existsSync(join(dir, "hub", CATALOG_CACHE_FILE)), before.catalog);
  assert.equal(existsSync(join(dir, "hub", "plugin-library.json")), before.library);
  assert.equal(existsSync(join(dir, "hub", SPACE_TEMPLATES_FILE)), before.templates);
});

test("web and manager spaces cannot be exported or imported onto", async () => {
  const dir = home();
  const service = createService(dir, {
    spaces: [space("web"), space("manager")],
    managerId: () => "manager",
  });
  await assert.rejects(service.read({ method: "share.export", spaceId: "web" }), /web|cannot be changed/i);
  await assert.rejects(service.read({ method: "share.export", spaceId: "manager" }), /manager|cannot be changed/i);
  const archive = shareArchive([]);
  const preview = await service.read({ method: "share.previewImport", archiveBase64: archive.toString("base64") });
  if (preview.method !== "share.previewImport") return;
  const { ctx } = jobCtx();
  await assert.rejects(
    service.execute({ kind: "space.import", importId: preview.importId, name: "web" }, ctx),
    /web|not allowed|cannot be changed/i,
  );
});

test("http catalog URLs are rejected instead of being coerced empty", async () => {
  const dir = home();
  const service = createService(dir);
  const { ctx } = jobCtx();
  await assert.rejects(
    service.execute(
      {
        kind: "settings.update",
        settings: { portStart: 3100, portEnd: 3199, packageSource: "official", catalogUrl: "http://example.com/c.json" },
      },
      ctx,
    ),
    /https/i,
  );
});

test("present invalid settings fields are rejected and original bytes stay", async () => {
  const dir = home();
  const path = join(dir, "hub", "settings.json");
  const original = JSON.stringify({ portStart: "broken", portEnd: 70000, packageSource: "bad" });
  writeFileSync(path, original);
  const service = createService(dir);
  await assert.rejects(service.read({ method: "settings" }), /invalid|port|packageSource|unchanged/i);
  assert.equal(readFileSync(path, "utf8"), original);
  const { ctx } = jobCtx();
  await assert.rejects(
    service.execute(
      {
        kind: "settings.update",
        settings: { portStart: 4100, portEnd: 4199, packageSource: "official", catalogUrl: "" },
      },
      ctx,
    ),
    /invalid|unchanged|port/i,
  );
  assert.equal(readFileSync(path, "utf8"), original);
});

test("legacy settings with only unknown fields keep defaults and extra keys", async () => {
  const dir = home();
  writeFileSync(join(dir, "hub", "settings.json"), `${JSON.stringify({ extraFlag: true, quitBehavior: "keep" })}\n`);
  const service = createService(dir);
  const result = await service.read({ method: "settings" });
  assert.equal(result.method, "settings");
  if (result.method !== "settings") return;
  assert.equal(result.settings.portStart, DEFAULT_HUB_SETTINGS.portStart);
  assert.equal(result.settings.portEnd, DEFAULT_HUB_SETTINGS.portEnd);
  assert.equal(result.clientDefaults.locale, DEFAULT_HUB_SETTINGS.locale);
  const { ctx } = jobCtx();
  await service.execute(
    {
      kind: "settings.update",
      settings: { portStart: 4100, portEnd: 4199, packageSource: "official", catalogUrl: "" },
    },
    ctx,
  );
  const stored = JSON.parse(readFileSync(join(dir, "hub", "settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal(stored.portStart, 4100);
  assert.equal(stored.extraFlag, true);
  assert.equal(stored.quitBehavior, "keep");
});

test("float and NaN ports are rejected without flooring", async () => {
  const dir = home();
  const path = join(dir, "hub", "settings.json");
  const original = JSON.stringify({ portStart: 3100.5, portEnd: 3199, packageSource: "official" });
  writeFileSync(path, original);
  const service = createService(dir);
  await assert.rejects(service.read({ method: "settings" }), /invalid|unchanged/i);
  assert.equal(readFileSync(path, "utf8"), original);
  writeFileSync(path, JSON.stringify({ portStart: 3100, portEnd: Number.NaN, packageSource: "official" }));
  const damaged = readFileSync(path, "utf8");
  await assert.rejects(service.read({ method: "settings" }), /invalid|unchanged/i);
  assert.equal(readFileSync(path, "utf8"), damaged);
});

test("present invalid locale is not reset to a client default", async () => {
  const dir = home();
  const path = join(dir, "hub", "settings.json");
  const original = JSON.stringify({
    portStart: 3100,
    portEnd: 3199,
    packageSource: "official",
    locale: "fr",
    theme: "dark",
  });
  writeFileSync(path, original);
  const service = createService(dir);
  await assert.rejects(service.read({ method: "settings" }), /locale|invalid|unchanged/i);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("unknown library schema and broken entries are rejected without rewrite", async () => {
  const dir = home();
  const path = join(dir, "hub", "plugin-library.json");
  const original = JSON.stringify({ schemaVersion: 999, plugins: [{ broken: true }] });
  writeFileSync(path, original);
  const service = createService(dir);
  await assert.rejects(service.read({ method: "library" }), /schema|invalid|unchanged/i);
  assert.equal(readFileSync(path, "utf8"), original);
  const { ctx } = jobCtx();
  await assert.rejects(
    service.execute({ kind: "plugin.download", spec: "dsh-outline@1.2.3" }, ctx),
    /schema|invalid|unchanged/i,
  );
  await assert.rejects(
    service.execute({ kind: "plugin.library.remove", libraryId: "dsh-outline" }, ctx),
    /schema|invalid|unchanged/i,
  );
  assert.equal(readFileSync(path, "utf8"), original);
});

test("legacy library without schemaVersion still lists valid entries", async () => {
  const dir = home();
  writeFileSync(
    join(dir, "hub", "plugin-library.json"),
    `${JSON.stringify({
      plugins: [
        {
          id: "dsh-outline@1.2.3",
          spec: "dsh-outline@1.2.3",
          packageName: "dsh-outline",
          title: "outline",
          source: "catalog",
          downloadedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
    })}\n`,
  );
  const service = createService(dir);
  const result = await service.read({ method: "library" });
  assert.equal(result.method, "library");
  if (result.method !== "library") return;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.packageName, "dsh-outline");
  assert.equal("spec" in (result.items[0] ?? {}), false);
  assert.equal("tarball" in (result.items[0] ?? {}), false);
});

test("duplicate library ids are rejected and bytes stay", async () => {
  const dir = home();
  const path = join(dir, "hub", "plugin-library.json");
  const original = JSON.stringify({
    plugins: [
      { id: "dup", spec: "dup@1.0.0", packageName: "dup", source: "manual", downloadedAt: "t" },
      { id: "dup", spec: "dup@2.0.0", packageName: "dup", source: "manual", downloadedAt: "t" },
    ],
  });
  writeFileSync(path, original);
  const service = createService(dir);
  await assert.rejects(service.read({ method: "library" }), /duplicate|unchanged/i);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("template.save rejects secret config and does not write it", async () => {
  const dir = home();
  writeProfile(dir, "coding", ["dsh-outline"], { "dsh-outline": "1.2.3" }, { "dsh-outline": "1.2.3" });
  writeFileSync(join(dir, "profiles", "coding", "cordis.patch.yml"), "apiKey: fake-test-secret-123\n");
  const templatesPath = join(dir, "hub", SPACE_TEMPLATES_FILE);
  const original = `${JSON.stringify({ templates: [] })}\n`;
  writeFileSync(templatesPath, original);
  const service = createService(dir, { spaces: [space("coding")] });
  const { ctx } = jobCtx();
  await assert.rejects(
    service.execute({ kind: "template.save", spaceId: "coding", name: "example", includeConfig: true }, ctx),
    /secret|credential|apiKey/i,
  );
  assert.equal(readFileSync(templatesPath, "utf8"), original);
  assert.equal(readFileSync(templatesPath, "utf8").includes("fake-test-secret-123"), false);
});
