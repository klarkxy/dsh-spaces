import { type ChildProcess } from "node:child_process";
import { spawnObserved } from "../../main/owned-process-record";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyProfile,
  compareScannedProfiles,
  defaultSpaceMeta,
  normalizeSpacesFile,
  packageHasWebApp,
} from "../../core/domain/registry";
import { atomicWrite } from "../../main/atomic";
import {
  PatchForbiddenError,
  PatchVerifyError,
  PatchWriter,
  SESSION_ROW_ID,
  STORAGE_ROW_ID,
  assertDumpPatched,
  extractRoot,
  isExpectedIsolationRoot,
  patchTextLooksIsolated,
} from "../../main/patch-writer";
import { ProfileRegistry } from "../../main/profile-registry";
import { terminateProcessTree } from "../../main/terminate-process";
import { isExactRuntimeVersion } from "../../shared/runtime";
import { SNAPSHOT_ID_RE } from "../../shared/snapshots";
import type {
  CreateSpaceInput,
  SpaceDetail,
  SpaceSummary,
  SpacesCapabilities,
  SpacesControlApi,
  SpacesMode,
  SpacesOverview,
  VerifySpaceResult,
} from "../../shared/spaces-control";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES, type SpaceMeta } from "../../shared/types";
import {
  HomeLockBusyError,
  HomeOperationLock,
  type HomeLockInspect,
} from "./home-operation-lock";

/** Fixture exact version for tests. Not a product allowlist. */
export const COMPATIBLE_DSH_CLI_VERSION = "0.1.5-rc.1";

/** Any exact npm version can bind. Tags, ranges, and junk stay out. */
export function isCompatibleDshCliVersion(version: string): boolean {
  return isExactRuntimeVersion(version);
}

export const DSH_CLI_PACKAGE = "@deepseek-ai/dsh";
export const MUTATION_JOURNAL_NAME = ".dsh-spaces-mutation.json";
export const CLI_OUTPUT_CAP = 256 * 1024;
export const DEFAULT_CLI_TIMEOUT_MS = 60_000;

export const PUBLIC_ERROR = {
  "spaces/invalid-input": "The request is not a valid space operation.",
  "spaces/not-found": "That space was not found.",
  "spaces/host-denied": "The current host space cannot be modified this way.",
  "spaces/read-only": "Spaces are read-only until the host identity and runtime are confirmed.",
  "spaces/unavailable": "A previous space operation did not finish. Recovery is required.",
  "spaces/locked": "Another space operation is already running.",
  "spaces/already-exists": "A space with that name already exists.",
} as const;

export type SpacesErrorCode = keyof typeof PUBLIC_ERROR;

export const DIAGNOSTIC = {
  hostIdentityUnconfirmed: {
    code: "HOST_IDENTITY_UNCONFIRMED",
    message: "Host identity could not be confirmed from DSH home, loader root, and invocation profile.",
  },
  runtimeUnbound: {
    code: "RUNTIME_UNBOUND",
    message: "The bound DSH CLI could not be validated from the current process.",
  },
  runtimeIncompatible: {
    code: "RUNTIME_INCOMPATIBLE",
    message: "The bound DSH CLI is not an exact installed version.",
  },
  loaderMissing: {
    code: "LOADER_MISSING",
    message: "Required loader service is not available.",
  },
  liveConfigUnverified: {
    code: "LIVE_CONFIG_UNVERIFIED",
    message: "Current host configuration roots could not be verified.",
  },
  recoveryNeeded: {
    code: "RECOVERY_NEEDED",
    message: "A previous space mutation did not finish.",
  },
  lockHeld: {
    code: "LOCK_HELD",
    message: "A home operation lock is already held.",
  },
  lockResidue: {
    code: "LOCK_RESIDUE",
    message: "A home operation lock is incomplete or ambiguous and was not stolen.",
  },
  snapshotsUnavailable: {
    code: "SNAPSHOTS_UNAVAILABLE",
    message: "Snapshot metadata is unavailable because no snapshot root is configured.",
  },
  snapshotsUnreadable: {
    code: "SNAPSHOTS_UNREADABLE",
    message: "Configured snapshot root could not be read safely.",
  },
  isolationFileOnly: {
    code: "ISOLATION_FILE_ONLY",
    message: "Isolation is not marked verified without current composed configuration evidence.",
  },
  registryCorrupt: {
    code: "REGISTRY_CORRUPT",
    message: "The spaces registry could not be read safely.",
  },
} as const;

const DISPLAY_NAME_MAX = 80;
const DSH_HOME_PATH_RE = /^dshHomePath\(\s*(['"])([^'"]+)\1\s*\)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const UNCREATABLE = new Set<string>([...RESERVED_PROFILE_NAMES, "desktop", "acp", "sdk", "sdk-minimal"]);

export class SpacesPublicError extends Error {
  readonly name = "SpacesPublicError";
  constructor(
    readonly code: SpacesErrorCode,
    message: string = PUBLIC_ERROR[code],
  ) {
    super(message);
  }
}

class CliInterruptedError extends Error {
  readonly name = "CliInterruptedError";
}

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

export interface BoundCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type BoundCliRunner = (args: readonly string[]) => Promise<BoundCliResult>;

export interface HomeLockPort {
  run<T>(label: string, action: () => Promise<T>): Promise<T>;
  inspect(): HomeLockInspect;
  unlockDead(): unknown;
}

export interface NodeSpacesControlOptions {
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
  op: "create" | "verify";
  spaceId: string;
  phase: "cli" | "patch" | "verify-cli" | "meta";
  startedAt: string;
}

type JournalState = { kind: "absent" } | { kind: "blocked" } | { kind: "record"; record: MutationJournal };

interface BoundRuntime {
  bin: string;
  version: string;
}

interface HostIdentity {
  home: string | null;
  hostSpaceId: string | null;
  confirmed: boolean;
}

interface SafeProfile {
  name: string;
  hasWebApp: boolean;
  kind: "root" | "workbench";
  meta: SpaceMeta;
}

type IsolationOutcome = "valid" | "invalid" | "interrupted";

/**
 * Node control-plane for Host and tests. Binds CLI to process.argv[1] only.
 * Never installs a runtime and never copies raw errors, paths, or secrets into DTOs.
 */
export class NodeSpacesControl implements SpacesControlApi {
  private readonly operation = new AsyncLocalStorage<{ active: boolean; journal: boolean }>();
  private get ownedRun(): boolean { return this.operation.getStore()?.active === true; }
  private get sessionJournal(): boolean { return this.ownedRun && this.operation.getStore()?.journal === true; }
  private cachedLock: HomeLockPort | undefined;

  constructor(private readonly options: NodeSpacesControlOptions) {}

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
      plugins: this.readPlugins(name),
      snapshots: this.readSnapshots(name).items,
      diagnostics: this.detailDiagnostics(name, capabilities),
    };
  }

  async create(input: CreateSpaceInput): Promise<SpaceSummary> {
    const parsed = parseCreateInput(input);
    try {
      return await this.withLock("spaces.create", async () => {
        const capabilities = this.capabilities();
        this.assertCanMutate(capabilities, "create");
        if (parsed.name === capabilities.hostSpaceId) {
          throw new SpacesPublicError("spaces/host-denied");
        }
        this.assertCreateLayout(parsed.name);
        if (this.profileExists(parsed.name)) {
          throw new SpacesPublicError("spaces/already-exists");
        }
        const registry = this.registry();
        try {
          registry.validateNewName(parsed.name);
        } catch {
          throw new SpacesPublicError("spaces/invalid-input");
        }
        this.writeJournal({
          version: 1,
          op: "create",
          spaceId: parsed.name,
          phase: "cli",
          startedAt: new Date().toISOString(),
        });
        const created = await this.runCli([
          "--profile",
          parsed.name,
          "--from-default-profile",
          "web",
          "--dump-config",
        ]);
        if (created.code !== 0) throw new SpacesPublicError("spaces/unavailable");
        this.writeJournal({
          version: 1,
          op: "create",
          spaceId: parsed.name,
          phase: "patch",
          startedAt: new Date().toISOString(),
        });
        try {
          new PatchWriter(this.homeRoot()).ensureWorkbenchPatch(parsed.name);
        } catch (error) {
          if (error instanceof PatchForbiddenError) throw new SpacesPublicError("spaces/host-denied");
          throw new SpacesPublicError("spaces/unavailable");
        }
        this.writeJournal({
          version: 1,
          op: "create",
          spaceId: parsed.name,
          phase: "verify-cli",
          startedAt: new Date().toISOString(),
        });
        const isolation = await this.checkIsolation(parsed.name);
        if (isolation !== "valid") throw new SpacesPublicError("spaces/unavailable");
        this.writeJournal({
          version: 1,
          op: "create",
          spaceId: parsed.name,
          phase: "meta",
          startedAt: new Date().toISOString(),
        });
        this.assertHubWritable();
        registry.ensureHubDir();
        registry.updateMeta(parsed.name, {
          displayName: parsed.displayName,
          order: 1000,
        });
        this.clearJournal();
        const summary = this.summarize(parsed.name, this.capabilities());
        if (!summary) throw new SpacesPublicError("spaces/unavailable");
        return summary;
      });
    } catch (error) {
      throw toPublic(error, "spaces/unavailable");
    }
  }

  async verify(id: string): Promise<VerifySpaceResult> {
    try {
      return await this.withLock("spaces.verify", async () => {
        const capabilities = this.capabilities();
        this.assertCanMutate(capabilities, "verify");
        const name = this.requireExistingId(id, capabilities);
        if (name === capabilities.hostSpaceId) {
          throw new SpacesPublicError("spaces/host-denied");
        }
        if (!this.runtimeCompatible()) {
          throw new SpacesPublicError("spaces/read-only");
        }
        this.writeJournal({
          version: 1,
          op: "verify",
          spaceId: name,
          phase: "verify-cli",
          startedAt: new Date().toISOString(),
        });
        const isolation = await this.checkIsolation(name);
        if (isolation === "valid") {
          this.clearJournal();
          return { id: name, valid: true, message: "Isolation matches the current composed configuration." };
        }
        if (isolation === "invalid") {
          this.clearJournal();
          return { id: name, valid: false, message: "Isolation could not be verified." };
        }
        throw new SpacesPublicError("spaces/unavailable");
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
      canVerify: canMutate,
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

  private assertCanMutate(capabilities: SpacesCapabilities, kind: "create" | "verify"): void {
    if (capabilities.mode === "recovery-only") throw new SpacesPublicError("spaces/unavailable");
    if (kind === "create" && !capabilities.canCreate) {
      if (capabilities.mode === "unknown-readonly") throw new SpacesPublicError("spaces/read-only");
      throw new SpacesPublicError("spaces/read-only");
    }
    if (kind === "verify" && !capabilities.canVerify) {
      if (capabilities.mode === "unknown-readonly") throw new SpacesPublicError("spaces/read-only");
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
      isolation: this.isolationOf(profile.name, isHost),
    };
  }

  private isolationOf(name: string, isHost: boolean): SpaceSummary["isolation"] {
    if (isHost) {
      const live = this.liveRoots();
      if (!live) return "unverified";
      if (this.rootsAreDefault(live)) return "default";
      if (this.rootsAreIsolated(live, name)) return "verified";
      return "invalid";
    }
    const patch = this.readPatchText(name);
    if (patch === undefined) return "unverified";
    try {
      const session = extractRoot(patch, SESSION_ROW_ID);
      const storage = extractRoot(patch, STORAGE_ROW_ID);
      if (session && storage) {
        if (
          isExpectedIsolationRoot(session, name, "sessions") &&
          isExpectedIsolationRoot(storage, name, "storages")
        ) {
          return "unverified";
        }
        return "invalid";
      }
    } catch {
      return "invalid";
    }
    if (patchTextLooksIsolated(patch, name)) return "unverified";
    return "unverified";
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
    if (this.isolationOf(name, capabilities.hostSpaceId === name) === "unverified") {
      push("info", DIAGNOSTIC.isolationFileOnly);
    }
    return rows;
  }

  private async checkIsolation(name: string): Promise<IsolationOutcome> {
    try {
      const dump = await this.runCli(["--profile", name, "--dump-config"]);
      if (dump.code !== 0) return "invalid";
      try {
        assertDumpPatched(dump.stdout, name);
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

  private runtimeCompatible(): boolean {
    const runtime = this.boundRuntime();
    return runtime !== null && isCompatibleDshCliVersion(runtime.version);
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
    let names: string[] = [];
    try {
      names = readdirSync(profilesDir, { withFileTypes: true })
        .filter((entry) => entry.name !== "node_modules")
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const hostReal = hostSpaceId ? this.containedExistingDir(join(profilesDir, hostSpaceId), home) : null;
    const spaces = this.readSpacesFile();
    const rows: SafeProfile[] = [];
    for (const name of names) {
      if (name !== "web") {
        try {
          parseSpaceId(name);
        } catch {
          continue;
        }
      }
      const dir = this.containedExistingDir(join(profilesDir, name), home);
      if (!dir) continue;
      if (hostReal && name !== hostSpaceId && samePath(dir, hostReal)) continue;
      const hasWebApp = this.readHasWebApp(join(dir, "package.json"), home);
      const kind = classifyProfile(name, hasWebApp);
      if (kind === "hidden") continue;
      rows.push({
        name,
        hasWebApp,
        kind,
        meta: spaces?.meta[name] ?? defaultSpaceMeta(name),
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
      if (parsed.version !== 1 || (parsed.op !== "create" && parsed.op !== "verify")) {
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

  private readPatchText(name: string): string | undefined {
    const home = this.homeRootOrNull();
    if (!home) return undefined;
    const path = this.containedExistingFile(join(home, "profiles", name, "cordis.patch.yml"), home);
    if (!path) return undefined;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
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

export function parseCreateInput(input: CreateSpaceInput): { name: string; displayName: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SpacesPublicError("spaces/invalid-input");
  }
  const keys = Object.keys(input as object);
  for (const key of keys) {
    if (key !== "name" && key !== "displayName") {
      throw new SpacesPublicError("spaces/invalid-input", "The request contains unsupported fields.");
    }
  }
  if (typeof input.name !== "string") throw new SpacesPublicError("spaces/invalid-input");
  const name = input.name;
  if (!PROFILE_NAME_RE.test(name) || name.trim() !== name || UNCREATABLE.has(name) ||
    (process.platform === "win32" && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name))) {
    throw new SpacesPublicError("spaces/invalid-input");
  }
  if (input.displayName !== undefined) {
    if (typeof input.displayName !== "string") throw new SpacesPublicError("spaces/invalid-input");
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > DISPLAY_NAME_MAX || /[\u0000-\u001f\\/]/.test(displayName)) {
      throw new SpacesPublicError("spaces/invalid-input");
    }
    return { name, displayName };
  }
  return { name, displayName: name };
}

export function parseSpaceId(id: string): string {
  if (typeof id !== "string" || id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) {
    throw new SpacesPublicError("spaces/not-found");
  }
  if (id !== "web" && !PROFILE_NAME_RE.test(id)) throw new SpacesPublicError("spaces/not-found");
  return id;
}

export function invocationProfile(argv: readonly string[]): string | null {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--profile") {
      const name = args[i + 1];
      if (!name || name.startsWith("-")) return null;
      return name;
    }
  }
  if (args[0] === "web") return "web";
  return null;
}

export function bindDshCli(argv1: string): BoundRuntime | null {
  try {
    const bin = resolve(argv1);
    const realBin = realpathSync(bin);
    if (!lstatSync(realBin).isFile()) return null;
    const manifestPath = join(dirname(bin), "..", "package.json");
    const manifestStat = lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) return null;
    const realManifest = realpathSync(manifestPath);
    const pkg = JSON.parse(readFileSync(realManifest, "utf8")) as { name?: unknown; version?: unknown };
    if (pkg.name !== DSH_CLI_PACKAGE) return null;
    if (typeof pkg.version !== "string" || !isExactRuntimeVersion(pkg.version)) return null;
    return { bin: realBin, version: pkg.version };
  } catch {
    return null;
  }
}

export function spawnBoundCli(
  execPath: string,
  bin: string,
  home: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  timeoutMs = DEFAULT_CLI_TIMEOUT_MS,
): Promise<BoundCliResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawnObserved(execPath, [bin, ...args], {
      env: { ...env, DSH_HOME: home },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void finishInterrupted(child);
    }, timeoutMs);
    const take = (current: string, chunk: Buffer): string => {
      if (current.length >= CLI_OUTPUT_CAP) return current;
      const text = chunk.toString("utf8");
      const room = CLI_OUTPUT_CAP - current.length;
      return current + (text.length > room ? text.slice(0, room) : text);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = take(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = take(stderr, chunk);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CliInterruptedError());
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) reject(new CliInterruptedError());
      else resolveRun({ stdout, stderr, code: code ?? 1 });
    });

    async function finishInterrupted(owned: ChildProcess): Promise<void> {
      try {
        await terminateProcessTree(owned);
      } catch {
        try {
          owned.kill();
        } catch {
          /* still wait for close */
        }
      }
      if (owned.exitCode !== null || owned.signalCode !== null) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new CliInterruptedError());
        }
        return;
      }
      owned.once("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new CliInterruptedError());
      });
    }
  });
}

function toPublic(error: unknown, fallback: SpacesErrorCode): SpacesPublicError {
  if (error instanceof SpacesPublicError) return error;
  if (error instanceof HomeLockBusyError) return new SpacesPublicError("spaces/locked");
  if (error instanceof CliInterruptedError) return new SpacesPublicError("spaces/unavailable");
  return new SpacesPublicError(fallback);
}

function profileDirFromBaseUrl(baseUrl: string | undefined): string | null {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  try {
    const asUrl = baseUrl.includes("://") ? fileURLToPath(baseUrl) : resolve(baseUrl);
    const resolved = resolve(asUrl);
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  } catch {
    return null;
  }
}

function sameContainedPath(expected: string, actual: string, home: string): boolean {
  try {
    const left = existsSync(expected) ? realpathSync(expected) : resolve(expected);
    const right = existsSync(actual) ? realpathSync(actual) : resolve(actual);
    if (!inside(home, left) || !inside(home, right)) return false;
    return samePath(left, right);
  } catch {
    return false;
  }
}

function assertLexicalInside(root: string, target: string): void {
  if (!inside(root, resolve(target))) throw new SpacesPublicError("spaces/invalid-input");
}

function inside(root: string, target: string): boolean {
  const r = comparablePath(root);
  const t = comparablePath(target);
  if (samePath(r, t)) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean { return comparablePath(a) === comparablePath(b); }

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function canonicalExisting(root: string, target: string): string | null {
  try {
    const resolved = resolve(target);
    if (!inside(root, resolved) && !samePath(root, resolved)) return null;
    if (!lexists(resolved)) return null;
    const real = realpathSync(resolved);
    if (!inside(root, real) && !samePath(root, real)) return null;
    return real;
  } catch {
    return null;
  }
}

function projectedInside(root: string, target: string): boolean {
  try {
    const resolved = resolve(target);
    if (!inside(root, resolved)) return false;
    let current = resolved;
    while (!lexists(current)) {
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
    const realAncestor = realpathSync(current);
    if (!inside(root, realAncestor) && !samePath(root, realAncestor)) return false;
    const suffix = resolved.slice(resolve(current).length);
    const projected = join(realAncestor, suffix.replace(/^[\\/]/, ""));
    return inside(root, projected) || samePath(root, projected);
  } catch {
    return false;
  }
}

function formatLiveRoot(root: unknown): string | null {
  if (typeof root === "string") {
    if (root.startsWith("!!js ")) return root;
    if (DSH_HOME_PATH_RE.test(root.trim())) return `!!js ${root.trim()}`;
    return JSON.stringify(root);
  }
  if (root && typeof root === "object" && "__jsExpr" in root && typeof (root as { __jsExpr: unknown }).__jsExpr === "string") {
    return `!!js ${(root as { __jsExpr: string }).__jsExpr}`;
  }
  return null;
}

function isDefaultIsolationRoot(actual: string, kind: "sessions" | "storages", home: string | null): boolean {
  if (actual.startsWith("!!js ")) {
    const match = actual.slice(5).trim().match(DSH_HOME_PATH_RE);
    return match?.[2] === kind;
  }
  if (!home) return false;
  try {
    const path = actual.startsWith('"') ? (JSON.parse(actual) as string) : actual;
    return samePath(path, join(home, kind));
  } catch {
    return false;
  }
}

function matchesIsolation(
  actual: string,
  name: string,
  kind: "sessions" | "storages",
  home: string | null,
): boolean {
  if (isExpectedIsolationRoot(actual, name, kind)) return true;
  if (!home) return false;
  try {
    const path = actual.startsWith('"') ? (JSON.parse(actual) as string) : actual;
    return samePath(path, join(home, "hub", name, kind));
  } catch {
    return false;
  }
}

function publicPluginName(name: string): string | null {
  if (!/^(@[a-z0-9-~._]+\/)?[a-z0-9-~._]+$/i.test(name)) return null;
  if (name.includes("..") || name.includes("\\") || name.includes(":")) return null;
  return name;
}

function publicPluginVersion(spec: unknown): string | null {
  if (typeof spec !== "string") return null;
  if (/[\\/]|file:|git\+|github:|:\/\/|token|password|login/i.test(spec)) return null;
  return isExactRuntimeVersion(spec) ? spec : null;
}

function safeDisplayName(value: string, fallback: string): string {
  const text = value.trim();
  if (!text || text.length > DISPLAY_NAME_MAX || /[\u0000-\u001f\\/]/.test(text)) return fallback;
  return text;
}

function isIsoTimestamp(value: string): boolean {
  return ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function readSnapshotManifest(
  raw: string,
  id: string,
  home: string,
  spaceId: string,
): { id: string; createdAt: string; runtimeVersion: string | null } | null {
  try {
    const parsed = JSON.parse(raw) as {
      id?: unknown;
      createdAt?: unknown;
      runtimeVersion?: unknown;
      home?: unknown;
      profiles?: unknown;
    };
    if (typeof parsed.home !== "string" || !samePath(parsed.home, home)) return null;
    if (!Array.isArray(parsed.profiles) || !parsed.profiles.includes(spaceId)) return null;
    if (typeof parsed.createdAt !== "string" || !isIsoTimestamp(parsed.createdAt)) return null;
    const runtimeVersion =
      typeof parsed.runtimeVersion === "string" && isExactRuntimeVersion(parsed.runtimeVersion)
        ? parsed.runtimeVersion
        : null;
    return { id, createdAt: parsed.createdAt, runtimeVersion };
  } catch {
    return null;
  }
}
