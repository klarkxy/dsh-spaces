import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { buildManageRows } from "../src/shared/plugin.ts";
import {
  archiveAbsPath,
  archiveRelPath,
  isHubPluginArchive,
  lookupLibraryEntry,
  readPluginLibrary,
  syncLibraryFromProfiles,
  upsertLibraryEntry,
} from "../src/adapters/node/plugin-library.ts";
import {
  downloadPlugin,
  listPluginLibrary,
  listProfilePlugins,
  removeDownloadedPlugin,
  setSpacePlugin,
} from "../src/adapters/node/plugin-ops.ts";
import { enqueuePlugin } from "../src/adapters/node/dsh-cli.ts";
import { applyAppLocale, t } from "../src/shared/i18n/index.ts";
import { setTimeout as delay } from "node:timers/promises";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-lib-"));
  temps.push(dir);
  return dir;
}

function writeProfile(
  dshHome: string,
  name: string,
  bundles: string[],
  dependencies: Record<string, string> = {},
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

function writeLibraryTarball(dshHome: string, id: string, bytes = "candidate"): string {
  const rel = archiveRelPath(id);
  mkdirSync(join(dshHome, "hub", "plugins"), { recursive: true });
  writeFileSync(join(dshHome, rel), bytes);
  return rel;
}

test("buildManageRows puts locked official plugins first then library checkboxes", () => {
  const rows = buildManageRows(
    [
      {
        id: "urzeye/dsh-outline",
        spec: "dsh-outline",
        packageName: "dsh-outline",
        title: "dsh-outline",
        source: "catalog",
        downloadedAt: "t",
      },
    ],
    [
      { name: "@deepseek-ai/dsh-base", version: "1", protected: true },
      { name: "dsh-outline", version: "2", protected: false },
      { name: "extra-dep", version: "3", protected: false },
    ],
  );
  assert.deepEqual(
    rows.map((row) => ({ id: row.id, enabled: row.enabled, protected: row.protected })),
    [
      { id: "@deepseek-ai/dsh-base", enabled: true, protected: true },
      { id: "urzeye/dsh-outline", enabled: true, protected: false },
      { id: "extra-dep", enabled: true, protected: false },
    ],
  );
});

test("library upsert and archive path stay inside hub/plugins", () => {
  const dir = home();
  const dest = archiveAbsPath(dir, "urzeye/dsh-outline");
  mkdirSync(join(dir, "hub", "plugins"), { recursive: true });
  writeFileSync(dest, "tarball");
  assert.equal(isHubPluginArchive(dir, dest), true);
  assert.equal(isHubPluginArchive(dir, join(dir, "hub", "plugin-catalog.json")), false);
  assert.equal(isHubPluginArchive(dir, join(dir, "hub", "plugins", "..", "plugin-catalog.json")), false);
  upsertLibraryEntry(dir, {
    id: "urzeye/dsh-outline",
    spec: "dsh-outline",
    packageName: "dsh-outline",
    title: "Outline",
    tarball: "hub/plugins/urzeye__dsh-outline.tgz",
    source: "catalog",
    downloadedAt: "t",
  });
  const hit = lookupLibraryEntry(dir, "urzeye/dsh-outline");
  assert.equal(hit?.packageName, "dsh-outline");
  assert.equal(hit?.title, "Outline");
});

test("syncLibraryFromProfiles records extra installed plugins", () => {
  const dir = home();
  writeProfile(
    dir,
    "coding",
    ["@deepseek-ai/dsh-base", "dsh-outline"],
    { "@deepseek-ai/dsh-base": "1", "dsh-outline": "2" },
  );
  const list = listPluginLibrary(dir, ["coding"]);
  assert.equal(list.some((item) => item.packageName === "dsh-outline"), true);
  assert.equal(list.some((item) => item.packageName === "@deepseek-ai/dsh-base"), false);
  const again = syncLibraryFromProfiles(dir, {
    coding: listProfilePlugins(dir, "coding"),
  });
  assert.equal(again.filter((item) => item.packageName === "dsh-outline").length, 1);
});

test("downloadPlugin fetches an npm tarball into the hub library", async () => {
  const dir = home();
  let urls: string[] = [];
  const entry = await downloadPlugin(
    dir,
    { spec: "dsh-outline@1.2.3" },
    {
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.includes("dsh-outline") && !url.endsWith(".tgz")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              name: "dsh-outline",
              "dist-tags": { latest: "1.2.3" },
              versions: { "1.2.3": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-1.2.3.tgz" } } },
            }),
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
        };
      },
    },
  );
  assert.equal(entry.packageName, "dsh-outline");
  assert.equal(entry.source, "manual");
  assert.ok(entry.tarball);
  const bytes = readFileSync(join(dir, entry.tarball!));
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
  assert.ok(urls.some((url) => url.includes("dsh-outline")));
  const second = await downloadPlugin(dir, { spec: "dsh-outline@1.2.3" }, { fetchImpl: async () => {
    throw new Error("should use cached tarball");
  } });
  assert.equal(second.id, entry.id);
  assert.equal(entry.spec, "dsh-outline@1.2.3");
  assert.ok(urls.some((url) => url.includes("dsh-outline-1.2.3.tgz")));
  assert.equal(urls.some((url) => url.includes("9.9.9")), false);
});

test("downloadPlugin resolves a bare npm name to latest and pins that version", async () => {
  const dir = home();
  const urls: string[] = [];
  const entry = await downloadPlugin(
    dir,
    { spec: "dsh-outline" },
    {
      fetchImpl: async (url) => {
        urls.push(url);
        if (!url.endsWith(".tgz")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              name: "dsh-outline",
              "dist-tags": { latest: "1.2.3" },
              versions: {
                "1.2.3": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-1.2.3.tgz" } },
                "9.9.9": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-9.9.9.tgz" } },
              },
            }),
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
        };
      },
    },
  );
  assert.equal(entry.spec, "dsh-outline@1.2.3");
  assert.equal(entry.id, "dsh-outline@1.2.3");
  assert.equal(urls.some((url) => url.includes("dsh-outline-1.2.3.tgz")), true);
  assert.equal(urls.some((url) => url.includes("9.9.9")), false);
});

test("downloadPlugin catalog cards pin latest when no version is given", async () => {
  const dir = home();
  const entry = await downloadPlugin(
    dir,
    { catalogId: "urzeye/dsh-outline" },
    {
      fetchImpl: async (url) => {
        if (!url.endsWith(".tgz")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              name: "dsh-outline",
              "dist-tags": { latest: "2.0.0" },
              versions: {
                "2.0.0": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-2.0.0.tgz" } },
              },
            }),
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () => Uint8Array.from([7, 8]).buffer,
        };
      },
    },
  );
  assert.equal(entry.source, "catalog");
  assert.equal(entry.catalogId, "urzeye/dsh-outline");
  assert.equal(entry.spec, "dsh-outline@2.0.0");
});

test("downloadPlugin git catalog entries do not need a version", async () => {
  const dir = home();
  const entry = await downloadPlugin(
    dir,
    { catalogId: "example/git-bundle" },
    {
      packGit: async (_spec, dest) => {
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, "git-tarball");
      },
    },
  );
  assert.equal(entry.spec, "github:example/git-bundle");
  assert.equal(readFileSync(join(dir, entry.tarball!), "utf8"), "git-tarball");
});

test("downloadPlugin refuses latest as a spec tag and does not fetch", async () => {
  applyAppLocale("en");
  const dir = home();
  let fetched = false;
  await assert.rejects(
    downloadPlugin(dir, { spec: "dsh-outline@latest" }, {
      fetchImpl: async () => {
        fetched = true;
        throw new Error("should not fetch");
      },
    }),
    /exact number|精确号/,
  );
  assert.equal(fetched, false);
});

test("downloadPlugin fails when latest cannot be resolved and does not pick another version", async () => {
  applyAppLocale("en");
  const dir = home();
  const urls: string[] = [];
  await assert.rejects(
    downloadPlugin(dir, { spec: "dsh-outline" }, {
      fetchImpl: async (url) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: "dsh-outline",
            "dist-tags": { latest: "next" },
            versions: { "9.9.9": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-9.9.9.tgz" } } },
          }),
          arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
        };
      },
    }),
    /latest version|latest 版本/,
  );
  assert.equal(urls.some((url) => url.endsWith(".tgz")), false);
});

test("downloadPlugin fails when the requested version is missing and does not use latest", async () => {
  applyAppLocale("en");
  const dir = home();
  const urls: string[] = [];
  await assert.rejects(
    downloadPlugin(dir, { spec: "dsh-outline@1.2.3" }, {
      fetchImpl: async (url) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: "dsh-outline",
            "dist-tags": { latest: "9.9.9" },
            versions: { "9.9.9": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-9.9.9.tgz" } } },
          }),
          arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
        };
      },
    }),
    /Download of|下载/,
  );
  assert.equal(urls.some((url) => url.endsWith(".tgz")), false);
});

test("downloadPlugin keeps two exact versions of the same package", async () => {
  const dir = home();
  const fetchVersion = (version: string): Parameters<typeof downloadPlugin>[2] => ({
    fetchImpl: async (url) => {
      if (!url.endsWith(".tgz")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: "dsh-outline",
            versions: {
              "1.0.0": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-1.0.0.tgz" } },
              "2.0.0": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-2.0.0.tgz" } },
            },
          }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => Uint8Array.from(version === "1.0.0" ? [1] : [2]).buffer,
      };
    },
  });
  const first = await downloadPlugin(dir, { spec: "dsh-outline@1.0.0" }, fetchVersion("1.0.0"));
  const second = await downloadPlugin(dir, { spec: "dsh-outline@2.0.0" }, fetchVersion("2.0.0"));
  assert.notEqual(first.id, second.id);
  assert.equal(first.spec, "dsh-outline@1.0.0");
  assert.equal(second.spec, "dsh-outline@2.0.0");
  assert.deepEqual([...readFileSync(join(dir, first.tarball!))], [1]);
  assert.deepEqual([...readFileSync(join(dir, second.tarball!))], [2]);
});

test("downloadPlugin packs github specs with the injected packer", async () => {
  const dir = home();
  const entry = await downloadPlugin(
    dir,
    { spec: "github:example/git-bundle" },
    {
      packGit: async (_spec, dest) => {
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, "git-tarball");
      },
    },
  );
  assert.equal(entry.spec, "github:example/git-bundle");
  assert.equal(readFileSync(join(dir, entry.tarball!), "utf8"), "git-tarball");
});

test("downloadPlugin times out a stalled packument body and does not publish", async () => {
  const dir = home();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("{"));
    },
  }))) as typeof fetch;
  try {
    await assert.rejects(
      downloadPlugin(dir, { spec: "dsh-outline@1.2.3" }, { timeoutMs: 80 }),
      /timed out|failed/i,
    );
    assert.equal(existsSync(archiveAbsPath(dir, "dsh-outline@1.2.3")), false);
    assert.equal(lookupLibraryEntry(dir, "dsh-outline@1.2.3"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadPlugin times out a stalled tarball body and does not publish", async () => {
  const dir = home();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    if (String(url).includes(".tgz")) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
      }));
    }
    return new Response(JSON.stringify({
      name: "dsh-outline",
      "dist-tags": { latest: "1.2.3" },
      versions: { "1.2.3": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-1.2.3.tgz" } } },
    }));
  }) as typeof fetch;
  try {
    await assert.rejects(
      downloadPlugin(dir, { spec: "dsh-outline@1.2.3" }, { timeoutMs: 80 }),
      /timed out|failed/i,
    );
    assert.equal(existsSync(archiveAbsPath(dir, "dsh-outline@1.2.3")), false);
    assert.equal(lookupLibraryEntry(dir, "dsh-outline@1.2.3"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadPlugin cancel aborts the tarball reader and does not publish", async () => {
  const dir = home();
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  let tarSignal: AbortSignal | undefined;
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes(".tgz")) {
      tarSignal = init?.signal;
      abort.abort();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
      }));
    }
    return new Response(JSON.stringify({
      name: "dsh-outline",
      "dist-tags": { latest: "1.2.3" },
      versions: { "1.2.3": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-1.2.3.tgz" } } },
    }));
  }) as typeof fetch;
  try {
    await assert.rejects(
      downloadPlugin(dir, { spec: "dsh-outline@1.2.3" }, { signal: abort.signal, timeoutMs: 1_000 }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(tarSignal?.aborted, true);
    assert.equal(existsSync(archiveAbsPath(dir, "dsh-outline@1.2.3")), false);
    assert.equal(lookupLibraryEntry(dir, "dsh-outline@1.2.3"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadPlugin refuses an oversize packument and tarball without caching", async () => {
  const dir = home();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.alloc(64, 0x20));
      controller.close();
    },
  }))) as typeof fetch;
  try {
    await assert.rejects(
      downloadPlugin(dir, { spec: "dsh-outline@1.2.3" }, { metadataMaxBytes: 16, timeoutMs: 1_000 }),
      /exceeded/,
    );
    assert.equal(existsSync(archiveAbsPath(dir, "dsh-outline@1.2.3")), false);
    assert.equal(lookupLibraryEntry(dir, "dsh-outline@1.2.3"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async (url) => {
    if (String(url).includes(".tgz")) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.alloc(64, 1));
          controller.close();
        },
      }));
    }
    return new Response(JSON.stringify({
      name: "dsh-outline",
      versions: { "1.2.3": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-1.2.3.tgz" } } },
    }));
  }) as typeof fetch;
  try {
    await assert.rejects(
      downloadPlugin(dir, { spec: "dsh-outline@1.2.3" }, { archiveMaxBytes: 16, timeoutMs: 1_000 }),
      /exceeded/,
    );
    assert.equal(existsSync(archiveAbsPath(dir, "dsh-outline@1.2.3")), false);
    assert.equal(lookupLibraryEntry(dir, "dsh-outline@1.2.3"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadPlugin deadline starts after a prior plugin-queue hold, not when enqueued", async () => {
  const dir = home();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prior = enqueuePlugin("hold-queue", async () => {
    await held;
  });
  let started = 0;
  const download = downloadPlugin(
    dir,
    { spec: "dsh-outline@1.2.3" },
    {
      timeoutMs: 80,
      fetchImpl: async (url) => {
        started += 1;
        if (url.includes("dsh-outline") && !url.endsWith(".tgz")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              name: "dsh-outline",
              versions: { "1.2.3": { dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-1.2.3.tgz" } } },
            }),
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
        };
      },
    },
  );
  await delay(200);
  assert.equal(started, 0);
  release();
  await prior;
  const entry = await download;
  assert.ok(started > 0);
  assert.equal(entry.spec, "dsh-outline@1.2.3");
  assert.deepEqual([...readFileSync(join(dir, entry.tarball!))], [1, 2, 3, 4]);
});

test("downloadPlugin aborts an unconsumed non-ok body without aborting the parent", async () => {
  const dir = home();
  const parent = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    fetchSignal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    }), { status: 503 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      downloadPlugin(dir, { spec: "dsh-outline@1.2.3" }, { signal: parent.signal, timeoutMs: 1_000 }),
      /HTTP 503|failed/i,
    );
    assert.equal(parent.signal.aborted, false);
    assert.equal(fetchSignal?.aborted, true);
    assert.equal(existsSync(archiveAbsPath(dir, "dsh-outline@1.2.3")), false);
    assert.equal(lookupLibraryEntry(dir, "dsh-outline@1.2.3"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadPlugin refuses likely catalog entries", async () => {
  applyAppLocale("en");
  const dir = home();
  await assert.rejects(
    downloadPlugin(dir, { catalogId: "example/likely" }),
    /not one-click|不能一键/,
  );
});

test("removeDownloadedPlugin refuses plugins still installed on a space", async () => {
  applyAppLocale("en");
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
  await assert.rejects(removeDownloadedPlugin(dir, "dsh-outline", ["coding"]), /installed|仍安装/);
  assert.equal(readPluginLibrary(dir).length, 1);
});

test("unused exact cache version can be removed while an older exact version stays installed", async () => {
  applyAppLocale("en");
  const dir = home();
  const pkg = "@dsh-spaces/plugin";
  mkdirSync(join(dir, "hub", "plugins"), { recursive: true });
  mkdirSync(join(dir, "pack"), { recursive: true });
  const oldHubTar = join(dir, "hub", "plugins", "dsh-spaces-plugin.tgz");
  const oldPackTar = join(dir, "pack", "dsh-spaces-plugin-0.3.0.tgz");
  writeFileSync(oldHubTar, "old-hub");
  writeFileSync(oldPackTar, "old-pack");
  const candidateId = `${pkg}@0.3.1-test.1`;
  const candidateTar = writeLibraryTarball(dir, candidateId, "candidate-0.3.1");
  writeProfile(
    dir,
    "spaces-hub",
    [pkg],
    { [pkg]: "file:..\\..\\hub\\plugins\\dsh-spaces-plugin.tgz" },
    { [pkg]: "0.3.0" },
  );
  writeProfile(
    dir,
    "web",
    [pkg],
    { [pkg]: `file:${oldPackTar.replaceAll("\\", "/")}` },
    { [pkg]: "0.3.0" },
  );
  upsertLibraryEntry(dir, {
    id: candidateId,
    spec: candidateId,
    packageName: pkg,
    title: pkg,
    tarball: candidateTar,
    source: "catalog",
    downloadedAt: "t",
  });
  const next = await removeDownloadedPlugin(dir, candidateId, ["spaces-hub", "web"]);
  assert.equal(next.length, 0);
  assert.equal(existsSync(join(dir, candidateTar)), false);
  assert.equal(existsSync(oldHubTar), true);
  assert.equal(existsSync(oldPackTar), true);
});

test("same exact installed version keeps the matching cache entry in use", async () => {
  applyAppLocale("en");
  const dir = home();
  const pkg = "@dsh-spaces/plugin";
  const id = `${pkg}@0.3.0`;
  const tarball = writeLibraryTarball(dir, id);
  writeProfile(
    dir,
    "web",
    [pkg],
    { [pkg]: "file:../../hub/plugins/dsh-spaces-plugin.tgz" },
    { [pkg]: "0.3.0" },
  );
  upsertLibraryEntry(dir, {
    id,
    spec: id,
    packageName: pkg,
    title: pkg,
    tarball,
    source: "catalog",
    downloadedAt: "t",
  });
  await assert.rejects(removeDownloadedPlugin(dir, id, ["web"]), /installed|仍安装/);
  assert.equal(readPluginLibrary(dir).length, 1);
  assert.equal(existsSync(join(dir, tarball)), true);
});

test("unknown actual version keeps an exact cache entry protected", async () => {
  applyAppLocale("en");
  const dir = home();
  const pkg = "@dsh-spaces/plugin";
  const id = `${pkg}@0.3.1-test.1`;
  const tarball = writeLibraryTarball(dir, id);
  writeProfile(dir, "web", [pkg], { [pkg]: `${pkg}@0.3.0` });
  upsertLibraryEntry(dir, {
    id,
    spec: id,
    packageName: pkg,
    title: pkg,
    tarball,
    source: "catalog",
    downloadedAt: "t",
  });
  await assert.rejects(removeDownloadedPlugin(dir, id, ["web"]), /installed|仍安装/);
  assert.equal(readPluginLibrary(dir).length, 1);
  assert.equal(existsSync(join(dir, tarball)), true);
});

test("file: reference to this cache tarball stays in use even when resolved version differs", async () => {
  applyAppLocale("en");
  const dir = home();
  const pkg = "@dsh-spaces/plugin";
  const id = `${pkg}@0.3.1-test.1`;
  const tarball = writeLibraryTarball(dir, id);
  writeProfile(
    dir,
    "spaces-hub",
    [pkg],
    { [pkg]: `file:../../${tarball}` },
    { [pkg]: "0.3.0" },
  );
  writeProfile(
    dir,
    "web",
    [pkg],
    { [pkg]: pathToFileURL(join(dir, tarball)).href },
    { [pkg]: "0.3.0" },
  );
  upsertLibraryEntry(dir, {
    id,
    spec: id,
    packageName: pkg,
    title: pkg,
    tarball,
    source: "catalog",
    downloadedAt: "t",
  });
  await assert.rejects(removeDownloadedPlugin(dir, id, ["spaces-hub", "web"]), /installed|仍安装/);
  assert.equal(readPluginLibrary(dir).length, 1);
  assert.equal(existsSync(join(dir, tarball)), true);
});

test("file: reference through a directory junction to this cache tarball stays protected", async () => {
  applyAppLocale("en");
  const dir = home();
  const pkg = "@dsh-spaces/plugin";
  const id = `${pkg}@0.3.1-test.1`;
  const tarball = writeLibraryTarball(dir, id);
  const archive = join(dir, tarball);
  const aliasDir = join(dir, "hub", "cache-alias");
  symlinkSync(join(dir, "hub", "plugins"), aliasDir, process.platform === "win32" ? "junction" : "dir");
  const referenced = join(aliasDir, basename(tarball));
  assert.equal(realpathSync(referenced), realpathSync(archive));
  writeProfile(
    dir,
    "coding",
    [pkg],
    { [pkg]: `file:../../hub/cache-alias/${basename(tarball)}` },
    { [pkg]: "0.3.0" },
  );
  upsertLibraryEntry(dir, {
    id,
    spec: id,
    packageName: pkg,
    title: pkg,
    tarball,
    source: "catalog",
    downloadedAt: "t",
  });
  await assert.rejects(removeDownloadedPlugin(dir, id, ["coding"]), /installed|仍安装/);
  assert.equal(readPluginLibrary(dir).length, 1);
  assert.equal(existsSync(archive), true);
});

test("git spec with @semver stays unpinned and remains protected", async () => {
  applyAppLocale("en");
  const dir = home();
  writeProfile(
    dir,
    "coding",
    ["dsh-outline"],
    { "dsh-outline": "github:owner/dsh-outline@0.3.1" },
    { "dsh-outline": "0.3.0" },
  );
  upsertLibraryEntry(dir, {
    id: "github:owner/dsh-outline@0.3.1",
    spec: "github:owner/dsh-outline@0.3.1",
    packageName: "dsh-outline",
    title: "dsh-outline",
    source: "catalog",
    downloadedAt: "t",
  });
  await assert.rejects(
    removeDownloadedPlugin(dir, "github:owner/dsh-outline@0.3.1", ["coding"]),
    /installed|仍安装/,
  );
  assert.equal(readPluginLibrary(dir).length, 1);
});

test("bare spec with a pinned id stays unpinned and remains protected", async () => {
  applyAppLocale("en");
  const dir = home();
  writeProfile(dir, "coding", ["dsh-outline"], { "dsh-outline": "dsh-outline" }, { "dsh-outline": "0.3.0" });
  upsertLibraryEntry(dir, {
    id: "dsh-outline@0.3.1",
    spec: "dsh-outline",
    packageName: "dsh-outline",
    title: "dsh-outline",
    source: "installed",
    downloadedAt: "t",
  });
  await assert.rejects(removeDownloadedPlugin(dir, "dsh-outline@0.3.1", ["coding"]), /installed|仍安装/);
  assert.equal(readPluginLibrary(dir).length, 1);
});

test("malformed file: requestedSpec stays protected even when actual version differs", async () => {
  applyAppLocale("en");
  const dir = home();
  const pkg = "@dsh-spaces/plugin";
  const id = `${pkg}@0.3.1-test.1`;
  const tarball = writeLibraryTarball(dir, id);
  writeProfile(dir, "web", [pkg], { [pkg]: "file://" }, { [pkg]: "0.3.0" });
  writeProfile(dir, "notes", [pkg], { [pkg]: "file:bad\0archive.tgz" }, { [pkg]: "0.3.0" });
  upsertLibraryEntry(dir, {
    id,
    spec: id,
    packageName: pkg,
    title: pkg,
    tarball,
    source: "catalog",
    downloadedAt: "t",
  });
  await assert.rejects(removeDownloadedPlugin(dir, id, ["web", "notes"]), /installed|仍安装/);
  assert.equal(readPluginLibrary(dir).length, 1);
  assert.equal(existsSync(join(dir, tarball)), true);
});

test("setSpacePlugin rejects unknown and protected plugins", async () => {
  applyAppLocale("en");
  const dir = home();
  writeProfile(dir, "coding", ["@deepseek-ai/dsh-web-app"], { "@deepseek-ai/dsh-web-app": "1" });
  await assert.rejects(setSpacePlugin(dir, "coding", "missing-plugin", true, () => false), /No local plugin|本机没有/);
  await assert.rejects(
    setSpacePlugin(dir, "coding", "@deepseek-ai/dsh-web-app", false, () => false),
    /official bundle|拒绝卸载/,
  );
});
