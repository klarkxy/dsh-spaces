/**
 * In-process TypeScript loader used ONLY when tsx cannot spawn its esbuild
 * worker in a confined sandbox (spawn EPERM on named pipes). It transpiles
 * each .ts/.tsx module with the local typescript package — no child process.
 * Usage: node --import ./tests/helpers/tsx-lite.mjs <file>
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

register(pathToFileURL(
  dirname(fileURLToPath(import.meta.url)) + "/tsx-lite-hooks.mjs"
).href);
