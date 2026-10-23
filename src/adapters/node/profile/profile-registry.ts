import { lstatSync } from "../../../shared/node/filesystem";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../../shared/i18n";
import { SPACE_ID_RE, type ProfileRecord, type SpaceMeta, type SpacesFile } from "../../../shared/types";
import {
  applyMetaPatch,
  applyWorkbenchReorder,
  assertValidProfileName,
  compareScannedProfiles,
  completeWorkbenchOrder,
  emptySpacesFile,
  normalizeSpacesFile,
  packageHasWebApp,
  removeSpaceMeta,
} from "../../../core/domain/registry";
import { atomicWrite } from "../atomic";
import { assertNotRealHome } from "../home/home-guard";

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

  /** Registered spaces only: a space exists iff hub/spaces.json registered it at creation. */
  scan(): ProfileRecord[] {
    const dir = this.profilesDir();
    const spaces = this.readSpaces();
    const records: ProfileRecord[] = [];
    for (const [name, meta] of Object.entries(spaces.meta)) {
      if (!SPACE_ID_RE.test(name) || typeof meta.createdAt !== "string" || !meta.createdAt) continue;
      const path = join(dir, name);
      try {
        if (!lstatSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      records.push({
        name,
        path,
        hasWebApp: this.hasWebApp(path),
        meta,
        status: "stopped",
      });
    }
    records.sort((a, b) => compareScannedProfiles(a, b, spaces.order));
    return records;
  }

  updateMeta(name: string, patch: Partial<SpaceMeta>): SpaceMeta {
    const spaces = this.readSpaces();
    const next = applyMetaPatch(spaces, name, patch);
    this.writeSpaces(spaces);
    return next;
  }

  reorder(names: string[]): void {
    const spaces = this.readSpaces();
    const visible = this.scan().map((p) => p.name);
    applyWorkbenchReorder(spaces, completeWorkbenchOrder(visible, names));
    this.writeSpaces(spaces);
  }

  removeMeta(name: string): void {
    const spaces = this.readSpaces();
    removeSpaceMeta(spaces, name);
    this.writeSpaces(spaces);
  }

  removeHubData(name: string): void {
    if (name === "desktop") throw new Error(t("errors.nameReserved", { name }));
    if (name === "web") {
      throw new Error(t("errors.refuseDeleteWebHub"));
    }
    const dir = this.hubDataDir(name);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  removeOfficialProfile(name: string): void {
    if (name === "desktop") throw new Error(t("errors.nameReserved", { name }));
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
