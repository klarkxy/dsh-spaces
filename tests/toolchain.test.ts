import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { crc32, deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { extractArchiveAsync, findNodeDir, setToolchainRoot, writeToolchainConfig } from "../src/adapters/node/runtime/toolchain.ts";
import { nodeArchiveName } from "../src/adapters/node/products/package-source.ts";
import { withChildObservation } from "../src/adapters/node/runtime/owned-process-record.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findNodeDir locates a supported nested windows node distribution", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-toolchain-"));
  temps.push(root);
  setToolchainRoot(root);
  const nested = join(root, "node", "node-v26.9.0-win-x64");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "node.exe"), "");
  assert.equal(findNodeDir(root), nested);
});

test("findNodeDir accepts Node 24.21 without replacing it and ignores older Node 24", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-toolchain-"));
  temps.push(root);
  const old = join(root, "node", "node-v24.20.0-win-x64");
  const supported = join(root, "node", "node-v24.21.0-win-x64");
  for (const dir of [old, supported]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "node.exe"), dir);
  }
  assert.equal(findNodeDir(root), supported);
  assert.equal(readFileSync(join(old, "node.exe"), "utf8"), old);
});

test("toolchain config round-trips packageSource", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-toolchain-"));
  temps.push(root);
  setToolchainRoot(root);
  const saved = writeToolchainConfig({ packageSource: "china", nodeVersion: "26.10.0" });
  assert.equal(saved.packageSource, "china");
  assert.equal(saved.nodeVersion, "26.10.0");
});

test("the supported Node distribution is preferred without removing an older install", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-toolchain-"));
  temps.push(root);
  const older = join(root, "node", "node-v22.16.0-win-x64");
  const preferred = join(root, "node", nodeArchiveName().replace(/\.(zip|tar\.gz)$/, ""));
  mkdirSync(older, { recursive: true });
  writeFileSync(join(older, "node.exe"), "legacy");
  assert.equal(findNodeDir(root), undefined, "unsupported distributions are not selected");
  mkdirSync(preferred, { recursive: true });
  writeFileSync(join(preferred, "node.exe"), "supported");
  assert.equal(findNodeDir(root), preferred);
  assert.equal(readFileSync(join(older, "node.exe"), "utf8"), "legacy");
});

// A single deflated ZIP entry, including CRC and a fixed DOS date (2000-01-01).
function zipFixture(path: string, entry = "node-v24.21.0-win-x64/node.exe"): void {
  const name = Buffer.from(entry), content = Buffer.from("supported-node");
  const compressed = deflateRawSync(content), checksum = crc32(content);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); local.writeUInt16LE(10273, 12);
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt16LE(10273, 14);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  writeFileSync(path, Buffer.concat([local, name, compressed, central, name, end]));
}

function zipRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-toolchain-zip-"));
  temps.push(root);
  return root;
}

test("Windows ZIP extraction uses framework IO without modules and treats paths literally", { skip: process.platform !== "win32" }, async () => {
  const root = zipRoot(), archive = join(root, "压缩 ' [node] $(Write-Output injected).ZIP");
  const dest = join(root, "目标 ' [node] $literal");
  zipFixture(archive);
  const oldModules = process.env.PSModulePath;
  const noModules = join(root, "no-modules"); mkdirSync(noModules);
  process.env.PSModulePath = noModules;
  let child: ChildProcess | undefined;
  try {
    await withChildObservation(() => ({ attach(value) { child = value; }, cancel() {} }),
      () => extractArchiveAsync(archive, dest));
  } finally {
    if (oldModules === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = oldModules;
  }
  assert.equal(child?.spawnfile, join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.deepEqual(child?.spawnargs.slice(1, 5), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const extracted = join(dest, "node-v24.21.0-win-x64", "node.exe");
  assert.equal(readFileSync(extracted, "utf8"), "supported-node");
  assert.equal(statSync(extracted).mtime.getFullYear(), 2000);
});

test("Windows ZIP extraction reports corrupt archives and preserves existing files", { skip: process.platform !== "win32" }, async () => {
  const root = zipRoot(), archive = join(root, "node.zip"), dest = join(root, "staging");
  writeFileSync(archive, "not a ZIP archive");
  await assert.rejects(extractArchiveAsync(archive, dest));
  zipFixture(archive);
  const existing = join(dest, "node-v24.21.0-win-x64", "node.exe");
  mkdirSync(join(dest, "node-v24.21.0-win-x64"), { recursive: true });
  writeFileSync(existing, "existing-node");
  await assert.rejects(extractArchiveAsync(archive, dest));
  assert.equal(readFileSync(existing, "utf8"), "existing-node");
});

test("Windows ZIP extraction rejects entries outside staging", { skip: process.platform !== "win32" }, async () => {
  const root = zipRoot(), archive = join(root, "node.zip"), dest = join(root, "staging");
  zipFixture(archive, "../escaped.exe");
  await assert.rejects(extractArchiveAsync(archive, dest));
  assert.equal(existsSync(join(root, "escaped.exe")), false);
});
