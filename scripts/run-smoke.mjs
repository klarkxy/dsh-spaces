#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = join(dirname(fileURLToPath(import.meta.url)), "..");

const child = spawn(process.execPath, ["--import", "tsx", join(cwd, "scripts", "verify-spaces-desktop.mjs")], {
  cwd,
  env: { ...process.env },
  windowsHide: true,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
