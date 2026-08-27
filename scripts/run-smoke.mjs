#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const cwd = join(dirname(fileURLToPath(import.meta.url)), "..");

const child = spawn(electron, ["."], {
  cwd,
  env: { ...process.env, DSH_SPACES_SMOKE: "1" },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
