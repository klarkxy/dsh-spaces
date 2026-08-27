/**
 * Re-extract Electron when install.js/extract-zip fails on paths that contain spaces.
 */
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");
const DIST = join(REPO, "node_modules", "electron", "dist");
const VERSION = "37.10.3";
const PLATFORM = process.platform;
const ARCH = process.arch === "ia32" ? "ia32" : process.arch;

function exeName() {
  if (PLATFORM === "win32") return "electron.exe";
  if (PLATFORM === "darwin") return "Electron.app/Contents/MacOS/Electron";
  return "electron";
}

function zipName() {
  const plat = PLATFORM === "win32" ? "win32" : PLATFORM === "darwin" ? "darwin" : "linux";
  return `electron-v${VERSION}-${plat}-${ARCH}.zip`;
}

function main() {
  const exe = join(DIST, exeName());
  if (existsSync(exe)) {
    console.log("electron binary present");
    return;
  }
  mkdirSync(DIST, { recursive: true });
  const zip = join(tmpdir(), zipName());
  const url = `https://github.com/electron/electron/releases/download/v${VERSION}/${zipName()}`;
  if (!existsSync(zip)) {
    console.log(`downloading ${url}`);
    const curl = spawnSync("curl", ["-L", "--fail", "-o", zip, url], { stdio: "inherit" });
    if (curl.status !== 0) {
      process.exit(curl.status ?? 1);
    }
  }
  console.log(`extracting ${zip} -> ${DIST}`);
  const tar = spawnSync("tar", ["-xf", zip, "-C", DIST], { stdio: "inherit" });
  if (!existsSync(exe)) {
    console.error("electron extract failed; tar status", tar.status);
    process.exit(1);
  }
  console.log("electron binary restored");
}

main();
