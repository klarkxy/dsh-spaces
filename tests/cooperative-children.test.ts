import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { CooperativeChildren } from "../src/adapters/node/cooperative-children.ts";

test("private stop request runs the child's asynchronous shutdown before exit", async () => {
  const children = new CooperativeChildren();
  const child = children.spawn(["-e", `
    process.on('SIGTERM', async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      process.stdout.write('disposed');
      process.exit(0);
    });
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `], { windowsHide: true });
  let output = "";
  child.stdout!.on("data", data => { output += data.toString(); });
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    while (!output.includes("ready")) await once(child.stdout!, "data");
    const exited = once(child, "exit");
    await children.stop(child.pid!);
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(output, "readydisposed");
    await assert.rejects(children.stop(child.pid!), /no cooperative stop channel/);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
});
