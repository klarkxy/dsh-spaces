import { setInterval } from "node:timers";
import { fileURLToPath } from "node:url";
import { defaultSpawn } from "../../../packages/plugin/src/host/supervisor-bootstrap.ts";

const ipc = process.argv[2] !== "no-ipc";
const childPath = fileURLToPath(new URL("./child.mjs", import.meta.url));
const child = defaultSpawn({
  execPath: process.execPath,
  entry: childPath,
  argv: [],
  cwd: process.env.HOST_EXIT_CWD ?? process.env.HOST_EXIT_TMP ?? process.cwd(),
  env: { ...process.env },
  ipc,
});
if (ipc) {
  child.on("message", (message) => {
    if (message === "ready") process.stdout.write(`child=${child.pid}\n`);
  });
} else {
  process.stdout.write(`child=${child.pid}\n`);
}
setInterval(() => undefined, 1000);
