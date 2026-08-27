import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { OnboardingProfile, OnboardingScan, ProfileKind, ProfileRecord, SpaceMeta, SpacesFile } from "../shared/types";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES } from "../shared/types";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";

const SPACES_VERSION = 1 as const;

export class ProfileRegistry {
  constructor(private readonly dshHome: string) {
    assertNotRealHome(dshHome);
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
      return { version: SPACES_VERSION, onboarded: false, order: [], meta: {} };
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SpacesFile;
    if (parsed.version !== 1) {
      throw new Error(`unsupported spaces.json version: ${String(parsed.version)}`);
    }
    return {
      version: 1,
      onboarded: Boolean(parsed.onboarded),
      order: parsed.order ?? [],
      meta: parsed.meta ?? {},
    };
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
      const meta = spaces.meta[name] ?? {
        displayName: name === "web" ? "Home" : name,
        order: name === "web" ? -1 : 1000,
      };
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

    records.sort((a, b) => {
      if (a.kind === "root" && b.kind !== "root") return -1;
      if (b.kind === "root" && a.kind !== "root") return 1;
      const ao = spaces.order.indexOf(a.name);
      const bo = spaces.order.indexOf(b.name);
      if (ao !== -1 || bo !== -1) {
        return (ao === -1 ? 9999 : ao) - (bo === -1 ? 9999 : bo);
      }
      return a.meta.order - b.meta.order || a.name.localeCompare(b.name);
    });

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
      let action: OnboardingProfile["action"] = "hide";
      if (kind === "root") action = "adopt-root";
      else if (kind === "workbench") {
        action = this.hasWorkbenchPatch(name) ? "already-workbench" : "convert-workbench";
      }
      return { name, kind, action };
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
    const current = spaces.meta[name] ?? { displayName: name, order: 1000 };
    const next = { ...current, ...patch };
    spaces.meta[name] = next;
    if (!spaces.order.includes(name) && name !== "web") {
      spaces.order.push(name);
    }
    this.writeSpaces(spaces);
    return next;
  }

  reorder(names: string[]): void {
    const spaces = this.readSpaces();
    const visible = this.scan()
      .filter((p) => p.kind === "workbench")
      .map((p) => p.name);
    const filtered = names.filter((name) => visible.includes(name) && name !== "web");
    for (const name of visible) {
      if (!filtered.includes(name)) filtered.push(name);
    }
    spaces.order = filtered;
    filtered.forEach((name, index) => {
      const meta = spaces.meta[name] ?? { displayName: name, order: index };
      spaces.meta[name] = { ...meta, order: index };
    });
    this.writeSpaces(spaces);
  }

  removeMeta(name: string): void {
    const spaces = this.readSpaces();
    delete spaces.meta[name];
    spaces.order = spaces.order.filter((item) => item !== name);
    this.writeSpaces(spaces);
  }

  removeHubData(name: string): void {
    if (name === "web") {
      throw new Error("refusing to delete web hub data");
    }
    const dir = this.hubDataDir(name);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  removeOfficialProfile(name: string): void {
    if (name === "web") {
      throw new Error("refusing to delete the web profile");
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
    if (!PROFILE_NAME_RE.test(name)) {
      throw new Error("name must match ^[a-z0-9][a-z0-9-]{0,38}$");
    }
    if ((RESERVED_PROFILE_NAMES as readonly string[]).includes(name)) {
      throw new Error(`${name} is reserved`);
    }
    if (this.has(name)) {
      throw new Error(`profile ${name} already exists`);
    }
  }

  hasWorkbenchPatch(name: string): boolean {
    if (name === "web") return false;
    const path = join(this.profilesDir(), name, "cordis.patch.yml");
    if (!existsSync(path)) return false;
    const text = readFileSync(path, "utf8");
    return text.includes(`hub/${name}/sessions`) && text.includes(`hub/${name}/storages`);
  }

  classify(name: string, path: string): ProfileKind {
    if (name === "web") return "root";
    if (!this.hasWebApp(path)) return "hidden";
    return "workbench";
  }

  hasWebApp(profilePath: string): boolean {
    const pkgPath = join(profilePath, "package.json");
    if (!existsSync(pkgPath)) return false;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dsh?: { profile?: { bundles?: string[] } };
      };
      return (pkg.dsh?.profile?.bundles ?? []).includes("@deepseek-ai/dsh-web-app");
    } catch {
      return false;
    }
  }

  ensureHubDir(): void {
    mkdirSync(join(this.dshHome, "hub"), { recursive: true });
  }
}
