import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { createDirectoryLink } from "../../src/shared/node/filesystem.ts";
import {
  detectDevCheckout,
  devComponentDir,
  devComponentLinked,
  devComponentProblem,
  type SpacesComponent,
} from "../../src/adapters/node/payload/dev-checkout.ts";
import {
  COMPONENT_PAYLOAD_PACKAGES,
  writeComponentPayloadManifest,
} from "../../src/adapters/node/payload/component-payload.ts";
import {
  bindSupervisorComponentPayload,
  preflightSupervisorComponentPayload,
} from "../../src/adapters/node/supervisor/payload.ts";
import { SupervisorLifecycle } from "../../src/adapters/node/supervisor/lifecycle.ts";
import { SupervisorToolchain, type SupervisorToolchainHost } from "../../src/adapters/node/supervisor/toolchain.ts";
import type { HomeOperationLock } from "../../src/adapters/node/home/home-operation-lock.ts";
import type { ProfileRegistry } from "../../src/adapters/node/profile/profile-registry.ts";
import type { WorkbenchSupervisorOptions } from "../../src/adapters/node/supervisor/types.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeRel(root: string, rel: string, content: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Minimal source checkout: private root manifest plus installable packages/<c> dirs. */
function writeCheckout(root: string): string {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "@dsh-spaces/plugin", private: true })}\n`);
  for (const dir of ["plugin", "view-bridge", "browser"]) {
    writeRel(join(root, "packages", dir), "package.json", `${JSON.stringify({
      name: `@dsh-spaces/${dir}`, version: "0.5.0", main: "./lib/index.js",
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    })}\n`);
    writeRel(join(root, "packages", dir), "cordis.patch.yml", "[]\n");
    writeRel(join(root, "packages", dir), "lib/index.js", "export {};\n");
  }
  return root;
}

/** A full six-component payload inside the checkout's packages/plugin. */
function writeCheckoutPayload(root: string): string {
  const pluginRoot = join(root, "packages", "plugin");
  const pkg = (name: string) => `${JSON.stringify({ name, version: "0.2.0" })}\n`;
  const files: Array<[string, string]> = [
    ["package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["manager-plugin"])],
    ["cordis.patch.yml", "plugin: dummy\n"],
    ["lib/index.js", "export {};\n"],
    ["lib/typert.host.js", "export {};\n"],
    ["lib/typert.remote-client.js", "export {};\n"],
    ["lib/client.js", "export {};\n"],
    ["lib/supervisor/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES.supervisor)],
    ["lib/supervisor/index.js", "export {};\n"],
    ["lib/supervisor/snapshot-worker.mjs", "export {};\n"],
    ["lib/view-bridge/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["view-bridge"])],
    ["lib/view-bridge/cordis.patch.yml", "view: dummy\n"],
    ["lib/view-bridge/lib/index.js", "export {};\n"],
    ["lib/view-bridge/lib/client.js", "export {};\n"],
    ["lib/view-bridge/lib/settings.js", "export {};\n"],
    ["lib/view-bridge/lib/typert.host.js", "export {};\n"],
    ["lib/browser/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES.browser)],
    ["lib/browser/cordis.patch.yml", "browser: dummy\n"],
    ["lib/browser/lib/index.js", "export {};\n"],
    ["lib/browser/lib/client.js", "export {};\n"],
    ["lib/browser/lib/typert.host.js", "export {};\n"],
    ["lib/space-control.js", "export {};\n"],
    ["lib/supervisor/ui-engine/node_modules/playwright-core/package.json", `${JSON.stringify({ name: "playwright-core", version: "1.62.1" })}\n`],
    ["lib/supervisor/ui-engine/node_modules/playwright-core/index.mjs", "export {};\n"],
    ["lib/supervisor/ui-engine/node_modules/playwright-core/index.js", "module.exports = {};\n"],
  ];
  for (const [rel, content] of files) writeRel(pluginRoot, rel, content);
  return writeComponentPayloadManifest(join(pluginRoot, "lib")).payloadRootLib;
}

function writeProfile(home: string, profileId: string, dependencies: Record<string, string> = {}): string {
  const profile = join(home, "profiles", profileId);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "package.json"), `${JSON.stringify({ private: true, dependencies, dsh: { profile: { bundles: [] } } })}\n`);
  return profile;
}

/** Simulate `dsh plugin add <dir>`: records a link: dependency and creates the directory link. */
function linkComponent(home: string, profileId: string, spec: string): void {
  const component = basename(spec) as SpacesComponent;
  const profile = join(home, "profiles", profileId);
  const manifestPath = join(profile, "package.json");
  const manifest = JSON.parse(existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "{}") as {
    dependencies: Record<string, string>;
  };
  manifest.dependencies[`@dsh-spaces/${component}`] = `link:${spec}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const dest = join(profile, "node_modules", "@dsh-spaces", component);
  mkdirSync(dirname(dest), { recursive: true });
  createDirectoryLink(spec, dest);
}

function toolchainHost(home: string, options: Partial<WorkbenchSupervisorOptions>): SupervisorToolchainHost {
  return {
    home,
    controlDir: join(home, ".control"),
    nodeExe: process.execPath,
    lifecycle: new SupervisorLifecycle(),
    lock: { run: (_label: string, action: () => Promise<unknown>) => action() } as unknown as HomeOperationLock,
    registry: undefined as unknown as ProfileRegistry,
    options: { home, bin: join(home, "bin.js"), ...options },
    now: () => new Date(),
    cli: () => null,
    setCli: () => undefined,
    managerId: () => "spaces-hub",
    selectedPayload: () => undefined,
    runtimeStore: () => undefined,
    observeChildWork: (action) => action(),
  };
}

test("detectDevCheckout finds a source checkout and rejects installed or foreign layouts", () => {
  const checkout = writeCheckout(tempDir("dsh-dev-co-"));
  assert.equal(detectDevCheckout(join(checkout, "packages", "plugin", "lib")), checkout);
  assert.equal(detectDevCheckout(devComponentDir(checkout, "plugin") + "/lib"), checkout);
  assert.equal(detectDevCheckout(join(checkout, "missing")), undefined);

  const installed = join(tempDir("dsh-dev-nm-"), "node_modules", "@dsh-spaces", "plugin", "lib");
  mkdirSync(installed, { recursive: true });
  assert.equal(detectDevCheckout(installed), undefined);

  const notPrivate = writeCheckout(tempDir("dsh-dev-np-"));
  writeFileSync(join(notPrivate, "package.json"), `${JSON.stringify({ name: "@dsh-spaces/plugin" })}\n`);
  assert.equal(detectDevCheckout(join(notPrivate, "packages", "plugin", "lib")), undefined);

  const wrongName = writeCheckout(tempDir("dsh-dev-wn-"));
  writeFileSync(join(wrongName, "package.json"), `${JSON.stringify({ name: "other", private: true })}\n`);
  assert.equal(detectDevCheckout(join(wrongName, "packages", "plugin", "lib")), undefined);
});

test("devComponentLinked requires a link: dependency whose junction resolves to the checkout dir", () => {
  const home = tempDir("dsh-dev-link-home-");
  const checkout = writeCheckout(tempDir("dsh-dev-link-co-"));
  const component: SpacesComponent = "view-bridge";
  const target = devComponentDir(checkout, component);
  writeProfile(home, "child", { "@dsh-spaces/view-bridge": `link:${target}` });
  const dest = join(home, "profiles", "child", "node_modules", "@dsh-spaces", "view-bridge");
  mkdirSync(dirname(dest), { recursive: true });
  createDirectoryLink(target, dest);
  assert.equal(devComponentLinked(home, "child", checkout, component), true);

  // A real directory install is not linked.
  writeProfile(home, "tarball", { "@dsh-spaces/view-bridge": `link:${target}` });
  const realDir = join(home, "profiles", "tarball", "node_modules", "@dsh-spaces", "view-bridge");
  mkdirSync(realDir, { recursive: true });
  assert.equal(devComponentLinked(home, "tarball", checkout, component), false);

  // A junction to a different directory is not aligned.
  const other = tempDir("dsh-dev-other-");
  mkdirSync(join(other, "view-bridge"), { recursive: true });
  writeProfile(home, "wrong", { "@dsh-spaces/view-bridge": `link:${join(other, "view-bridge")}` });
  const wrongDest = join(home, "profiles", "wrong", "node_modules", "@dsh-spaces", "view-bridge");
  mkdirSync(dirname(wrongDest), { recursive: true });
  createDirectoryLink(join(other, "view-bridge"), wrongDest);
  assert.equal(devComponentLinked(home, "wrong", checkout, component), false);

  // A file: dependency is not a link.
  writeProfile(home, "file", { "@dsh-spaces/view-bridge": "file:view-bridge-0.2.0.tgz" });
  assert.equal(devComponentLinked(home, "file", checkout, component), false);
  // No dependency at all.
  writeProfile(home, "none", {});
  assert.equal(devComponentLinked(home, "none", checkout, component), false);
});

test("bind and preflight accept a dev checkout without artifacts and reject mixed or mismatched input", async () => {
  const checkout = writeCheckout(tempDir("dsh-dev-bind-co-"));
  const payloadRootLib = writeCheckoutPayload(checkout);
  const base = { home: tempDir("dsh-dev-bind-home-"), bin: join(checkout, "bin.js") };

  const bound = bindSupervisorComponentPayload({ ...base, componentPayloadRoot: payloadRootLib, devCheckoutRoot: checkout });
  assert.equal(bound.componentPayloadRoot, payloadRootLib);
  assert.ok(bound.snapshotWorkerFile?.includes("snapshot-worker"));
  const resolved = await preflightSupervisorComponentPayload({ ...base, componentPayloadRoot: payloadRootLib, devCheckoutRoot: checkout });
  assert.equal(resolved.devCheckoutRoot, checkout);

  const invalidInput = (error: unknown) => (error as { code?: string }).code === "workbench/invalid-input";
  assert.throws(
    () => bindSupervisorComponentPayload({ ...base, componentPayloadRoot: payloadRootLib, devCheckoutRoot: tempDir("dsh-dev-other-co-") }),
    invalidInput,
  );
  assert.throws(
    () => bindSupervisorComponentPayload({ ...base, devCheckoutRoot: checkout }),
    invalidInput,
  );
  assert.throws(
    () => bindSupervisorComponentPayload({ ...base, componentPayloadRoot: payloadRootLib, devCheckoutRoot: checkout, pluginArtifact: "x" }),
    invalidInput,
  );
  await assert.rejects(
    preflightSupervisorComponentPayload({ ...base, componentPayloadRoot: payloadRootLib, devCheckoutRoot: checkout, viewBridgeArtifact: "x" }),
    invalidInput,
  );
});

test("dev ensureViewBridge links the checkout view-bridge once per profile", async () => {
  const home = tempDir("dsh-dev-ensure-home-");
  const checkout = writeCheckout(tempDir("dsh-dev-ensure-co-"));
  writeProfile(home, "child", {});
  const specs: string[] = [];
  const names: string[] = [];
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: async (addedHome, profile, dir, expectedName) => {
      specs.push(dir);
      names.push(expectedName);
      linkComponent(addedHome, profile, dir);
    },
  }));
  await toolchain.ensureViewBridge("child");
  assert.deepEqual(specs, [devComponentDir(checkout, "view-bridge")]);
  assert.deepEqual(names, ["@dsh-spaces/view-bridge"]);
  await toolchain.ensureViewBridge("child");
  assert.deepEqual(specs, [devComponentDir(checkout, "view-bridge")], "a linked bridge is not reinstalled");
});

test("dev alignManagerPlugin links plugin and view-bridge for an unlinked manager", async () => {
  const home = tempDir("dsh-dev-align-home-");
  const checkout = writeCheckout(tempDir("dsh-dev-align-co-"));
  writeProfile(home, "spaces-hub", {});
  const specs: string[] = [];
  const names: string[] = [];
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: async (addedHome, profile, dir, expectedName) => {
      specs.push(dir);
      names.push(expectedName);
      linkComponent(addedHome, profile, dir);
    },
  }));
  await toolchain.alignManagerPlugin("spaces-hub");
  assert.deepEqual(specs, [devComponentDir(checkout, "plugin"), devComponentDir(checkout, "view-bridge")]);
  assert.deepEqual(names, ["@dsh-spaces/plugin", "@dsh-spaces/view-bridge"]);
  specs.length = 0;
  await toolchain.alignManagerPlugin("spaces-hub");
  assert.deepEqual(specs, [], "aligned components are not reinstalled");
});

test("devComponentProblem names each unusable source state", () => {
  const checkout = writeCheckout(tempDir("dsh-dev-prob-co-"));
  assert.equal(devComponentProblem(checkout, "view-bridge"), undefined);

  const wrongName = writeCheckout(tempDir("dsh-dev-prob-wn-"));
  writeFileSync(join(wrongName, "packages", "view-bridge", "package.json"),
    `${JSON.stringify({ name: "@dsh-spaces/other", main: "./lib/index.js" })}\n`);
  assert.match(devComponentProblem(wrongName, "view-bridge")!, /view-bridge.*declares/i);

  const noMain = writeCheckout(tempDir("dsh-dev-prob-nm-"));
  writeFileSync(join(noMain, "packages", "view-bridge", "package.json"),
    `${JSON.stringify({ name: "@dsh-spaces/view-bridge", dsh: { bundle: { patch: "./cordis.patch.yml" } } })}\n`);
  assert.match(devComponentProblem(noMain, "view-bridge")!, /view-bridge.*main/i);

  const noEntry = writeCheckout(tempDir("dsh-dev-prob-ne-"));
  rmSync(join(noEntry, "packages", "view-bridge", "lib", "index.js"));
  assert.match(devComponentProblem(noEntry, "view-bridge")!, /view-bridge.*main/i);

  const noPatch = writeCheckout(tempDir("dsh-dev-prob-np-"));
  rmSync(join(noPatch, "packages", "view-bridge", "cordis.patch.yml"));
  assert.match(devComponentProblem(noPatch, "view-bridge")!, /view-bridge.*patch/i);
});

test("hasComponent rejects an unusable checkout component instead of reporting it absent", () => {
  const home = tempDir("dsh-dev-hasc-home-");
  const checkout = writeCheckout(tempDir("dsh-dev-hasc-co-"));
  const toolchain = new SupervisorToolchain(toolchainHost(home, { devCheckoutRoot: checkout }));
  assert.equal(toolchain.hasComponent("view-bridge"), true);

  rmSync(join(checkout, "packages", "view-bridge"), { recursive: true, force: true });
  const error = (() => { try { toolchain.hasComponent("view-bridge"); } catch (thrown) { return thrown as { code?: string; message?: string }; } })();
  assert.equal(error?.code, "workbench/unavailable");
  assert.match(String(error?.message), /view-bridge/);
});

test("componentAligned fails a live link whose source became unusable instead of reinstalling", async () => {
  const home = tempDir("dsh-dev-dead-home-");
  const checkout = writeCheckout(tempDir("dsh-dev-dead-co-"));
  writeProfile(home, "child", {});
  const specs: string[] = [];
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: async (addedHome, profile, dir) => {
      specs.push(dir);
      linkComponent(addedHome, profile, dir);
    },
  }));
  await toolchain.installComponent("child", "view-bridge");
  assert.equal(toolchain.componentAligned("child", "view-bridge"), true);

  // The linked source is wiped after the link exists: alignment reports the
  // fault by name rather than silently reinstalling over the empty target.
  rmSync(join(checkout, "packages", "view-bridge"), { recursive: true, force: true });
  const error = (() => { try { toolchain.componentAligned("child", "view-bridge"); } catch (thrown) { return thrown as { code?: string; message?: string }; } })();
  assert.equal(error?.code, "workbench/unavailable");
  assert.match(String(error?.message), /view-bridge/);
  assert.deepEqual(specs, [devComponentDir(checkout, "view-bridge")], "no implicit reinstall was attempted");
});
