import assert from "node:assert/strict";
import { existsSync, lstatSync as rawLstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDirectoryLink, lstatSync } from "../src/shared/node/filesystem.ts";

const adapterDir = join(dirname(fileURLToPath(import.meta.url)), "../src/adapters/node");

function adapterSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...adapterSources(full));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

test("no Node-adapter write path targets profiles/web", () => {
  const offenders: string[] = [];
  for (const file of adapterSources(adapterDir)) {
    const name = basename(file);
    const text = readFileSync(file, "utf8");
    if (name === "patch-writer.ts") {
      assert.match(text, /errors\.webSacred/);
      assert.match(text, /name === "web"/);
    }
    if (name === "profile-registry.ts") {
      assert.match(text, /errors\.refuseDeleteWebProfile/);
    }
    const writesWeb =
      /writeFileSync\([^)]*profiles[\\/]web/.test(text) ||
      /atomicWrite\([^)]*profiles[\\/]web/.test(text);
    if (writesWeb) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test("directory aliases are links, while ordinary descendants retain their identity", () => {
  const root = mkdtempSync(join(tmpdir(), "spaces-path-alias-"));
  try {
    const target = join(root, "target"), alias = join(root, "alias");
    mkdirSync(join(target, "child"), { recursive: true });
    writeFileSync(join(target, "child", "marker"), "unchanged");
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(lstatSync(alias).isSymbolicLink(), true);
    assert.equal(lstatSync(alias).isDirectory(), false);
    const ordinary = lstatSync(join(alias, "child"));
    assert.equal(ordinary.isSymbolicLink(), false);
    assert.equal(ordinary.isDirectory(), true);
    const identity = lstatSync(join(alias, "child"), { bigint: true });
    const raw = rawLstatSync(join(target, "child"), { bigint: true });
    assert.equal(identity.dev, raw.dev);
    assert.equal(identity.ino, raw.ino);
    assert.equal(readFileSync(join(alias, "child", "marker"), "utf8"), "unchanged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unrecognised dangling junction is never reported as a missing directory", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "spaces-path-dangling-"));
  try {
    const target = join(root, "target"), alias = join(root, "alias");
    mkdirSync(target);
    symlinkSync(target, alias, "junction");
    renameSync(target, join(root, "moved"));
    for (const path of [alias, join(alias, "missing-child")]) {
      try { assert.equal(lstatSync(path).isSymbolicLink(), true); }
      catch (error) {
        // An existing but unresolved entry must not authorize mkdir as ENOENT.
        assert.notEqual((error as NodeJS.ErrnoException).code, "ENOENT");
        assert.match((error as Error).message, /could not be (inspected|resolved) safely/);
      }
    }
    assert.equal(existsSync(join(root, "moved", "missing-child")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("directory links can target an unpublished tree and preserve literal special characters", () => {
  const root = mkdtempSync(join(tmpdir(), "spaces-path-create-"));
  try {
    const source = join(root, "source 空 & (x) %PATH% ! ^"), target = join(root, "published 空 & (x) %PATH% ! ^");
    const alias = join(root, "alias 空 & (x) %PATH% ! ^");
    mkdirSync(source);
    writeFileSync(join(source, "marker"), "published");
    createDirectoryLink(target, alias);
    assert.equal(rawLstatSync(alias).isSymbolicLink(), true);
    assert.ok(readlinkSync(alias));
    renameSync(source, target);
    assert.equal(realpathSync.native(alias), realpathSync.native(target));
    assert.equal(readFileSync(join(alias, "marker"), "utf8"), "published");
    assert.throws(() => createDirectoryLink(join(root, "another"), alias));
    assert.equal(readFileSync(join(alias, "marker"), "utf8"), "published");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
