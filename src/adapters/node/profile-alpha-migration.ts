import { lstatSync, realpathSync } from "../../shared/node/filesystem";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { extractConfigField, isExpectedIsolationPath } from "../../core/domain/isolation";
import { isBareNpmPackageName } from "../../shared/plugin";
import { atomicWrite } from "./atomic";
import { cliLoadError, payloadBridgeFiles } from "./component-cli";
import { assertOwnedProfilePath, migrateLegacyProfileSettings, profileSettingsPath } from "./profile-settings";

type Bridge = "view-bridge" | "llm-bridge";
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
  if (row.dynamicAncestry) throw new Error("Dynamic managed bridge ancestry cannot be migrated safely.");
  if (row.disabled === undefined) return false;
  if (typeof row.disabled !== "boolean") throw new Error("Dynamic bridge or plugin enablement cannot be migrated safely.");
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
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error("Could not inspect composed alpha profile entries.");
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

function bridgeDisabled(dump: string): boolean {
  const rows = dumpEntries(dump).filter(row => row.get("id") === "dsh-spaces-llm-bridge");
  if (rows.length !== 1) throw new Error("The installed LLM bridge entry is missing or ambiguous.");
  const value = rows[0]!.get("disabled", true);
  if (value === undefined) return false;
  if (!isScalar(value) || value.tag || typeof value.value !== "boolean") throw new Error("Dynamic LLM bridge enablement cannot be migrated safely.");
  return value.value;
}

function ownedComponentRoot(home: string, profile: string, component: SpacesComponent): string {
  const modules = join(profile, "node_modules");
  const path = join(modules, "@dsh-spaces", component);
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
  if (!existsSync(join(profile, "node_modules", "@dsh-spaces", component))) return false;
  return componentFilesMatch(home, payloadRoot, component, ownedComponentRoot(home, profile, component));
}

export function assertAlphaSettingsIsolation(dump: string): void {
  const entries = dumpEntries(dump);
  const native = entries.filter(row => row.get("id") === "settings");
  const scoped = entries.filter(row => row.get("id") === "dsh-spaces-settings");
  if (native.length !== 1 || native[0]!.get("disabled") !== true
    || scoped.length !== 1 || scoped[0]!.get("name") !== "@dsh-spaces/view-bridge/settings"
    || (scoped[0]!.has("disabled") && scoped[0]!.get("disabled") !== false)) {
    throw new Error("The profile does not retain the scoped alpha settings service.");
  }
}

/** Caller holds the Home writer guard and has proved this managed profile is stopped. */
export async function migrateProfileToAlpha(input: {
  home: string; profileId: string; payloadRoot: string;
  bin?: string; cliVersion?: string;
  install: (component: SpacesComponent) => Promise<void>;
  dump: () => Promise<string>;
}): Promise<void> {
  const { home, profileId, payloadRoot } = input;
  if (profileId === "web") throw new Error("The default web profile is protected.");
  const patch = profileSettingsPath(home, profileId);
  const profile = join(home, "profiles", profileId);
  for (const path of [patch, join(profile, "package.json"), join(profile, "node_modules"), join(home, "hub", profileId, "settings.yaml")]) {
    assertOwnedProfilePath(home, path);
  }
  const marker = join(profile, ".dsh-spaces-alpha-migration.json");
  if (existsSync(marker)) throw new Error("Interrupted alpha profile migration; evidence was preserved and will not be replayed.");
  const manifestBefore = readFileSync(join(profile, "package.json"), "utf8");
  const manifest = JSON.parse(manifestBefore);
  const bundles: string[] = manifest.dsh?.profile?.bundles ?? [];
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== "string" || !isBareNpmPackageName(name)) || new Set(bundles).size !== bundles.length) throw new Error("Invalid managed profile bundle membership.");
  const before = readFileSync(patch, "utf8");
  const homePatch = join(home, "cordis.patch.yml");
  const homeBefore = existsSync(homePatch) ? readFileSync(homePatch, "utf8") : undefined;
  const declared = await declaredProfile(home, profile, bundles, input.bin);
  const active = (["view-bridge", "llm-bridge"] as Bridge[])
    .filter(bridge => bundles.includes(`@dsh-spaces/${bridge}`));
  if (!active.includes("view-bridge")) throw new Error("The managed profile has no active canonical view bridge.");
  if (disabled(bridgeEntry(declared.rows, "view-bridge"))) throw new Error("The managed profile has no active canonical view bridge.");
  const llmDisabled = active.includes("llm-bridge") && disabled(bridgeEntry(declared.rows, "llm-bridge"));
  if (llmDisabled) active.splice(active.indexOf("llm-bridge"), 1);
  const initialDump = await input.dump();
  if (declared.rows.some(row => (row.id === "settings" && row.disabled === false)
    || (row.id === "dsh-spaces-settings" && disabled(row)))) {
    throw new Error("The profile explicitly overrides scoped alpha settings isolation.");
  }
  const pending: SpacesComponent[] = [];
  const pendingCandidates = (component: SpacesComponent): void => {
    const root = ownedComponentRoot(home, profile, component);
    if (componentFilesMatch(home, payloadRoot, component, root)) return;
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const file of ["package.json", "lib/index.js", "cordis.patch.yml"]) assertOwnedProfilePath(home, join(root, file));
    if (pkg.name !== `@dsh-spaces/${component}`) {
      throw new Error(`Installed ${component} does not match the selected alpha component or the supported legacy contract.`);
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
  for (const bridge of pending) {
    compatible(declared.appBoot, JSON.parse(readFileSync(join(payloadRoot, bridge, "package.json"), "utf8")));
  }
  const oldPath = extractConfigField(before, "settings", "path");
  if (oldPath && !isExpectedIsolationPath(oldPath, profileId, "settings.yaml")) {
    throw new Error("Legacy settings path is not owned by this profile.");
  }
  const legacy = existsSync(join(home, "hub", profileId, "settings.yaml"));
  const assertUnchanged = () => {
    if (readFileSync(patch, "utf8") !== before
      || (existsSync(homePatch) ? readFileSync(homePatch, "utf8") : undefined) !== homeBefore) throw new Error("Profile patch changed during alpha migration.");
    const afterManifest = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
    if (JSON.stringify(afterManifest.dsh?.profile?.bundles ?? []) !== JSON.stringify(bundles)) throw new Error("Profile bundle membership changed during alpha migration.");
  };
  if (readFileSync(join(profile, "package.json"), "utf8") !== manifestBefore) throw new Error("Profile manifest changed before component migration.");
  assertUnchanged();
  const verifyHost = (dump: string) => {
    assertAlphaSettingsIsolation(dump);
    if (active.includes("llm-bridge") && bridgeDisabled(dump)) throw new Error("The migrated LLM bridge was denied by the target host.");
  };
  if (!pending.length && !oldPath && !legacy) { verifyHost(initialDump); return; }
  writeFileSync(marker, JSON.stringify({ version: 1, profileId, target: cliVersion, bridges: pending }), { flag: "wx" });
  // Leave marker and partial results on every failure. Never restore or retry.
  for (const component of pending) {
    await input.install(component);
    if (!componentFilesMatch(home, payloadRoot, component, ownedComponentRoot(home, profile, component))) {
      throw new Error(`Alpha ${component} installation did not match the selected component.`);
    }
  }
  assertUnchanged();
  const afterDeclared = await declaredProfile(home, profile, bundles, input.bin);
  admission(afterDeclared, []);
  if (bundles.includes("@dsh-spaces/llm-bridge") && disabled(bridgeEntry(afterDeclared.rows, "llm-bridge")) !== llmDisabled) throw new Error("LLM bridge enablement changed during component migration.");
  const composed = await input.dump();
  verifyHost(composed);
  if (oldPath) {
    if (readFileSync(patch, "utf8") !== before) throw new Error("Profile patch changed during alpha migration.");
    // Remove only the obsolete field, retaining unrelated roots and credentials.
    const doc: Document = parseDocument(before, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] });
    if (doc.errors.length || !isSeq(doc.contents)) throw new Error("The legacy profile patch is invalid.");
    const settings = doc.contents.items.find(row => isMap(row) && row.get("id") === "settings");
    const config = isMap(settings) ? settings.get("config", true) : undefined;
    if (!isMap(config)) throw new Error("The legacy settings entry is invalid.");
    config.delete("path");
    atomicWrite(patch, doc.toString({ lineWidth: 0 }));
  }
  if (legacy) migrateLegacyProfileSettings(home, profileId, await input.dump());
  verifyHost(await input.dump());
  unlinkSync(marker);
}
