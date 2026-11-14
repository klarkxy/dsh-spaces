import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HomeLease } from "../../src/adapters/node/home/home-lease.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../../src/adapters/node/products/spaces-service.ts";
import { createWorkbenchSupervisor } from "../../src/adapters/node/workbench-supervisor.ts";
import type { WorkbenchSupervisorOptions } from "../../src/adapters/node/supervisor/types.ts";

const tempRoot = tmpdir();

function writeCli(home: string): string {
  const cli = join(home, "cli");
  mkdirSync(join(cli, "lib"), { recursive: true });
  writeFileSync(join(cli, "package.json"), JSON.stringify({
    name: "@deepseek-ai/dsh",
    version: COMPATIBLE_DSH_CLI_VERSION,
  }));
  writeFileSync(join(cli, "lib/bin.js"), "export {};\n");
  for (const name of ["dsh-base", "dsh-web-app"]) {
    const dir = join(cli, "node_modules/@deepseek-ai", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: `@deepseek-ai/${name}`,
      version: COMPATIBLE_DSH_CLI_VERSION,
    }));
  }
  return join(cli, "lib/bin.js");
}

async function closeSupervisor(handle: Awaited<ReturnType<typeof createWorkbenchSupervisor>>): Promise<void> {
  try {
    await handle.close();
  } catch {
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  }
}

test("an existing manager with no CLI settles failed without another launch", async () => {
  const home = mkdtempSync(join(tempRoot, "startup-existing-cli-"));
  const bin = writeCli(home);
  const profile = join(home, "profiles", "spaces-hub");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "package.json"), JSON.stringify({
    dependencies: { "dsh-spaces": "0.5.0" },
  }));
  mkdirSync(join(home, ".dsh-spaces-control"), { recursive: true });
  writeFileSync(join(home, ".dsh-spaces-control", "manager.json"), JSON.stringify({
    version: 1, profileId: "spaces-hub", createdAt: new Date().toISOString(),
  }));
  let cliCalls = 0;
  let spawns = 0;
  const handle = await createWorkbenchSupervisor({
    home,
    bin: join(home, "cli", "absent.js"),
    port: 0,
    allowRealHome: false,
    patchWriter: {
      verify: async () => {},
      ensureWorkbenchPatch: () => {},
      patchPath: (name: string) => join(home, "profiles", name, "cordis.patch.yml"),
    },
    runCli: async () => {
      cliCalls += 1;
      throw new Error("CONTROLLED_BOOTSTRAP_FAILURE token=fixture-secret C:/private/file");
    },
    createMaintenance: () => ({
      plugins: async () => [], snapshots: async () => [], runtimes: async () => [], backups: async () => [],
    }),
    processRuntime: { spawn: () => { spawns += 1; throw new Error("UNEXPECTED_SPAWN"); } },
  } as unknown as WorkbenchSupervisorOptions);
  try {
    const status = await handle.runtime.startupStatus();
    assert.equal(status.phase, "failed");
    assert.equal(status.failure?.instanceRetained, false);
    assert.match(status.failure?.primaryReason ?? "", /could not be bound|compatible DSH CLI/i);
    assert.equal(/fixture-secret|C:\/private/.test(JSON.stringify(status)), false);
    assert.equal(spawns, 0);
    assert.equal(cliCalls, 1);
    assert.equal(existsSync(bin), true);
    assert.deepEqual(await handle.runtime.startupStatus(), status);
  } finally {
    await closeSupervisor(handle);
  }
});

test("endpoint publication failure keeps the damaged file and the acquired lease", async () => {
  const home = mkdtempSync(join(tempRoot, "startup-endpoint-"));
  const bin = writeCli(home);
  const control = join(home, ".dsh-spaces-control");
  mkdirSync(control, { recursive: true });
  mkdirSync(join(control, "endpoint.json"));
  const handle = await createWorkbenchSupervisor({
    home,
    bin,
    port: 0,
    allowRealHome: false,
    patchWriter: {
      verify: async () => {},
      ensureWorkbenchPatch: () => {},
      patchPath: (name: string) => join(home, "profiles", name, "cordis.patch.yml"),
    },
    runCli: async () => { throw new Error("UNEXPECTED_CLI"); },
    processRuntime: { spawn: () => { throw new Error("UNEXPECTED_SPAWN"); } },
  } as unknown as WorkbenchSupervisorOptions);
  try {
    const status = await handle.runtime.startupStatus();
    assert.equal(status.phase, "failed");
    assert.equal(status.failure?.instanceRetained, false);
    assert.match(status.failure?.primaryReason ?? "", /EPERM|EISDIR|not permitted|rename/i);
    assert.equal(status.failure?.cleanupReason, undefined);
    assert.equal(lstatSync(join(control, "endpoint.json")).isDirectory(), true);
    const inspection = new HomeLease(home, { allowRealHome: false }).inspect();
    assert.equal(inspection.held, true);
    assert.deepEqual(await handle.runtime.startupStatus(), status);
  } finally {
    await closeSupervisor(handle);
  }
});

test("bootstrap diagnostic IO keeps the original cause and reports the write failure", async () => {
  const home = mkdtempSync(join(tempRoot, "startup-bootstrap-diag-"));
  const bin = writeCli(home);
  const control = join(home, ".dsh-spaces-control");
  mkdirSync(control, { recursive: true });
  mkdirSync(join(control, "manager-bootstrap-error.json"));
  writeFileSync(join(control, "manager.json"), JSON.stringify({
    version: 1, profileId: "spaces-hub", createdAt: new Date().toISOString(),
  }));
  let cliCalls = 0;
  const handle = await createWorkbenchSupervisor({
    home,
    bin,
    port: 0,
    allowRealHome: false,
    patchWriter: {
      verify: async () => {},
      ensureWorkbenchPatch: () => {},
      patchPath: (name: string) => join(home, "profiles", name, "cordis.patch.yml"),
    },
    runCli: async () => {
      cliCalls += 1;
      throw new Error("CONTROLLED_BOOTSTRAP_FAILURE token=fixture-secret C:/private/file");
    },
    createMaintenance: () => ({
      plugins: async () => [], snapshots: async () => [], runtimes: async () => [], backups: async () => [],
    }),
    processRuntime: { spawn: () => { throw new Error("UNEXPECTED_SPAWN"); } },
  } as unknown as WorkbenchSupervisorOptions);
  try {
    const status = await handle.runtime.startupStatus();
    assert.equal(status.phase, "failed");
    assert.match(status.failure?.primaryReason ?? "", /CONTROLLED_BOOTSTRAP_FAILURE/);
    assert.equal(status.failure?.cleanupReason, undefined);
    assert.equal(status.failure?.instanceRetained, false);
    assert.ok(status.reasons.some((reason) => /EPERM|EISDIR|not permitted|could not be written/i.test(reason)));
    assert.ok(status.reasons.some((reason) => reason.startsWith("Diagnostic write:")));
    assert.equal(status.reasons.some((reason) => /available/i.test(reason)), false);
    assert.equal(/fixture-secret|C:\/private/.test(JSON.stringify(status)), false);
    assert.equal(cliCalls, 1);
    assert.equal(lstatSync(join(control, "manager-bootstrap-error.json")).isDirectory(), true);
    assert.deepEqual(await handle.runtime.startupStatus(), status);
  } finally {
    await closeSupervisor(handle);
  }
});
