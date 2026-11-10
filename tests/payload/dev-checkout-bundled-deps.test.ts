import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { createDirectoryLink } from "../../src/shared/node/filesystem.ts";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  devComponentDir,
  type SpacesComponent,
} from "../../src/adapters/node/payload/dev-checkout.ts";
import { SupervisorLifecycle } from "../../src/adapters/node/supervisor/lifecycle.ts";
import { SupervisorToolchain, type SupervisorToolchainHost } from "../../src/adapters/node/supervisor/toolchain.ts";
import type { HomeOperationLock } from "../../src/adapters/node/home/home-operation-lock.ts";
import type { ProfileRegistry } from "../../src/adapters/node/profile/profile-registry.ts";
import type { WorkbenchSupervisorOptions } from "../../src/adapters/node/supervisor/types.ts";

// Bundled dev-index dependency for dev-checkout linked components. Anchors in
// these tests are temp dirs OUTSIDE the checkout, so the official two-anchor
// resolveBundleDir cannot accidentally reach the repository node_modules —
// the exact blind spot that let .sandbox homes pass while the real profile
// threw "cannot resolve profile bundle".

const DEV_INDEX = "@klarkxy/dsh-dev-index";
const DEV_INDEX_VERSION = "0.2.8";
const RESOLVE_FAIL = /cannot resolve profile bundle "@klarkxy\/dsh-dev-index"/;

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

function writeCheckout(root: string): string {
  writeRel(root, "package.json", `${JSON.stringify({ name: "@dsh-spaces/plugin", private: true })}\n`);
  for (const dir of ["plugin", "view-bridge", "browser"]) {
    const dependencies: Record<string, string> = {};
    if (dir === "plugin" || dir === "view-bridge") dependencies[DEV_INDEX] = DEV_INDEX_VERSION;
    writeRel(root, `packages/${dir}/package.json`, `${JSON.stringify({
      name: `@dsh-spaces/${dir}`, version: "0.5.0", main: "./lib/index.js",
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
      ...(Object.keys(dependencies).length ? { dependencies } : {}),
    })}\n`);
    writeRel(root, `packages/${dir}/cordis.patch.yml`, "[]\n");
    writeRel(root, `packages/${dir}/lib/index.js`, "export {};\n");
  }
  return root;
}

/** The checkout's own installed dev-index package: the link source. */
function writeCheckoutDevIndex(root: string, version = DEV_INDEX_VERSION): string {
  const dir = join(root, "node_modules", "@klarkxy", "dsh-dev-index");
  writeRel(dir, "package.json", `${JSON.stringify({ name: DEV_INDEX, version, dsh: { bundle: { patch: "./cordis.patch.yml" } } })}\n`);
  writeRel(dir, "cordis.patch.yml", "- insert:\n    - id: dsh-dev-index\n      name: '@klarkxy/dsh-dev-index'\n");
  return dir;
}

/** The built space-control entry inside the plugin: a subpath module now. */
function writeCheckoutSpaceControl(root: string): string {
  const file = join(root, "packages", "plugin", "lib", "space-control.js");
  writeRel(join(root, "packages", "plugin"), "lib/space-control.js", "export {};\n");
  return file;
}

function writeProfile(home: string, profileId: string, dependencies: Record<string, string> = {}, base?: "browser"): string {
  const profile = join(home, "profiles", profileId);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "package.json"), `${JSON.stringify({
    private: true,
    dependencies,
    dsh: { profile: { bundles: [], ...(base === "browser" ? { spacesBase: "browser", baseVersion: "0.5.0" } : {}) } },
  })}\n`);
  return profile;
}

function readManifest(home: string, profileId: string): { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } } {
  return JSON.parse(readFileSync(join(home, "profiles", profileId, "package.json"), "utf8"));
}

function linkInto(home: string, profileId: string, spec: string, name: string): void {
  const profile = join(home, "profiles", profileId);
  const manifestPath = join(profile, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies: Record<string, string> };
  manifest.dependencies[name] = `link:${spec}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const dest = join(profile, "node_modules", ...name.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  createDirectoryLink(spec, dest);
}

interface AddedSpec { kind: "link" | "add"; target: string; name: string }

/** Simulate the official add: record the dependency and materialize node_modules. */
function installHooks(added: AddedSpec[]) {
  return {
    pluginLink: async (home: string, profile: string, dir: string, expectedName: string) => {
      added.push({ kind: "link", target: dir, name: expectedName });
      linkInto(home, profile, dir, expectedName);
    },
    pluginAdd: async (home: string, profile: string, spec: string) => {
      added.push({ kind: "add", target: spec, name: spec });
      const name = spec.replace(/@[^@/]*$/, "");
      const profileDir = join(home, "profiles", profile);
      const manifestPath = join(profileDir, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies: Record<string, string> };
      manifest.dependencies[name] = spec.slice(name.length + 1);
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      writeRel(join(profileDir, "node_modules", ...name.split("/")), "package.json", `${JSON.stringify({ name, version: spec.slice(name.length + 1) })}\n`);
    },
  };
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

type AppBoot = {
  resolveBundleDir: (bin: string, name: string, anchor: string, profileDir: string) => string;
};

async function appBoot(): Promise<AppBoot> {
  const req = createRequire(import.meta.url);
  return await import(pathToFileURL(req.resolve("@deepseek-ai/dsh-app-boot")).href) as AppBoot;
}

/** Official two-anchor resolution exactly as the real profile sees it. */
async function resolves(boot: AppBoot, name: string, profileDir: string): Promise<string | undefined> {
  try {
    return boot.resolveBundleDir("dsh", name, join(tempInstallAnchor(), "package.json"), profileDir);
  } catch {
    return undefined;
  }
}

/** An install anchor whose ancestors carry no dsh-dev-index. */
function tempInstallAnchor(): string {
  const dir = tempDir("dsh-devindex-anchor-");
  writeRel(dir, "package.json", `${JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.1" })}\n`);
  return dir;
}

test("dev-manager align links the checkout's dev-index copy once, at the declared version", async () => {
  const boot = await appBoot();
  const home = tempDir("dsh-devidx-home-");
  const checkout = writeCheckout(tempDir("dsh-devidx-co-"));
  const devIndexDir = writeCheckoutDevIndex(checkout);
  writeCheckoutSpaceControl(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  const profile = writeProfile(home, "spaces-hub", {});
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  linkInto(home, "spaces-hub", devComponentDir(checkout, "plugin"), "@dsh-spaces/plugin");
  linkInto(home, "spaces-hub", devComponentDir(checkout, "view-bridge"), "@dsh-spaces/view-bridge");

  // Before the ensure the patch-row package does not resolve through the
  // profile anchor — the real failure surface.
  assert.equal(await resolves(boot, DEV_INDEX, profile), undefined);

  await toolchain.alignManagerPlugin("spaces-hub");
  assert.equal(added.filter((a) => a.kind === "link" && a.target === devIndexDir).length, 1);
  assert.equal(added.filter((a) => a.kind === "add").length, 0, "the local checkout copy is linked, never fetched");
  assert.ok(await resolves(boot, DEV_INDEX, profile), "dev-index now resolves through the profile anchor");
  assert.equal(readManifest(home, "spaces-hub").dependencies?.[DEV_INDEX], `link:${devIndexDir}`);

  added.length = 0;
  await toolchain.alignManagerPlugin("spaces-hub");
  assert.deepEqual(added, [], "aligned components and a resolvable dev-index install nothing");
});

test("a linked subspace resolves dev-index through the components-align ensure, not ensureViewBridge", async () => {
  const boot = await appBoot();
  const home = tempDir("dsh-devidx-sub-home-");
  const checkout = writeCheckout(tempDir("dsh-devidx-sub-co-"));
  writeCheckoutDevIndex(checkout);
  writeCheckoutSpaceControl(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  const profile = writeProfile(home, "space-child", {});
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  linkInto(home, "space-child", devComponentDir(checkout, "view-bridge"), "@dsh-spaces/view-bridge");

  // Component presence alone is the bridge stage: it never writes new deps.
  await toolchain.ensureViewBridge("space-child");
  assert.deepEqual(added, [], "ensureViewBridge neither reinstalls the bridge nor installs dev-index");
  assert.equal(await resolves(boot, DEV_INDEX, profile), undefined, "still unresolvable until the align-stage ensure");

  // The space.components-align lock runs the ensure before reading bundles.
  await toolchain.ensureBundledDependencies("space-child");
  const links: AddedSpec[] = added;
  assert.equal(links.filter((a) => a.kind === "link" && basename(a.target) === "dsh-dev-index").length, 1);
  assert.ok(await resolves(boot, DEV_INDEX, profile), "dev-index resolves after the align-stage ensure");
});

test("a profile's own dev-index choice is never rewritten", async () => {
  const home = tempDir("dsh-devidx-own-home-");
  const checkout = writeCheckout(tempDir("dsh-devidx-own-co-"));
  writeCheckoutDevIndex(checkout);
  writeCheckoutSpaceControl(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  writeProfile(home, "spaces-hub", { [DEV_INDEX]: "0.1.0" });
  writeRel(join(home, "profiles", "spaces-hub", "node_modules", "@klarkxy", "dsh-dev-index"), "package.json", `${JSON.stringify({ name: DEV_INDEX, version: "0.1.0" })}\n`);
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  linkInto(home, "spaces-hub", devComponentDir(checkout, "plugin"), "@dsh-spaces/plugin");
  linkInto(home, "spaces-hub", devComponentDir(checkout, "view-bridge"), "@dsh-spaces/view-bridge");

  await toolchain.alignManagerPlugin("spaces-hub");
  assert.equal(added.filter((a) => a.name === DEV_INDEX).length, 0, "the user's declared dev-index stays untouched");
  assert.equal(readManifest(home, "spaces-hub").dependencies?.[DEV_INDEX], "0.1.0");
});

test("a declared-but-missing dev-index fails clearly instead of being repaired", async () => {
  const home = tempDir("dsh-devidx-miss-home-");
  const checkout = writeCheckout(tempDir("dsh-devidx-miss-co-"));
  writeCheckoutDevIndex(checkout);
  writeCheckoutSpaceControl(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  writeProfile(home, "spaces-hub", { [DEV_INDEX]: "0.2.8" });
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  linkInto(home, "spaces-hub", devComponentDir(checkout, "plugin"), "@dsh-spaces/plugin");
  linkInto(home, "spaces-hub", devComponentDir(checkout, "view-bridge"), "@dsh-spaces/view-bridge");

  await assert.rejects(
    toolchain.alignManagerPlugin("spaces-hub"),
    /declares @klarkxy\/dsh-dev-index.*not installed.*not repaired/i,
  );
  assert.deepEqual(added, [], "no install or repair was attempted");
});

test("a checkout without the declared dev-index copy fails instead of fetching", async () => {
  const home = tempDir("dsh-devidx-abs-home-");
  const checkout = writeCheckout(tempDir("dsh-devidx-abs-co-"));
  // No writeCheckoutDevIndex: the checkout cannot supply the declared version.
  writeCheckoutSpaceControl(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  writeProfile(home, "spaces-hub", {});
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  linkInto(home, "spaces-hub", devComponentDir(checkout, "plugin"), "@dsh-spaces/plugin");
  linkInto(home, "spaces-hub", devComponentDir(checkout, "view-bridge"), "@dsh-spaces/view-bridge");

  await assert.rejects(
    toolchain.alignManagerPlugin("spaces-hub"),
    /require @klarkxy\/dsh-dev-index@0\.2\.8 but the checkout provides none/i,
  );
  assert.deepEqual(added, [], "nothing was fetched from a registry");
});

test("browser-base profiles never gain a dev-index dependency", async () => {
  const home = tempDir("dsh-devidx-browser-home-");
  const checkout = writeCheckout(tempDir("dsh-devidx-browser-co-"));
  writeCheckoutDevIndex(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  writeProfile(home, "space-browser", { "@dsh-spaces/browser": "link:x", "@dsh-spaces/view-bridge": `link:${devComponentDir(checkout, "view-bridge")}` }, "browser");
  const dest = join(home, "profiles", "space-browser", "node_modules", "@dsh-spaces", "view-bridge");
  mkdirSync(dirname(dest), { recursive: true });
  createDirectoryLink(devComponentDir(checkout, "view-bridge"), dest);
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));

  await toolchain.ensureBundledDependencies("space-browser");
  assert.deepEqual(added, []);
  assert.equal(readManifest(home, "space-browser").dependencies?.[DEV_INDEX], undefined);
});

test("a corrupt linked component manifest fails the ensure itself, before any write", async () => {
  const home = tempDir("dsh-devidx-badcm-home-");
  const checkout = writeCheckout(tempDir("dsh-devidx-badcm-co-"));
  writeCheckoutDevIndex(checkout);
  writeCheckoutSpaceControl(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  writeProfile(home, "spaces-hub", {});
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  linkInto(home, "spaces-hub", devComponentDir(checkout, "plugin"), "@dsh-spaces/plugin");
  writeFileSync(join(checkout, "packages", "plugin", "package.json"), "{ not json\n");

  await assert.rejects(
    toolchain.ensureBundledDependencies("spaces-hub"),
    /manifest could not be read/i,
  );
  assert.deepEqual(added, [], "a corrupt manifest never triggers an install");
});

test("a profile manifest that cannot be inspected rejects before any write", async () => {
  const home = tempDir("dsh-devidx-badpf-home-");
  const checkout = writeCheckout(tempDir("dsh-devidx-badpf-co-"));
  writeCheckoutDevIndex(checkout);
  writeCheckoutSpaceControl(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  const profile = writeProfile(home, "spaces-hub", {});
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  linkInto(home, "spaces-hub", devComponentDir(checkout, "plugin"), "@dsh-spaces/plugin");
  // A manifest that can no longer be parsed fails the ensure itself (the
  // profile base cannot be read); nothing is written.
  writeFileSync(join(profile, "package.json"), "{ broken\n");

  await assert.rejects(toolchain.ensureBundledDependencies("spaces-hub"));
  assert.deepEqual(added, [], "a corrupt profile manifest never triggers an install");
});

test("space-control is no bundled dependency: the subpath file needs no profile install", async () => {
  // @dsh-spaces/plugin/space-control resolves inside the linked plugin
  // package itself, so ensureBundledDependencies only still handles dev-index.
  const home = tempDir("dsh-ctl-home-");
  const checkout = writeCheckout(tempDir("dsh-ctl-co-"));
  writeCheckoutDevIndex(checkout);
  writeCheckoutSpaceControl(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  writeProfile(home, "space-main", {});
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  linkInto(home, "space-main", devComponentDir(checkout, "plugin"), "@dsh-spaces/plugin");

  await toolchain.ensureBundledDependencies("space-main");
  const links = added.filter((a) => a.kind === "link");
  assert.deepEqual(links.map((a) => a.name), [DEV_INDEX], "only dev-index is linked as a bundled dependency");
  assert.equal(existsSync(join(checkout, "packages", "plugin", "lib", "space-control.js")), true,
    "the space-control entry rides inside the linked plugin package");
});

test("a non-exact bundled dependency spec is rejected", async () => {
  const home = tempDir("dsh-ctlwild-home-");
  const checkout = writeCheckout(tempDir("dsh-ctlwild-co-"));
  writeCheckoutDevIndex(checkout);
  writeCheckoutSpaceControl(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  writeProfile(home, "space-main", {});
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  linkInto(home, "space-main", devComponentDir(checkout, "plugin"), "@dsh-spaces/plugin");
  const manifestPath = join(checkout, "packages", "plugin", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies: Record<string, string> };
  manifest.dependencies[DEV_INDEX] = "latest";
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

  await assert.rejects(toolchain.ensureBundledDependencies("space-main"), /not an exact registry version/);
  assert.deepEqual(added.filter((a) => a.name === DEV_INDEX), []);
});

test("the manager patch gains a disabled dsh-space-control row exactly once", async () => {
  const home = tempDir("dsh-ctldisable-home-");
  const checkout = writeCheckout(tempDir("dsh-ctldisable-co-"));
  writeCheckoutDevIndex(checkout);
  writeCheckoutSpaceControl(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  writeProfile(home, "spaces-hub", {});
  writeFileSync(join(home, "profiles", "spaces-hub", "cordis.patch.yml"), "[]\n");
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  linkInto(home, "spaces-hub", devComponentDir(checkout, "plugin"), "@dsh-spaces/plugin");
  linkInto(home, "spaces-hub", devComponentDir(checkout, "view-bridge"), "@dsh-spaces/view-bridge");

  await toolchain.alignManagerPlugin("spaces-hub");
  const patch = readFileSync(join(home, "profiles", "spaces-hub", "cordis.patch.yml"), "utf8");
  assert.match(patch, /id: dsh-space-control\n  disabled: true/);
  const rows = patch.match(/id: dsh-space-control/g);
  assert.equal(rows?.length, 1, "the disable row is appended once");

  // Second align adds nothing: everything is already aligned.
  added.length = 0;
  await toolchain.alignManagerPlugin("spaces-hub");
  assert.deepEqual(added, []);
  assert.equal(readFileSync(join(home, "profiles", "spaces-hub", "cordis.patch.yml"), "utf8"), patch);
});

test("a profile-declared space-control package is left untouched, not repaired", async () => {
  // @dsh-spaces/space-control is no longer a bundled dependency: a profile
  // that happens to declare it is not a requirement we resolve or repair —
  // the row is main-host-only and its patch stays disabled on the manager.
  const home = tempDir("dsh-ctlown-home-");
  const checkout = writeCheckout(tempDir("dsh-ctlown-co-"));
  writeCheckoutDevIndex(checkout);
  writeCheckoutSpaceControl(checkout);
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  writeProfile(home, "spaces-hub", { [DEV_INDEX]: "0.4.0" });
  writeFileSync(join(home, "profiles", "spaces-hub", "cordis.patch.yml"), "- id: dsh-space-control\n  disabled: true\n");
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    devCheckoutRoot: checkout,
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  linkInto(home, "spaces-hub", devComponentDir(checkout, "plugin"), "@dsh-spaces/plugin");
  linkInto(home, "spaces-hub", devComponentDir(checkout, "view-bridge"), "@dsh-spaces/view-bridge");

  // A declared-but-missing bundled dep still fails clearly, nothing installed.
  await assert.rejects(
    toolchain.alignManagerPlugin("spaces-hub"),
    /declares @klarkxy\/dsh-dev-index.*not installed/i,
  );
  assert.deepEqual(added.filter((a) => a.name === DEV_INDEX), []);
});

test("non-dev profiles never see the ensure", async () => {
  const home = tempDir("dsh-devidx-rel-home-");
  const added: AddedSpec[] = [];
  const hooks = installHooks(added);
  writeProfile(home, "spaces-hub", {});
  const toolchain = new SupervisorToolchain(toolchainHost(home, {
    pluginLink: hooks.pluginLink,
    pluginAdd: hooks.pluginAdd,
  }));
  await toolchain.ensureBundledDependencies("spaces-hub");
  assert.deepEqual(added, []);
});
