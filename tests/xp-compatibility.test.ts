import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyXpEmbedCompatibility,
  XP_COMPAT_RECORD_NAME,
  XP_EMBED_COMPATIBILITY_NOTE,
  XP_ORIGINAL_CLIENT_SHA256,
  XP_PACKAGE_NAME,
  XP_PATCHED_CLIENT_SHA256,
  XP_SUPPORTED_VERSION,
  XP_VIEW_HINT_GLOBAL,
  XpCompatibilityError,
} from "../src/adapters/node/xp-compatibility.ts";

const repoRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const ORIGINAL_XP_DIR = join(repoRoot, "tests", "fixtures", "xp-original");
const ORIGINAL_CLIENT = join(ORIGINAL_XP_DIR, "client.js");
const ORIGINAL_MANIFEST = join(ORIGINAL_XP_DIR, "package.json");
const ORIGINAL_LICENSE = join(ORIGINAL_XP_DIR, "LICENSE");
const temps: string[] = [];

after(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("portable fixture is the pinned MIT original and is not rewritten", () => {
  assert.equal(existsSync(ORIGINAL_CLIENT), true, `missing fixture ${ORIGINAL_CLIENT}`);
  const bytes = readFileSync(ORIGINAL_CLIENT);
  assert.equal(bytes.length, 87129);
  assert.equal(sha256(bytes), XP_ORIGINAL_CLIENT_SHA256);
  assert.match(bytes.toString("utf8"), /function isTopWindow\(\) \{\r?\n\t\t\ttry \{\r?\n\t\t\t\treturn window\.self === window\.top;/);
  const manifest = JSON.parse(readFileSync(ORIGINAL_MANIFEST, "utf8")) as { name: string; version: string };
  assert.equal(manifest.name, XP_PACKAGE_NAME);
  assert.equal(manifest.version, XP_SUPPORTED_VERSION);
  assert.match(readFileSync(ORIGINAL_LICENSE, "utf8"), /^MIT License\b/);
  assert.match(XP_EMBED_COMPATIBILITY_NOTE, /不能原生在 iframe 里作为桌面运行/);
  assert.match(XP_EMBED_COMPATIBILITY_NOTE, /只会为这个空间做桌面嵌入适配/);
  assert.match(XP_EMBED_COMPATIBILITY_NOTE, /内部聊天窗口保持原样/);
  assert.equal(XP_EMBED_COMPATIBILITY_NOTE.includes(XP_ORIGINAL_CLIENT_SHA256), false);
  assert.equal(XP_EMBED_COMPATIBILITY_NOTE.includes("client.js"), false);
});

test("apply patches a copied original profile, is idempotent, and leaves the fixture unchanged", () => {
  const fixtureBefore = {
    client: sha256(readFileSync(ORIGINAL_CLIENT)),
    manifest: sha256(readFileSync(ORIGINAL_MANIFEST)),
    license: sha256(readFileSync(ORIGINAL_LICENSE)),
  };
  const { home, client, record } = installOriginalXp("xp");
  const first = applyXpEmbedCompatibility(home, "xp");
  const patched = readFileSync(client);
  assert.equal(first.applied, true);
  assert.equal(first.packageName, XP_PACKAGE_NAME);
  assert.equal(first.version, XP_SUPPORTED_VERSION);
  assert.equal(first.originalSha256, XP_ORIGINAL_CLIENT_SHA256);
  assert.equal(first.patchedSha256, sha256(patched));
  assert.equal(first.patchedSha256, XP_PATCHED_CLIENT_SHA256);
  assert.notEqual(first.patchedSha256, XP_ORIGINAL_CLIENT_SHA256);
  assert.equal(readFileSync(client, "utf8").includes("return window.self === window.top;"), false);
  assert.match(readFileSync(client, "utf8"), /window\.frameElement/);
  assert.match(readFileSync(client, "utf8"), new RegExp(XP_VIEW_HINT_GLOBAL));
  assert.match(readFileSync(client, "utf8"), /function waitFor\(fn, timeout, step\)/);

  const saved = JSON.parse(readFileSync(record, "utf8")) as {
    packageName: string;
    version: string;
    originalSha256: string;
    patchedSha256: string;
    file: string;
    token?: unknown;
  };
  assert.equal(saved.packageName, XP_PACKAGE_NAME);
  assert.equal(saved.version, XP_SUPPORTED_VERSION);
  assert.equal(saved.originalSha256, XP_ORIGINAL_CLIENT_SHA256);
  assert.equal(saved.patchedSha256, first.patchedSha256);
  assert.equal(saved.file, "client.js");
  assert.equal("token" in saved, false);

  const second = applyXpEmbedCompatibility(home, "xp");
  assert.equal(second.applied, false);
  assert.equal(second.packageName, first.packageName);
  assert.equal(second.version, first.version);
  assert.equal(second.originalSha256, first.originalSha256);
  assert.equal(second.patchedSha256, first.patchedSha256);
  assert.equal(sha256(readFileSync(client)), first.patchedSha256);
  assert.equal(sha256(readFileSync(ORIGINAL_CLIENT)), fixtureBefore.client);
  assert.equal(sha256(readFileSync(ORIGINAL_MANIFEST)), fixtureBefore.manifest);
  assert.equal(sha256(readFileSync(ORIGINAL_LICENSE)), fixtureBefore.license);
});

test("unknown hash or version leaves original bytes unchanged", () => {
  const mutated = installOriginalXp("xp");
  const original = readFileSync(mutated.client);
  writeFileSync(mutated.client, Buffer.concat([original, Buffer.from("\n")]));
  const mutatedSha = sha256(readFileSync(mutated.client));
  assert.throws(
    () => applyXpEmbedCompatibility(mutated.home, "xp"),
    (error: unknown) => error instanceof XpCompatibilityError && error.code === "hash-mismatch",
  );
  assert.equal(sha256(readFileSync(mutated.client)), mutatedSha);
  assert.equal(existsSync(mutated.record), false);

  const wrongVersion = installOriginalXp("xp");
  writeFileSync(
    wrongVersion.manifest,
    `${JSON.stringify({ name: XP_PACKAGE_NAME, version: "0.1.0" }, null, 2)}\n`,
  );
  const versionBytes = readFileSync(wrongVersion.client);
  assert.throws(
    () => applyXpEmbedCompatibility(wrongVersion.home, "xp"),
    (error: unknown) => error instanceof XpCompatibilityError && error.code === "unsupported",
  );
  assert.equal(Buffer.compare(readFileSync(wrongVersion.client), versionBytes), 0);
  assert.equal(existsSync(wrongVersion.record), false);
});

test("missing package, non-XP manifest, and invalid space ids fail before writes", () => {
  const missing = tempHome();
  mkdirSync(join(missing, "profiles", "xp"), { recursive: true });
  assert.throws(
    () => applyXpEmbedCompatibility(missing, "xp"),
    (error: unknown) => error instanceof XpCompatibilityError && error.code === "not-found",
  );

  const other = installOriginalXp("xp");
  writeFileSync(other.manifest, `${JSON.stringify({ name: "dsh-theme-plugin", version: "0.3.3" }, null, 2)}\n`);
  const otherBytes = readFileSync(other.client);
  assert.throws(
    () => applyXpEmbedCompatibility(other.home, "xp"),
    (error: unknown) => error instanceof XpCompatibilityError && error.code === "unsupported",
  );
  assert.equal(Buffer.compare(readFileSync(other.client), otherBytes), 0);

  const installed = installOriginalXp("xp");
  for (const spaceId of ["", "XP", "../xp", "xp/../xp", "xp/node_modules", "web_space_that_is_way_too_long_for_profile"]) {
    assert.throws(
      () => applyXpEmbedCompatibility(installed.home, spaceId),
      (error: unknown) => error instanceof XpCompatibilityError && error.code === "invalid-input",
      spaceId,
    );
  }
  assert.equal(sha256(readFileSync(installed.client)), XP_ORIGINAL_CLIENT_SHA256);
});

test("a package junction pointing outside the profile is rejected", () => {
  const home = tempHome();
  const outside = join(home, "escaped-pkg");
  mkdirSync(outside, { recursive: true });
  copyOriginal(outside);
  const packageDir = join(home, "profiles", "xp", "node_modules", XP_PACKAGE_NAME);
  mkdirSync(dirname(packageDir), { recursive: true });
  symlinkSync(outside, packageDir, process.platform === "win32" ? "junction" : "dir");
  const outsideClient = join(outside, "client.js");
  const before = sha256(readFileSync(outsideClient));
  assert.throws(
    () => applyXpEmbedCompatibility(home, "xp"),
    (error: unknown) => error instanceof XpCompatibilityError && error.code === "out-of-profile",
  );
  assert.equal(sha256(readFileSync(outsideClient)), before);
});

test("in-profile pnpm-style junction is patched at the real package directory", () => {
  const home = tempHome();
  const realPkg = join(
    home,
    "profiles",
    "xp",
    "node_modules",
    ".pnpm",
    `${XP_PACKAGE_NAME}@${XP_SUPPORTED_VERSION}`,
    "node_modules",
    XP_PACKAGE_NAME,
  );
  mkdirSync(realPkg, { recursive: true });
  copyOriginal(realPkg);
  const lexicalPkg = join(home, "profiles", "xp", "node_modules", XP_PACKAGE_NAME);
  mkdirSync(dirname(lexicalPkg), { recursive: true });
  symlinkSync(realPkg, lexicalPkg, process.platform === "win32" ? "junction" : "dir");
  const result = applyXpEmbedCompatibility(home, "xp");
  assert.equal(result.applied, true);
  assert.equal(sha256(readFileSync(join(realPkg, "client.js"))), result.patchedSha256);
  assert.equal(existsSync(join(realPkg, XP_COMPAT_RECORD_NAME)), true);
});

test("hardlinked client.js is replaced without rewriting the store inode", () => {
  const { home, client } = installOriginalXp("xp");
  const store = join(home, "pnpm-store", "client.js");
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, readFileSync(client));
  rmSync(client);
  linkSync(store, client);
  assert.equal(sha256(readFileSync(store)), XP_ORIGINAL_CLIENT_SHA256);
  const result = applyXpEmbedCompatibility(home, "xp");
  assert.equal(result.applied, true);
  assert.equal(sha256(readFileSync(client)), result.patchedSha256);
  assert.equal(sha256(readFileSync(store)), XP_ORIGINAL_CLIENT_SHA256);
});

test("patched isTopWindow treats only a real top or a supervised cross-origin workspace as the XP desktop", () => {
  const { home, client } = installOriginalXp("xp");
  applyXpEmbedCompatibility(home, "xp");
  const isTopWindow = loadIsTopWindow(readFileSync(client, "utf8"));
  const hint = {
    parentOrigin: "http://127.0.0.1:60676",
    spaceId: "xp",
    generation: 1,
    channel: "view-1",
  };

  assert.equal(isTopWindow(mockWindow({ origin: "http://127.0.0.1:3201", top: "self", frameElement: null })), true);
  assert.equal(isTopWindow(mockWindow({ origin: "http://127.0.0.1:3201", top: {}, frameElement: null, hint })), true);
  assert.equal(isTopWindow(mockWindow({
    origin: "http://127.0.0.1:3201",
    top: {},
    frameElement: { tagName: "IFRAME" },
    hint,
  })), false);
  assert.equal(isTopWindow(mockWindow({ origin: "http://127.0.0.1:3201", top: {}, frameElement: null })), false);
});

test("incomplete or invalid bridge hints and a throwing frameElement getter are not the XP desktop", () => {
  const { home, client } = installOriginalXp("xp");
  applyXpEmbedCompatibility(home, "xp");
  const isTopWindow = loadIsTopWindow(readFileSync(client, "utf8"));
  const origin = "http://127.0.0.1:3201";
  const hint = {
    parentOrigin: "http://127.0.0.1:60676",
    spaceId: "xp",
    generation: 1,
    channel: "view-1",
  };

  assert.equal(isTopWindow(mockWindow({
    origin,
    top: {},
    frameElement: null,
    hint: { parentOrigin: "http://127.0.0.1:1234" },
  })), false);
  assert.equal(isTopWindow(mockWindow({
    origin,
    top: {},
    frameElement: null,
    hint: { parentOrigin: hint.parentOrigin, generation: 1, channel: "view-1" },
  })), false);
  assert.equal(isTopWindow(mockWindow({
    origin,
    top: {},
    frameElement: null,
    hint: { parentOrigin: hint.parentOrigin, spaceId: "xp", channel: "view-1" },
  })), false);
  assert.equal(isTopWindow(mockWindow({
    origin,
    top: {},
    frameElement: null,
    hint: { parentOrigin: hint.parentOrigin, spaceId: "xp", generation: 1 },
  })), false);
  assert.equal(isTopWindow(mockWindow({
    origin,
    top: {},
    frameElement: null,
    hint: { ...hint, generation: -1 },
  })), false);
  assert.equal(isTopWindow(mockWindow({
    origin,
    top: {},
    frameElement: null,
    hint: { ...hint, spaceId: "XP" },
  })), false);
  assert.equal(isTopWindow(mockWindow({
    origin,
    top: {},
    frameElement: null,
    hint: { ...hint, channel: "bad channel" },
  })), false);
  assert.equal(isTopWindow(mockWindow({
    origin,
    top: {},
    frameElement: null,
    hint: { ...hint, parentOrigin: "http://127.0.0.1:60676/evil" },
  })), false);
  assert.equal(isTopWindow(mockWindow({
    origin,
    top: {},
    frameElement: null,
    hint: { ...hint, parentOrigin: "http://127.0.0.1:3201" },
  })), false);
  assert.equal(isTopWindow(mockWindow({
    origin,
    top: {},
    frameElement: null,
    hint: { ...hint, parentOrigin: "http://localhost:60676" },
  })), false);
  assert.equal(isTopWindow(mockWindow({
    origin,
    top: {},
    frameElement: "throw",
    hint,
  })), false);
});

function installOriginalXp(spaceId: string): { home: string; client: string; manifest: string; record: string } {
  const home = tempHome();
  const dir = join(home, "profiles", spaceId, "node_modules", XP_PACKAGE_NAME);
  mkdirSync(dir, { recursive: true });
  copyOriginal(dir);
  return {
    home,
    client: join(dir, "client.js"),
    manifest: join(dir, "package.json"),
    record: join(dir, XP_COMPAT_RECORD_NAME),
  };
}

function copyOriginal(dir: string): void {
  assert.equal(existsSync(ORIGINAL_CLIENT), true, `missing fixture ${ORIGINAL_CLIENT}`);
  copyFileSync(ORIGINAL_CLIENT, join(dir, "client.js"));
  copyFileSync(ORIGINAL_MANIFEST, join(dir, "package.json"));
}

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-xp-compat-"));
  temps.push(dir);
  return dir;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function loadIsTopWindow(source: string): (windowLike: object) => boolean {
  const start = source.indexOf("function isTopWindow()");
  assert.notEqual(start, -1);
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.notEqual(end, -1);
  const fn = new Function("window", `${source.slice(start, end)}; return isTopWindow();`);
  return (windowLike) => fn(windowLike) as boolean;
}

function mockWindow(opts: {
  origin: string;
  top: "self" | object;
  frameElement: object | null | "throw";
  hint?: object;
}): object {
  const windowLike: {
    self?: object;
    top: object;
    location: { origin: string };
    [XP_VIEW_HINT_GLOBAL]?: object;
  } = {
    top: {},
    location: { origin: opts.origin },
  };
  Object.defineProperty(windowLike, "frameElement", {
    get() {
      if (opts.frameElement === "throw") throw new Error("cross-origin frameElement");
      return opts.frameElement;
    },
  });
  windowLike.self = windowLike;
  windowLike.top = opts.top === "self" ? windowLike : opts.top;
  if (opts.hint) windowLike[XP_VIEW_HINT_GLOBAL] = opts.hint;
  return windowLike;
}
