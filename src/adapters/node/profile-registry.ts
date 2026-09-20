import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../shared/i18n";
import type { OnboardingProfile, OnboardingScan, ProfileKind, ProfileRecord, SpaceMeta, SpacesFile } from "../../shared/types";
import {
  applyMetaPatch,
  applyWorkbenchReorder,
  assertValidProfileName,
  classifyProfile,
  compareScannedProfiles,
  completeWorkbenchOrder,
  defaultSpaceMeta,
  emptySpacesFile,
  normalizeSpacesFile,
  onboardingAction,
  packageHasWebApp,
  removeSpaceMeta,
} from "../../core/domain/registry";
import { patchTextLooksIsolated } from "../../core/domain/isolation";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";

export class ProfileRegistry {
  constructor(private readonly dshHome: string, options: { allowRealHome?: boolean } = {}) {
    if (!options.allowRealHome) assertNotRealHome(dshHome);
  }

  profilesDir(): string {
    return join(this.dshHome, "profiles");
  }

  spacesPath(): string {
    return join(this.dshHome, "hub", "spaces.json");
  }

  hubDataDir(name: string): string {
    return join(this.dshHome, "hub", name);
  }

  readSpaces(): SpacesFile {
    const path = this.spacesPath();
    if (!existsSync(path)) {
      return emptySpacesFile();
    }
    return normalizeSpacesFile(JSON.parse(readFileSync(path, "utf8")) as SpacesFile);
  }

  writeSpaces(file: SpacesFile): void {
    atomicWrite(this.spacesPath(), `${JSON.stringify(file, null, 2)}\n`);
  }

  scan(): ProfileRecord[] {
    const dir = this.profilesDir();
    if (!existsSync(dir)) return [];
    const spaces = this.readSpaces();
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => entry.name);

    const records: ProfileRecord[] = names.map((name) => {
      const path = join(dir, name);
      const kind = this.classify(name, path);
      const meta = spaces.meta[name] ?? defaultSpaceMeta(name);
      return {
        name,
        kind,
        path,
        hasWebApp: this.hasWebApp(path),
        needsConversion: kind === "workbench" && !this.hasWorkbenchPatch(name),
        meta,
        status: "stopped",
      };
    });

    records.sort((a, b) => compareScannedProfiles(a, b, spaces.order));
    return records.filter((record) => record.kind !== "hidden");
  }

  scanOnboarding(): OnboardingScan {
    const dir = this.profilesDir();
    const names = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
          .map((entry) => entry.name)
      : [];
    const profiles: OnboardingProfile[] = names.map((name) => {
      const path = join(dir, name);
      const kind = this.classify(name, path);
      return { name, kind, action: onboardingAction(kind, this.hasWorkbenchPatch(name)) };
    });
    return {
      onboarded: Boolean(this.readSpaces().onboarded),
      dshHome: this.dshHome,
      profiles,
    };
  }

  markOnboarded(): void {
    const spaces = this.readSpaces();
    spaces.onboarded = true;
    this.writeSpaces(spaces);
  }

  updateMeta(name: string, patch: Partial<SpaceMeta>): SpaceMeta {
    const spaces = this.readSpaces();
    const next = applyMetaPatch(spaces, name, patch);
    this.writeSpaces(spaces);
    return next;
  }

  reorder(names: string[]): void {
    const spaces = this.readSpaces();
    const visible = this.scan()
      .filter((p) => p.kind === "workbench")
      .map((p) => p.name);
    applyWorkbenchReorder(spaces, completeWorkbenchOrder(visible, names));
    this.writeSpaces(spaces);
  }

  removeMeta(name: string): void {
    const spaces = this.readSpaces();
    removeSpaceMeta(spaces, name);
    this.writeSpaces(spaces);
  }

  removeHubData(name: string): void {
    if (name === "web") {
      throw new Error(t("errors.refuseDeleteWebHub"));
    }
    const dir = this.hubDataDir(name);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  removeOfficialProfile(name: string): void {
    if (name === "web") {
      throw new Error(t("errors.refuseDeleteWebProfile"));
    }
    const dir = join(this.profilesDir(), name);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  has(name: string): boolean {
    return existsSync(join(this.profilesDir(), name));
  }

  validateNewName(name: string): void {
    assertValidProfileName(name);
    if (this.has(name)) {
      throw new Error(t("errors.profileExists", { name }));
    }
  }

  hasWorkbenchPatch(name: string): boolean {
    if (name === "web") return false;
    const path = join(this.profilesDir(), name, "cordis.patch.yml");
    if (!existsSync(path)) return false;
    return patchTextLooksIsolated(readFileSync(path, "utf8"), name);
  }

  classify(name: string, path: string): ProfileKind {
    return classifyProfile(name, this.hasWebApp(path));
  }

  hasWebApp(profilePath: string): boolean {
    const pkgPath = join(profilePath, "package.json");
    if (!existsSync(pkgPath)) return false;
    try {
      return packageHasWebApp(JSON.parse(readFileSync(pkgPath, "utf8")));
    } catch {
      return false;
    }
  }

  ensureHubDir(): void {
    mkdirSync(join(this.dshHome, "hub"), { recursive: true });
  }
}
