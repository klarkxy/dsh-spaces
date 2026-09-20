#!/usr/bin/env node
/**
 * Stop-aware hang helper for self-check. Not a DSH --bin replacement:
 * bindSelectedCli requires a real @deepseek-ai/dsh package.json, so the
 * acceptance script hangs via hang-plugin instead of swapping --bin.
 *
 *   node tests/fixtures/workbench-failures/hang-cli.mjs --self-check
 */
import { pathToFileURL } from "node:url";

function stopHang() {
  process.exit(0);
}

export function installStopHandlers() {
  process.on("SIGTERM", stopHang);
  process.on("message", (message) => {
    if (message && message.type === "dsh-spaces:stop") stopHang();
  });
}

export function hangForever() {
  installStopHandlers();
  return new Promise(() => {});
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  if (process.argv.includes("--self-check")) {
    installStopHandlers();
    process.stdout.write("hang-cli-self-check=ok\n");
    process.exit(0);
  }
  hangForever();
}
