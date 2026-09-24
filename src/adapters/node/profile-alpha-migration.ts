import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { extractConfigField, isExpectedIsolationPath } from "../../core/domain/isolation";
import { atomicWrite } from "./atomic";
import { payloadBridgeFiles } from "./component-cli";
import { assertOwnedProfilePath, migrateLegacyProfileSettings, profileSettingsPath } from "./profile-settings";

type Bridge = "view-bridge" | "llm-bridge";

function dumpEntries(dump: string): YAMLMap[] {
  const doc: Document = parseDocument(dump, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] });
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error("Could not inspect composed alpha profile entries.");
  const rows: YAMLMap[] = [];
  const collect = (seq: unknown) => {
    if (!isSeq(seq)) return;
    for (const row of seq.items) if (isMap(row)) {
      rows.push(row);
      if (row.get("group") === true) collect(row.get("config", true));
    }
  };
  collect(doc.contents); return rows;
}

function bridgeDisabled(dump: string): boolean {
  const rows = dumpEntries(dump).filter(row => row.get("id") === "dsh-spaces-llm-bridge");
  if (rows.length !== 1) throw new Error("The installed LLM bridge entry is missing or ambiguous.");
  const value = rows[0]!.get("disabled", true);
  if (value === undefined) return false;
  if (!isScalar(value) || value.tag || typeof value.value !== "boolean") throw new Error("Dynamic LLM bridge enablement cannot be migrated safely.");
  return value.value;
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
  install: (bridge: Bridge) => Promise<void>;
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
  const manifest = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
  const bundles: unknown[] = manifest.dsh?.profile?.bundles ?? [];
  const active = (["view-bridge", "llm-bridge"] as Bridge[])
    .filter(bridge => bundles.includes(`@dsh-spaces/${bridge}`));
  if (!active.includes("view-bridge")) throw new Error("The managed profile has no active canonical view bridge.");
  const initialDump = await input.dump();
  if (active.includes("llm-bridge") && bridgeDisabled(initialDump)) active.splice(active.indexOf("llm-bridge"), 1);
  const initialEntries = dumpEntries(initialDump);
  if (initialEntries.some(row => (row.get("id") === "settings" && row.get("disabled") === false)
    || (row.get("id") === "dsh-spaces-settings" && row.has("disabled") && row.get("disabled") !== false))) {
    throw new Error("The profile explicitly overrides scoped alpha settings isolation.");
  }
  const pending: Bridge[] = [];
  const installedRoot = (bridge: Bridge): string => {
    const modules = join(profile, "node_modules");
    const root = realpathSync(join(modules, "@dsh-spaces", bridge));
    const rel = relative(realpathSync(modules), root);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("The bridge resolves outside its profile modules.");
    return root;
  };
  const matches = (bridge: Bridge, root: string): boolean => {
    const expected = payloadBridgeFiles(payloadRoot, bridge);
    if (!expected.length) throw new Error(`The selected ${bridge} component has no comparable files.`);
    return expected.every((file) => {
      const installed = join(root, file);
      const selected = join(payloadRoot, bridge, file);
      return existsSync(installed) && existsSync(selected)
        && !lstatSync(installed).isSymbolicLink()
        && readFileSync(installed).equals(readFileSync(selected));
    });
  };
  for (const bridge of active) {
    const root = installedRoot(bridge);
    if (matches(bridge, root)) continue;
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const sdk = pkg.peerDependencies?.[bridge === "view-bridge"
      ? "@deepseek-ai/dsh-client-connection" : "@deepseek-ai/dsh-settings"];
    // Only the known previous contract is a migration input. Unknown/current
    // mismatches are damage or custom builds, never an invitation to repair.
    if (pkg.name !== `@dsh-spaces/${bridge}` || sdk !== "^0.1.5-rc.2"
      || !existsSync(join(root, "lib/index.js")) || !existsSync(join(root, "cordis.patch.yml"))) {
      throw new Error(`Installed ${bridge} does not match the selected alpha component or the supported legacy contract.`);
    }
    pending.push(bridge);
  }
  const before = readFileSync(patch, "utf8");
  const oldPath = extractConfigField(before, "settings", "path");
  if (oldPath && !isExpectedIsolationPath(oldPath, profileId, "settings.yaml")) {
    throw new Error("Legacy settings path is not owned by this profile.");
  }
  const legacy = existsSync(join(home, "hub", profileId, "settings.yaml"));
  if (!pending.length && !oldPath && !legacy) { assertAlphaSettingsIsolation(initialDump); return; }
  writeFileSync(marker, JSON.stringify({ version: 1, profileId, target: "0.1.7-alpha.1", bridges: pending }), { flag: "wx" });
  // Leave marker and partial results on every failure. Never restore or retry.
  for (const bridge of pending) {
    await input.install(bridge);
    if (!matches(bridge, installedRoot(bridge))) throw new Error(`Alpha ${bridge} installation did not match the selected component.`);
  }
  assertAlphaSettingsIsolation(await input.dump());
  const afterManifest = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
  if (JSON.stringify(afterManifest.dsh?.profile?.bundles ?? []) !== JSON.stringify(bundles)) {
    throw new Error("Profile bundle membership changed during alpha migration.");
  }
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
  assertAlphaSettingsIsolation(await input.dump());
  unlinkSync(marker);
}
