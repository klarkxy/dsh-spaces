import { lstatSync, realpathSync } from "../../../shared/node/filesystem";
import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  compareScannedProfiles,
  defaultSpaceMeta,
  normalizeSpacesFile,
  packageHasWebApp,
} from "../../../core/domain/registry";
import { atomicWrite } from "../atomic";
import { assertBrowserDumpIsolated } from '../../../core/domain/isolation';
import {
  PatchForbiddenError,
  PatchVerifyError,
  PatchWriter,
  SESSION_ROW_ID,
  STORAGE_ROW_ID,
  assertDumpPatched,
} from "../profile/patch-writer";
import { ProfileRegistry } from "../profile/profile-registry";
import { readSpaceModelConfig } from "../llm/main-model-sync";
import { SNAPSHOT_ID_RE } from "../../../shared/snapshots";
import type {
  CreateSpaceInput,
  SpaceDetail,
  SpaceSummary,
  SpacesCapabilities,
  SpacesApi,
  SpacesMode,
  SpacesOverview,
} from "../../../shared/spaces-control";
import { SPACE_ID_RE, spaceIdFromName, type SpaceMeta } from "../../../shared/types";
import {
  HomeOperationLock,
  type HomeLockInspect,
} from "../home/home-operation-lock";
import {
  CliInterruptedError,
  DEFAULT_CLI_TIMEOUT_MS,
  bindDshCli,
  invocationProfile,
  isCompatibleDshCliVersion,
  spawnBoundCli,
  type BoundCliResult,
  type BoundCliRunner,
  type BoundRuntime,
} from "./spaces-service/cli";
import {
  DIAGNOSTIC,
  SpacesPublicError,
  parseCreateInput,
  parseSpaceId,
  toPublic,
} from "./spaces-service/public-errors";
import {
  assertLexicalInside,
  canonicalExisting,
  formatLiveRoot,
  inside,
  isDefaultIsolationRoot,
  lexists,
  matchesIsolation,
  profileDirFromBaseUrl,
  projectedInside,
  publicPluginName,
  publicPluginVersion,
  readSnapshotManifest,
  safeDisplayName,
  sameContainedPath,
  samePath,
} from "./spaces-service/paths";

export {
  COMPATIBLE_DSH_CLI_VERSION,
  isCompatibleDshCliVersion,
  DSH_CLI_PACKAGE,
  CLI_OUTPUT_CAP,
  DEFAULT_CLI_TIMEOUT_MS,
  invocationProfile,
  bindDshCli,
  spawnBoundCli,
} from "./spaces-service/cli";
export type { BoundCliResult, BoundCliRunner } from "./spaces-service/cli";
export {
  PUBLIC_ERROR,
  DIAGNOSTIC,
  SpacesPublicError,
  parseCreateInput,
  parseSpaceId,
} from "./spaces-service/public-errors";
export type { SpacesErrorCode } from "./spaces-service/public-errors";

export const MUTATION_JOURNAL_NAME = ".dsh-spaces-mutation.json";

export interface SpacesLoaderEntry {
  id?: string;
  disabled?: boolean;
  options?: {
    id?: string;
    name?: string;
    group?: boolean | null;
    config?: { root?: unknown };
  };
}

export interface SpacesLoaderView {
  config?: { baseUrl?: string };
  entries(): Iterable<SpacesLoaderEntry>;
}


/** Trusted Supervisor-only creation recipe; paths and executable selection never come from RPC. */
export interface SpaceCreationRecipe {
  base: 'web' | 'browser';
  baseVersion: string;
  runtimeVersion: string;
  runCli: BoundCliRunner;
  initialize?: (name: string) => Promise<void>;
}

export interface HomeLockPort {
  run<T>(label: string, action: () => Promise<T>): Promise<T>;
  inspect(): HomeLockInspect;
  unlockDead(): unknown;
}

export interface NodeSpacesServiceOptions {
  home: string;
  /** The installed Host explicitly authorizes its own home; never changes process.env. */
  allowRealHome?: boolean;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  baseUrl?: string;
  loader?: SpacesLoaderView;
  snapshotRoot?: string;
  lock?: HomeLockPort;
  runCli?: BoundCliRunner;
  cliTimeoutMs?: number;
}

interface MutationJournal {
  version: 1;
  op: "create";
  spaceId: string;
  phase: "cli" | "patch" | "verify-cli" | "meta";
  startedAt: string;
}

type JournalState = { kind: "absent" } | { kind: "blocked" } | { kind: "record"; record: MutationJournal };


interface HostIdentity {
  home: string | null;
  hostSpaceId: string | null;
  confirmed: boolean;
}

interface SafeProfile {
  name: string;
  hasWebApp: boolean;
  meta: SpaceMeta;
}

type IsolationOutcome = "valid" | "invalid" | "interrupted";


/**
 * Node control-plane for Host and tests. Binds CLI to process.argv[1] only.
 * Never installs a runtime and never copies raw errors, paths, or secrets into DTOs.
 */
export class NodeSpacesService implements SpacesApi {
  private readonly operation = new AsyncLocalStorage<{ active: boolean; journal: boolean }>();
  private get ownedRun(): boolean { return this.operation.getStore()?.active === true; }
  private get sessionJournal(): boolean { return this.ownedRun && this.operation.getStore()?.journal === true; }
  private cachedLock: HomeLockPort | undefined;

  constructor(private readonly options: NodeSpacesServiceOptions) {}

  async overview(): Promise<SpacesOverview> {
    const capabilities = this.capabilities();
    return { capabilities, spaces: this.listSummaries(capabilities) };
  }

  async detail(id: string): Promise<SpaceDetail> {
    const capabilities = this.capabilities();
    const name = this.requireExistingId(id, capabilities);
    const space = this.summarize(name, capabilities);
    if (!space) throw new SpacesPublicError("spaces/not-found");
    return {
      space,
      models: readSpaceModelConfig(this.options.home, name),
      plugins: this.readPlugins(name),
      snapshots: this.readSnapshots(name).items,
      diagnostics: this.detailDiagnostics(name, capabilities),
    };
  }

  async create(input: CreateSpaceInput, recipe?: SpaceCreationRecipe): Promise<SpaceSummary> {
    const parsed = parseCreateInput(input);
    try {
      return await this.withLock("spaces.create", async () => {
        const capabilities = this.capabilities();
        this.assertCanMutate(capabilities);
        const spaceId = spaceIdFromName(parsed.name);
        if (spaceId === capabilities.hostSpaceId) {
          throw new SpacesPublicError("spaces/host-denied");
        }
        this.assertCreateLayout(spaceId);
        if (this.profileExists(spaceId)) {
          throw new SpacesPublicError("spaces/already-exists");
        }
        const registry = this.registry();
        try {
          registry.validateNewName(spaceId);
        } catch {
          throw new SpacesPublicError("spaces/invalid-input");
        }
        this.writeJournal({
          version: 1,
          op: "create",
          spaceId,
          phase: "cli",
          startedAt: new Date().toISOString(),
        });
        const runCli = recipe?.runCli ?? ((args: readonly string[]) => this.runCli(args));
        if (recipe?.initialize) await recipe.initialize(spaceId);
        const created = await runCli([
          "--profile",
          spaceId,
          ...(recipe?.base === 'browser' ? [] : ["--from-default-profile", "web"]),
          "--dump-config",
        ]);
        if (created.code !== 0) throw new SpacesPublicError("spaces/unavailable");
        this.writeJournal({
          version: 1,
          op: "create",
          spaceId,
          phase: "patch",
          startedAt: new Date().toISOString(),
        });
        try {
          if (recipe?.base !== 'browser') new PatchWriter(this.homeRoot()).ensureWorkbenchPatch(spaceId);
        } catch (error) {
          if (error instanceof PatchForbiddenError) throw new SpacesPublicError("spaces/host-denied");
          throw new SpacesPublicError("spaces/unavailable");
        }
        this.writeJournal({
          version: 1,
          op: "create",
          spaceId,
          phase: "verify-cli",
          startedAt: new Date().toISOString(),
        });
        const isolation = await this.checkIsolation(spaceId, runCli, recipe?.base === 'browser');
        if (isolation !== "valid") throw new SpacesPublicError("spaces/unavailable");
        this.writeJournal({
          version: 1,
          op: "create",
          spaceId,
          phase: "meta",
          startedAt: new Date().toISOString(),
        });
        this.assertHubWritable();
        registry.ensureHubDir();
        registry.updateMeta(spaceId, {
          displayName: parsed.displayName,
          order: 1000,
          createdAt: new Date().toISOString(),
          ...(recipe ? { base: recipe.base, baseVersion: recipe.baseVersion, dshVersion: recipe.runtimeVersion } : {}),
        });
        this.clearJournal();
        const summary = this.summarize(spaceId, this.capabilities());
        if (!summary) throw new SpacesPublicError("spaces/unavailable");
        return summary;
      });
    } catch (error) {
      throw toPublic(error, "spaces/unavailable");
    }
  }

  capabilities(): SpacesCapabilities {
    const reasons: string[] = [];
    const identity = this.identity();
    const runtime = this.boundRuntime();
    const journal = this.readJournalState();
    const lock = this.lockSnapshot();
    const liveOk = this.liveConfigVerified(identity.hostSpaceId);
    const layout = this.layoutHealth();
    const registry = this.registryHealth();

    if (!identity.confirmed || !identity.hostSpaceId) reasons.push(DIAGNOSTIC.hostIdentityUnconfirmed.message);
    if (!runtime) reasons.push(DIAGNOSTIC.runtimeUnbound.message);
    else if (!isCompatibleDshCliVersion(runtime.version)) reasons.push(DIAGNOSTIC.runtimeIncompatible.message);
    if (!this.loaderPresent()) reasons.push(DIAGNOSTIC.loaderMissing.message);
    else if (!liveOk) reasons.push(DIAGNOSTIC.liveConfigUnverified.message);
    if (this.blockingJournal(journal)) reasons.push(DIAGNOSTIC.recoveryNeeded.message);
    if (layout === "recovery" || registry === "corrupt") reasons.push(DIAGNOSTIC.registryCorrupt.message);
    if (this.liveForeignLock(lock)) reasons.push(DIAGNOSTIC.lockHeld.message);
    if (this.lockResidue(lock)) reasons.push(DIAGNOSTIC.lockResidue.message);

    const recovery =
      this.blockingJournal(journal) ||
      this.lockResidue(lock) ||
      layout === "recovery" ||
      registry === "corrupt";
    const versionUnknown = !runtime || !isCompatibleDshCliVersion(runtime.version);
    const knownRuntime = Boolean(runtime && isCompatibleDshCliVersion(runtime.version));
    const lockedLive = this.liveForeignLock(lock);

    let mode: SpacesMode;
    if (recovery) mode = "recovery-only";
    else if (!identity.confirmed || versionUnknown) mode = "unknown-readonly";
    else if (!liveOk || lockedLive) mode = "verified-limited";
    else mode = "verified-full";

    const canMutate = mode === "verified-full" && !recovery && !lockedLive && knownRuntime && liveOk;
    return {
      mode,
      hostSpaceId: identity.confirmed ? identity.hostSpaceId : null,
      dshVersion: runtime?.version ?? null,
      canCreate: canMutate,
      reasons,
    };
  }

  private async withLock<T>(label: string, action: () => Promise<T>): Promise<T> {
    return this.lock().run(label, () => {
      const scope = { active: true, journal: false };
      return this.operation.run(scope, async () => {
        try { return await action(); }
        finally { scope.active = false; }
      });
    });
  }

  private assertCanMutate(capabilities: SpacesCapabilities): void {
    if (capabilities.mode === "recovery-only") throw new SpacesPublicError("spaces/unavailable");
    if (!capabilities.canCreate) {
      throw new SpacesPublicError("spaces/read-only");
    }
  }

  private listSummaries(capabilities: SpacesCapabilities): SpaceSummary[] {
    return this.safeProfiles(capabilities.hostSpaceId)
      .map((profile) => this.toSummary(profile, capabilities))
      .filter((row): row is SpaceSummary => row !== null);
  }

  private summarize(name: string, capabilities: SpacesCapabilities): SpaceSummary | null {
    const profile = this.safeProfiles(capabilities.hostSpaceId).find((item) => item.name === name);
    return profile ? this.toSummary(profile, capabilities) : null;
  }

  private toSummary(profile: SafeProfile, capabilities: SpacesCapabilities): SpaceSummary {
    const isHost = capabilities.hostSpaceId === profile.name;
    return {
      id: profile.name,
      displayName: safeDisplayName(profile.meta.displayName, profile.name),
      isHost,
      hasWebApp: profile.hasWebApp,
      status: isHost ? "running" : "unknown",
    };
  }

  private loaderPresent(): boolean {
    const loader = this.options.loader;
    return Boolean(loader && typeof loader.entries === "function");
  }

  private liveConfigVerified(hostSpaceId: string | null): boolean {
    if (!this.loaderPresent() || !hostSpaceId) return false;
    const live = this.liveRoots();
    if (!live) return false;
    return this.rootsAreDefault(live) || this.rootsAreIsolated(live, hostSpaceId);
  }

  private liveRoots(): { session: string; storage: string } | null {
    const loader = this.options.loader;
    if (!loader || typeof loader.entries !== "function") return null;
    let session: string | null = null;
    let storage: string | null = null;
    try {
      for (const entry of loader.entries()) {
        if (entry.options?.group) continue;
        const id = entry.options?.id ?? entry.id;
        const formatted = formatLiveRoot(entry.options?.config?.root);
        if (id === SESSION_ROW_ID) session = formatted;
        if (id === STORAGE_ROW_ID) storage = formatted;
      }
    } catch {
      return null;
    }
    if (!session || !storage) return null;
    return { session, storage };
  }

  private rootsAreDefault(roots: { session: string; storage: string }): boolean {
    const home = this.homeRootOrNull();
    return (
      isDefaultIsolationRoot(roots.session, "sessions", home) &&
      isDefaultIsolationRoot(roots.storage, "storages", home)
    );
  }

  private rootsAreIsolated(roots: { session: string; storage: string }, name: string): boolean {
    const home = this.homeRootOrNull();
    return (
      matchesIsolation(roots.session, name, "sessions", home) &&
      matchesIsolation(roots.storage, name, "storages", home)
    );
  }

  private readPlugins(name: string): Array<{ name: string; version: string | null }> {
    const pkgPath = this.containedExistingFile(join(this.homeRoot(), "profiles", name, "package.json"), this.homeRoot());
    if (!pkgPath) return [];
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dependencies?: Record<string, unknown>;
        dsh?: { profile?: { bundles?: unknown } };
      };
      const deps = parsed.dependencies ?? {};
      const bundles = Array.isArray(parsed.dsh?.profile?.bundles)
        ? parsed.dsh.profile.bundles.filter((item): item is string => typeof item === "string")
        : [];
      const names = [...bundles, ...Object.keys(deps)];
      const seen = new Set<string>();
      const rows: Array<{ name: string; version: string | null }> = [];
      for (const raw of names) {
        const pluginName = publicPluginName(raw);
        if (!pluginName || seen.has(pluginName)) continue;
        seen.add(pluginName);
        rows.push({ name: pluginName, version: publicPluginVersion(deps[raw]) });
      }
      return rows;
    } catch {
      return [];
    }
  }

  private readSnapshots(spaceId: string): {
    items: Array<{ id: string; createdAt: string; runtimeVersion: string | null }>;
    diagnostic: (typeof DIAGNOSTIC)[keyof typeof DIAGNOSTIC] | null;
  } {
    const configured = this.options.snapshotRoot;
    if (typeof configured !== "string" || !configured.trim()) {
      return { items: [], diagnostic: DIAGNOSTIC.snapshotsUnavailable };
    }
    const root = this.snapshotRoot(configured);
    if (!root) return { items: [], diagnostic: DIAGNOSTIC.snapshotsUnreadable };
    const home = this.homeRootOrNull();
    if (!home) return { items: [], diagnostic: DIAGNOSTIC.snapshotsUnreadable };
    try {
      const items: Array<{ id: string; createdAt: string; runtimeVersion: string | null }> = [];
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!SNAPSHOT_ID_RE.test(entry.name)) continue;
        const dir = this.containedExistingDir(join(root, entry.name), root);
        if (!dir) continue;
        const manifestPath = this.containedExistingFile(join(dir, "manifest.json"), root);
        if (!manifestPath) continue;
        const meta = readSnapshotManifest(readFileSync(manifestPath, "utf8"), entry.name, home, spaceId);
        if (meta) items.push(meta);
      }
      return { items, diagnostic: null };
    } catch {
      return { items: [], diagnostic: DIAGNOSTIC.snapshotsUnreadable };
    }
  }

  private detailDiagnostics(name: string, capabilities: SpacesCapabilities): SpaceDetail["diagnostics"] {
    const rows: SpaceDetail["diagnostics"] = [];
    const push = (level: "info" | "warning" | "error", item: { code: string; message: string }) => {
      rows.push({ level, code: item.code, message: item.message });
    };
    for (const reason of capabilities.reasons) {
      const hit = Object.values(DIAGNOSTIC).find((item) => item.message === reason);
      if (hit) push(hit.code === "RECOVERY_NEEDED" || hit.code === "LOCK_RESIDUE" || hit.code === "REGISTRY_CORRUPT" ? "error" : "warning", hit);
    }
    const snapshots = this.readSnapshots(name);
    if (snapshots.diagnostic) push("info", snapshots.diagnostic);
    return rows;
  }

  private async checkIsolation(name: string, runCli: BoundCliRunner = args => this.runCli(args), browser = false): Promise<IsolationOutcome> {
    try {
      const dump = await runCli(["--profile", name, "--dump-config"]);
      if (dump.code !== 0) return "invalid";
      try {
        if (browser) assertBrowserDumpIsolated(dump.stdout, name);
        else assertDumpPatched(dump.stdout, name);
        return "valid";
      } catch (error) {
        if (error instanceof PatchVerifyError) return "invalid";
        return "invalid";
      }
    } catch (error) {
      if (error instanceof CliInterruptedError) return "interrupted";
      if (error instanceof SpacesPublicError && error.code === "spaces/read-only") throw error;
      return "interrupted";
    }
  }

  private async runCli(args: readonly string[]): Promise<BoundCliResult> {
    if (this.options.runCli) return this.options.runCli(args);
    const runtime = this.boundRuntime();
    if (!runtime) throw new SpacesPublicError("spaces/read-only");
    return spawnBoundCli(
      this.options.execPath ?? process.execPath,
      runtime.bin,
      this.homeRoot(),
      this.env(),
      args,
      this.options.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
    );
  }

  private requireExistingId(id: string, capabilities: SpacesCapabilities): string {
    const name = parseSpaceId(id);
    const hit = this.listSummaries(capabilities).find((row) => row.id === name);
    if (!hit) throw new SpacesPublicError("spaces/not-found");
    return hit.id;
  }

  private identity(): HostIdentity {
    const home = this.canonicalOperatingHome();
    const invoked = invocationProfile(this.argv());
    const fromBase = profileDirFromBaseUrl(this.options.baseUrl);
    if (!home || !invoked || !fromBase) {
      return { home, hostSpaceId: null, confirmed: false };
    }
    const expected = join(home, "profiles", invoked);
    if (!sameContainedPath(expected, fromBase, home)) {
      return { home, hostSpaceId: null, confirmed: false };
    }
    return { home, hostSpaceId: invoked, confirmed: true };
  }

  private canonicalOperatingHome(): string | null {
    const configured = this.options.home?.trim();
    if (!configured) return null;
    const resolved = resolve(configured);
    const envHome = this.env().DSH_HOME?.trim();
    if (envHome && !samePath(resolved, resolve(envHome))) return null;
    return this.realDirectory(resolved);
  }

  private homeRoot(): string {
    const home = this.homeRootOrNull();
    if (!home) throw new SpacesPublicError("spaces/read-only");
    return home;
  }

  private homeRootOrNull(): string | null {
    return this.identity().home ?? this.canonicalOperatingHome();
  }

  private boundRuntime(): BoundRuntime | null {
    const argv1 = this.argv()[1];
    if (typeof argv1 !== "string" || !argv1) return null;
    return bindDshCli(argv1);
  }

  private argv(): readonly string[] {
    return this.options.argv ?? process.argv;
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private lock(): HomeLockPort {
    if (this.options.lock) return this.options.lock;
    if (!this.cachedLock) this.cachedLock = new HomeOperationLock(this.homeRoot(), { allowRealHome: this.options.allowRealHome });
    return this.cachedLock;
  }

  private lockSnapshot(): HomeLockInspect | { held: false } {
    try {
      return this.lock().inspect();
    } catch {
      return { held: true, incomplete: true, lockDir: "" };
    }
  }

  private liveForeignLock(lock: HomeLockInspect | { held: false }): boolean {
    if (!lock.held || !("owner" in lock)) return false;
    return !this.ownedRun;
  }

  private lockResidue(lock: HomeLockInspect | { held: false }): boolean {
    return Boolean(lock.held && !("owner" in lock));
  }

  private registry(): ProfileRegistry {
    return new ProfileRegistry(this.homeRoot(), { allowRealHome: this.options.allowRealHome });
  }

  private layoutHealth(): "ok" | "recovery" {
    const home = this.homeRootOrNull();
    if (!home) return "ok";
    const profiles = join(home, "profiles");
    if (lexists(profiles) && !this.isExactChildDir(home, profiles, "profiles")) return "recovery";
    const hub = join(home, "hub");
    if (lexists(hub) && !this.isExactChildDir(home, hub, "hub")) return "recovery";
    return "ok";
  }

  private registryHealth(): "ok" | "corrupt" {
    const home = this.homeRootOrNull();
    if (!home || this.layoutHealth() === "recovery") return this.layoutHealth() === "recovery" ? "corrupt" : "ok";
    const path = join(home, "hub", "spaces.json");
    if (!lexists(path)) return "ok";
    if (!this.containedExistingFile(path, home)) return "corrupt";
    try {
      normalizeSpacesFile(JSON.parse(readFileSync(path, "utf8")));
      return "ok";
    } catch {
      return "corrupt";
    }
  }

  private safeProfiles(hostSpaceId: string | null): SafeProfile[] {
    const home = this.homeRootOrNull();
    if (!home || this.layoutHealth() === "recovery") return [];
    const profilesDir = join(home, "profiles");
    if (!lexists(profilesDir)) return [];
    if (!this.isExactChildDir(home, profilesDir, "profiles")) return [];
    const hostReal = hostSpaceId ? this.containedExistingDir(join(profilesDir, hostSpaceId), home) : null;
    const spaces = this.readSpacesFile();
    const rows: SafeProfile[] = [];
    for (const [name, meta] of Object.entries(spaces?.meta ?? {})) {
      // A space exists only when Spaces registered it at creation.
      if (!SPACE_ID_RE.test(name) || typeof meta.createdAt !== "string" || !meta.createdAt) continue;
      const dir = this.containedExistingDir(join(profilesDir, name), home);
      if (!dir) continue;
      if (hostReal && samePath(dir, hostReal)) continue;
      rows.push({
        name,
        hasWebApp: this.readHasWebApp(join(dir, "package.json"), home),
        meta,
      });
    }
    if (hostReal && !rows.some((row) => row.name === hostSpaceId)) {
      const hasWebApp = this.readHasWebApp(join(hostReal, "package.json"), home);
      rows.push({
        name: hostSpaceId!,
        hasWebApp,
        meta: spaces?.meta[hostSpaceId!] ?? defaultSpaceMeta(hostSpaceId!),
      });
    }
    const order = spaces?.order ?? [];
    rows.sort((a, b) => compareScannedProfiles(a, b, order));
    return rows;
  }

  private readSpacesFile(): ReturnType<typeof normalizeSpacesFile> | null {
    if (this.registryHealth() !== "ok") return null;
    const home = this.homeRootOrNull();
    if (!home) return null;
    const path = this.containedExistingFile(join(home, "hub", "spaces.json"), home);
    if (!path) return null;
    try {
      return normalizeSpacesFile(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return null;
    }
  }

  private readHasWebApp(pkgPath: string, home: string): boolean {
    const file = this.containedExistingFile(pkgPath, home);
    if (!file) return false;
    try {
      return packageHasWebApp(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return false;
    }
  }

  private profileExists(name: string): boolean {
    const home = this.homeRootOrNull();
    if (!home) return false;
    return Boolean(this.containedExistingDir(join(home, "profiles", name), home));
  }

  private assertCreateLayout(name: string): void {
    const home = this.homeRoot();
    const profiles = join(home, "profiles");
    if (lexists(profiles) && !this.isExactChildDir(home, profiles, "profiles")) {
      throw new SpacesPublicError("spaces/unavailable");
    }
    const hub = join(home, "hub");
    if (lexists(hub) && !this.isExactChildDir(home, hub, "hub")) {
      throw new SpacesPublicError("spaces/unavailable");
    }
    if (!this.ancestorContained(join(profiles, name), home)) {
      throw new SpacesPublicError("spaces/unavailable");
    }
    if (!this.ancestorContained(join(hub, name), home)) {
      throw new SpacesPublicError("spaces/unavailable");
    }
  }

  private assertHubWritable(): void {
    const home = this.homeRoot();
    const hub = join(home, "hub");
    if (lexists(hub) && !this.isExactChildDir(home, hub, "hub")) {
      throw new SpacesPublicError("spaces/unavailable");
    }
    if (!this.ancestorContained(hub, home)) throw new SpacesPublicError("spaces/unavailable");
  }

  private journalPath(): string {
    const home = this.homeRoot();
    const path = join(home, MUTATION_JOURNAL_NAME);
    assertLexicalInside(home, path);
    return path;
  }

  private readJournalState(): JournalState {
    const home = this.homeRootOrNull();
    if (!home) return { kind: "absent" };
    const path = join(home, MUTATION_JOURNAL_NAME);
    if (!lexists(path)) return { kind: "absent" };
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isFile()) return { kind: "blocked" };
      const real = realpathSync(path);
      if (!inside(home, real)) return { kind: "blocked" };
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MutationJournal>;
      if (parsed.version !== 1 || parsed.op !== "create") {
        return { kind: "blocked" };
      }
      return {
        kind: "record",
        record: {
          version: 1,
          op: parsed.op,
          spaceId: typeof parsed.spaceId === "string" ? parsed.spaceId : "unknown",
          phase: parsed.phase === "patch" || parsed.phase === "verify-cli" || parsed.phase === "meta" ? parsed.phase : "cli",
          startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
        },
      };
    } catch {
      return { kind: "blocked" };
    }
  }

  private blockingJournal(state: JournalState): boolean {
    if (state.kind === "blocked") return true;
    if (state.kind === "absent") return false;
    if (this.ownedRun && this.sessionJournal) return false;
    return true;
  }

  private writeJournal(journal: MutationJournal): void {
    atomicWrite(this.journalPath(), `${JSON.stringify(journal)}\n`);
    const scope = this.operation.getStore();
    if (scope) scope.journal = true;
  }

  private clearJournal(): void {
    const path = this.journalPath();
    if (lexists(path)) {
      const st = lstatSync(path);
      if (!st.isSymbolicLink() && st.isFile()) unlinkSync(path);
    }
    const scope = this.operation.getStore();
    if (scope) scope.journal = false;
  }

  private isExactChildDir(home: string, path: string, child: string): boolean {
    const real = this.containedExistingDir(path, home);
    return Boolean(real && samePath(real, join(home, child)));
  }

  private containedExistingFile(path: string, root: string): string | null {
    const real = canonicalExisting(root, path);
    if (!real) return null;
    try {
      return lstatSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  private containedExistingDir(path: string, root: string): string | null {
    const real = canonicalExisting(root, path);
    if (!real) return null;
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        if (!inside(root, real) || !lstatSync(real).isDirectory()) return null;
        return real;
      }
      return lstatSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  }

  private ancestorContained(path: string, root: string): boolean {
    return projectedInside(root, path);
  }

  private realDirectory(path: string): string | null {
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
      return realpathSync(path);
    } catch {
      return null;
    }
  }

  private snapshotRoot(configured: string): string | null {
    if (!isAbsolute(configured)) return null;
    try {
      const resolved = resolve(configured);
      const st = lstatSync(resolved);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
      return realpathSync(resolved);
    } catch {
      return null;
    }
  }
}

