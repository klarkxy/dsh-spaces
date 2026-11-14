import { lstatSync, realpathSync } from "../../../shared/node/filesystem";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { isBareNpmPackageName } from "../../../shared/plugin";
import { cliLoadError, payloadBridgeFiles } from "../payload/component-cli";
import { assertOwnedProfilePath, profileSettingsPath } from "./profile-settings";
import { currentDiagnosticLogger, diagnosticStep } from "../diagnostics/operation-log";

type Bridge = "view-bridge";
/** Retired bundle removed once from older spaces during alignment. */
import { SPACES_COMPONENT_PACKAGES } from "../../../shared/plugin-spec";

export const RETIRED_LLM_BRIDGE = "@dsh-spaces/llm-bridge";
type SpacesComponent = Bridge | "browser";
type Entry = { id?: unknown; name?: unknown; disabled?: unknown; group?: unknown; config?: unknown };
type ObservedEntry = Entry & { inheritedDisabled: boolean; dynamicAncestry: boolean };
type AppBoot = {
  resolveBundleDir: (bin: string, name: string, anchor: string, profile: string) => string;
  loadOverlayPatches: (bin: string, path: string) => unknown[];
  loadOptionalPatches: (bin: string, path: string) => unknown[] | undefined;
  composeEntries: (layers: unknown[][]) => Entry[];
  getDshRuntimeVersion: () => string;
  evaluatePluginCompatibility: (manifest: unknown, exemptions: Record<string, string[]>, runtimeVersion: string) =>
    { requirements: Record<string, string> } | { peers: Record<string, string> } | undefined;
};

function entryRows(entries: Entry[], ancestry: "enabled" | "disabled" | "dynamic" = "enabled"): ObservedEntry[] {
  return entries.flatMap(row => {
    const observed = { ...row, inheritedDisabled: ancestry === "disabled", dynamicAncestry: ancestry === "dynamic" };
    const children = ancestry === "disabled" || row.disabled === true ? "disabled"
      : ancestry === "dynamic" || row.disabled !== undefined && typeof row.disabled !== "boolean" ? "dynamic" : "enabled";
    return [observed, ...(row.group === true && Array.isArray(row.config) ? entryRows(row.config, children) : [])];
  });
}

function disabled(row: ObservedEntry): boolean {
  if (row.inheritedDisabled) return true;
  if (row.dynamicAncestry) throw new Error("Dynamic managed bridge ancestry cannot be aligned safely.");
  if (row.disabled === undefined) return false;
  if (typeof row.disabled !== "boolean") throw new Error("Dynamic bridge or plugin enablement cannot be aligned safely.");
  return row.disabled;
}

/** Inspect declared layers without the host's compatibility filtering or executing plugins. */
async function declaredProfile(home: string, profile: string, bundles: string[], bin?: string) {
  const require = bin ? createRequire(bin) : createRequire(import.meta.url);
  const appBoot = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-app-boot")).href) as AppBoot;
  let anchor = join(profile, "package.json");
  if (bin) {
    let dir = dirname(bin);
    for (;;) {
      const path = join(dir, "package.json");
      if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).name === "@deepseek-ai/dsh") { anchor = path; break; }
      if (dirname(dir) === dir) throw new Error("The bound CLI installation manifest is missing.");
      dir = dirname(dir);
    }
  }
  const layers = bundles.map(name => {
    const root = appBoot.resolveBundleDir("dsh", name, anchor, profile);
    const manifestPath = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    const declared = pkg.dsh?.bundle?.patch;
    const paths = typeof declared === "string" ? [declared] : declared;
    if (pkg.name !== name || !Array.isArray(paths) || !paths.length) throw new Error(`Invalid declared profile bundle: ${name}.`);
    const patches = paths.flatMap(file => {
      if (typeof file !== "string" || isAbsolute(file)) throw new Error(`Invalid bundle patch: ${name}.`);
      const path = join(root, file);
      const lexical = relative(root, path);
      const rel = relative(realpathSync(root), realpathSync(path));
      if (!lexical || lexical.startsWith("..") || isAbsolute(lexical) || !rel || rel.startsWith("..") || isAbsolute(rel) || lstatSync(path).isSymbolicLink()) throw new Error(`Bundle patch escapes its package: ${name}.`);
      return appBoot.loadOverlayPatches("dsh", path);
    });
    return { name, manifestPath, patches };
  });
  const entries = appBoot.composeEntries([
    ...layers.map(layer => layer.patches),
    appBoot.loadOverlayPatches("dsh", join(profile, "cordis.patch.yml")),
    appBoot.loadOptionalPatches("dsh", join(home, "cordis.patch.yml")) ?? [],
  ]);
  const rows = entryRows(entries);
  const manifestFor = (specifier: string): string => {
    if (specifier.startsWith("file:")) {
      let dir = dirname(fileURLToPath(specifier));
      for (;;) {
        const path = join(dir, "package.json");
        if (existsSync(path)) return path;
        if (dirname(dir) === dir) throw new Error(`Cannot inspect plugin manifest: ${specifier}.`);
        dir = dirname(dir);
      }
    }
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
    return join(appBoot.resolveBundleDir("dsh", name, anchor, profile), "package.json");
  };
  return { rows, layers, manifestFor, appBoot };
}

function dumpEntries(dump: string): YAMLMap[] {
  const doc: Document = parseDocument(dump, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] });
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error("Could not inspect composed profile entries.");
  const rows: YAMLMap[] = [];
  const collect = (seq: unknown, inherited?: unknown) => {
    if (!isSeq(seq)) return;
    for (const row of seq.items) if (isMap(row)) {
      const own = row.get("disabled", true);
      // A literal true settles inactivity without evaluating any ancestor.
      const ownTrue = isScalar(own) && !own.tag && own.value === true;
      const inheritedTrue = isScalar(inherited) && !inherited.tag && inherited.value === true;
      const parent = ownTrue ? own : inheritedTrue ? inherited : inherited ?? own;
      const observed = row.clone() as YAMLMap;
      if (parent !== undefined) observed.set("disabled", parent);
      rows.push(observed);
      const children = isScalar(parent) && !parent.tag && parent.value === false ? undefined : parent;
      if (row.get("group") === true) collect(row.get("config", true), children);
    }
  };
  collect(doc.contents); return rows;
}

function bridgeEntry(rows: ObservedEntry[], bridge: Bridge): ObservedEntry {
  const id = `dsh-spaces-${bridge}`;
  const found = rows.filter(row => row.id === id);
  if (found.length !== 1 || found[0]!.name !== `@dsh-spaces/${bridge}`) throw new Error(`The installed ${bridge} entry is missing or ambiguous.`);
  return found[0]!;
}

function ownedComponentRoot(home: string, profile: string, component: SpacesComponent): string {
  const modules = join(profile, "node_modules");
  const path = join(modules, ...SPACES_COMPONENT_PACKAGES[component].split("/"));
  assertOwnedProfilePath(home, path);
  const root = realpathSync(path);
  const rel = relative(realpathSync(modules), root);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`The ${component} package resolves outside its profile modules.`);
  return root;
}

function componentFilesMatch(home: string, payloadRoot: string, component: SpacesComponent, root: string): boolean {
  const expected = payloadBridgeFiles(payloadRoot, component);
  if (!expected.length) throw new Error(`The selected ${component} component has no comparable files.`);
  return expected.every((file) => {
    const installed = join(root, file);
    const selected = join(payloadRoot, component, file);
    assertOwnedProfilePath(home, installed);
    return existsSync(installed) && existsSync(selected)
      && !lstatSync(installed).isSymbolicLink()
      && readFileSync(installed).equals(readFileSync(selected));
  });
}

/** True when the profile's installed Spaces-owned component bytes match the selected payload. */
export function installedComponentMatches(home: string, profileId: string, payloadRoot: string, component: SpacesComponent): boolean {
  const profile = join(home, "profiles", profileId);
  if (!existsSync(join(profile, "node_modules", ...SPACES_COMPONENT_PACKAGES[component].split("/")))) return false;
  return componentFilesMatch(home, payloadRoot, component, ownedComponentRoot(home, profile, component));
}

export function assertSettingsIsolation(dump: string): void {
  const entries = dumpEntries(dump);
  const native = entries.filter(row => row.get("id") === "settings");
  const scoped = entries.filter(row => row.get("id") === "dsh-spaces-settings");
  if (native.length !== 1 || native[0]!.get("disabled") !== true
    || scoped.length !== 1 || scoped[0]!.get("name") !== "@dsh-spaces/view-bridge/settings"
    || (scoped[0]!.has("disabled") && scoped[0]!.get("disabled") !== false)) {
    throw new Error("The profile does not retain the scoped settings service.");
  }
}

/** Caller holds the Home writer guard and has proved this managed profile is stopped. */
export async function alignProfileComponents(input: {
  home: string; profileId: string; payloadRoot: string;
  bin?: string; cliVersion?: string;
  install: (component: SpacesComponent) => Promise<void>;
  /** Official `dsh plugin remove` for the retired LLM bridge bundle. */
  remove?: (packageName: string) => Promise<void>;
  /**
   * Optional alignment check replacing the packaged byte comparison, e.g. a
   * linked checkout matching by link identity. Must be consulted before
   * ownedComponentRoot, which a link target outside the profile cannot pass.
   */
  matches?: (component: SpacesComponent) => boolean;
  dump: () => Promise<string>;
}): Promise<void> {
  const { home, profileId, payloadRoot } = input;
  if (profileId === "web") throw new Error("The default web profile is protected.");
  const patch = profileSettingsPath(home, profileId);
  const profile = join(home, "profiles", profileId);
  for (const path of [patch, join(profile, "package.json"), join(profile, "node_modules")]) {
    assertOwnedProfilePath(home, path);
  }
  const log = currentDiagnosticLogger();
  const context = { space: profileId };
  const marker = join(profile, ".dsh-spaces-component-alignment.json");
  if (existsSync(marker)) {
    log?.error("components.alignment-interrupted", "An interrupted component alignment was detected; its evidence is preserved.", undefined, context);
    throw new Error("Interrupted component alignment; evidence was preserved and will not be replayed.");
  }
  const manifestBefore = readFileSync(join(profile, "package.json"), "utf8");
  const manifest = JSON.parse(manifestBefore);
  const initialBundles: string[] = manifest.dsh?.profile?.bundles ?? [];
  if (!Array.isArray(initialBundles) || initialBundles.some(name => typeof name !== "string" || !isBareNpmPackageName(name)) || new Set(initialBundles).size !== initialBundles.length) throw new Error("Invalid managed profile bundle membership.");
  // Older spaces carry the retired LLM bridge bundle. It is dropped once with
  // the official remove under the alignment marker; the bundles checked below
  // are the membership expected after that removal.
  const retired = initialBundles.includes(RETIRED_LLM_BRIDGE);
  const bundles = initialBundles.filter(name => name !== RETIRED_LLM_BRIDGE);
  if (retired) {
    if (!input.remove) throw new Error("The managed profile carries the retired LLM bridge and no removal was provided.");
    log?.info("components.retired-remove-started", "A retired model bridge is being removed once during alignment.", context);
    writeFileSync(marker, JSON.stringify({ version: 1, profileId, remove: [RETIRED_LLM_BRIDGE] }), { flag: "wx" });
    // Leave the marker on failure: an interrupted removal is evidence, not replayed.
    await input.remove(RETIRED_LLM_BRIDGE);
    const removed = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
    if (JSON.stringify(removed.dsh?.profile?.bundles ?? []) !== JSON.stringify(bundles)) throw new Error("The retired LLM bridge removal left an unexpected bundle membership.");
    unlinkSync(marker);
    log?.info("components.retired-remove-completed", "The retired model bridge was removed and its membership was verified.", context);
  }
  const manifestAligned = readFileSync(join(profile, "package.json"), "utf8");
  const before = readFileSync(patch, "utf8");
  const homePatch = join(home, "cordis.patch.yml");
  const homeBefore = existsSync(homePatch) ? readFileSync(homePatch, "utf8") : undefined;
  const declared = log
    ? await diagnosticStep(log, "components.declared-read", context, () => declaredProfile(home, profile, bundles, input.bin))
    : await declaredProfile(home, profile, bundles, input.bin);
  const active = (["view-bridge"] as Bridge[])
    .filter(bridge => bundles.includes(`@dsh-spaces/${bridge}`));
  if (!active.includes("view-bridge")) throw new Error("The managed profile has no active canonical view bridge.");
  if (disabled(bridgeEntry(declared.rows, "view-bridge"))) throw new Error("The managed profile has no active canonical view bridge.");
  const initialDump = log ? await diagnosticStep(log, "components.initial-dump", context, input.dump) : await input.dump();
  if (declared.rows.some(row => (row.id === "settings" && row.disabled === false)
    || (row.id === "dsh-spaces-settings" && disabled(row)))) {
    throw new Error("The profile explicitly overrides scoped settings isolation.");
  }
  const matches = input.matches ?? ((component: SpacesComponent): boolean =>
    componentFilesMatch(home, payloadRoot, component, ownedComponentRoot(home, profile, component)));
  const pending: SpacesComponent[] = [];
  const pendingCandidates = (component: SpacesComponent): void => {
    if (matches(component)) return;
    const root = ownedComponentRoot(home, profile, component);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const file of ["package.json", "lib/index.js", "cordis.patch.yml"]) assertOwnedProfilePath(home, join(root, file));
    if (pkg.name !== SPACES_COMPONENT_PACKAGES[component]) {
      throw new Error(`Installed ${component} does not match the selected component.`);
    }
    pending.push(component);
  };
  for (const bridge of active) pendingCandidates(bridge);
  if (existsSync(join(profile, "node_modules", "@dsh-spaces", "browser"))) pendingCandidates("browser");
  const cliVersion = input.cliVersion ?? declared.appBoot.getDshRuntimeVersion();
  const compatible = (appBoot: AppBoot, pkg: { name?: string }, exempt = false): void => {
    // Validate the same complete manifest contract the bound host evaluates,
    // including bare dsh peers, workspace tokens, and malformed peer fields.
    const issue = appBoot.evaluatePluginCompatibility(pkg, {}, cliVersion);
    if (issue === undefined) return;
    const requirements = Object.hasOwn(issue, "requirements")
      ? (issue as { requirements: unknown }).requirements
      : Object.hasOwn(issue, "peers") ? (issue as { peers: unknown }).peers : undefined;
    if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)
      || !Object.keys(requirements).length || Object.values(requirements).some(range => typeof range !== "string")) {
      throw new Error("The bound DSH host returned an invalid plugin compatibility result.");
    }
    if (exempt) return;
    const unmet = Object.entries(requirements).map(([name, range]) => `${name}@${range}`);
    throw new Error(`${pkg.name}: ${cliLoadError(cliVersion, unmet)}`);
  };
  const admission = (inspection: Awaited<ReturnType<typeof declaredProfile>>, transitioning: SpacesComponent[]): void => {
    const exempt = new Set(transitioning.map(bridge => `@dsh-spaces/${bridge}`));
    const manifests = new Set<string>();
    // Ordinary expression-controlled rows may be active. Inspect their peers
    // conservatively without executing expressions or changing disabled state.
    const enabled = inspection.rows.filter(row => !row.inheritedDisabled && row.disabled !== true);
    for (const layer of inspection.layers) {
      // A bundle with disabled entries does not become active merely because its
      // package remains installed. Empty bundle layers still declare a contract.
      const nameUsed = (row: Entry) => typeof row.name === "string" && (row.name === layer.name || row.name.startsWith(`${layer.name}/`));
      if (enabled.some(nameUsed) || !inspection.rows.some(nameUsed)) manifests.add(layer.manifestPath);
    }
    for (const row of enabled) {
      if (typeof row.name !== "string" || row.name.startsWith("cordis:")) continue;
      manifests.add(inspection.manifestFor(row.name));
    }
    for (const path of manifests) {
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      compatible(inspection.appBoot, pkg, exempt.has(pkg.name));
    }
  };
  // Known, byte-checked transitions are the only temporary peer exemption.
  // Unknown active plugins fail before the marker or any installation writes.
  admission(declared, pending);
  log?.info("components.alignment-plan", "Component alignment inspection completed.", { ...context, bundles: bundles.length, pending: pending.join(","), runtime: cliVersion });
  for (const bridge of pending) {
    compatible(declared.appBoot, JSON.parse(readFileSync(join(payloadRoot, bridge, "package.json"), "utf8")));
  }
  const assertUnchanged = () => {
    if (readFileSync(patch, "utf8") !== before
      || (existsSync(homePatch) ? readFileSync(homePatch, "utf8") : undefined) !== homeBefore) throw new Error("Profile patch changed during component alignment.");
    const afterManifest = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
    if (JSON.stringify(afterManifest.dsh?.profile?.bundles ?? []) !== JSON.stringify(bundles)) throw new Error("Profile bundle membership changed during component alignment.");
  };
  if (readFileSync(join(profile, "package.json"), "utf8") !== (retired ? manifestAligned : manifestBefore)) throw new Error("Profile manifest changed before component alignment.");
  assertUnchanged();
  const verifyHost = (dump: string) => {
    assertSettingsIsolation(dump);
  };
  if (!pending.length) { verifyHost(initialDump); return; }
  writeFileSync(marker, JSON.stringify({ version: 1, profileId, target: cliVersion, bridges: pending }), { flag: "wx" });
  // Leave marker and partial results on every failure. Never restore or retry.
  for (const component of pending) {
    log?.info("components.install-started", "A selected component is being installed.", { ...context, component });
    await input.install(component);
    if (!matches(component)) {
      throw new Error(`The installed ${component} did not match the selected component.`);
    }
    log?.info("components.install-verified", "An installed component matched the selected component.", { ...context, component });
  }
  assertUnchanged();
  const afterDeclared = log
    ? await diagnosticStep(log, "components.readback-declared", context, () => declaredProfile(home, profile, bundles, input.bin))
    : await declaredProfile(home, profile, bundles, input.bin);
  admission(afterDeclared, []);
  const composed = log ? await diagnosticStep(log, "components.readback-dump", context, input.dump) : await input.dump();
  verifyHost(composed);
  unlinkSync(marker);
}
