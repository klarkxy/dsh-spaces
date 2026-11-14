import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { isGitSpec, isInstallableEntry, isSafeSpec, pluginAliases, pluginDisplayName } from "../../../../shared/plugin";
import { isExactRuntimeVersion } from "../../../../shared/runtime";
import { PROFILE_NAME_RE, type PackageSource, type PluginCatalogEntry, type PluginLibraryEntry } from "../../../../shared/types";
import type { SnapshotMeta } from "../../../../shared/snapshots";
import type { WorkbenchPlan, WorkbenchPlugin } from "../../../../shared/workbench";
import { atomicWrite } from "../../atomic";
import { assertNotRealHome } from "../../home/home-guard";
import { CATALOG_CACHE_FILE, lookupCatalogEntry, parseAnyCatalog, seedCatalog } from "../../products/plugin-catalog";
import {
  archiveAbsPath,
  archiveRelPath,
  isHubPluginArchive,
  lookupLibraryEntry,
  upsertLibraryEntry,
} from "../../products/plugin-library";
import {
  listAllProfilePlugins,
  listProfilePlugins,
  pluginAdd as defaultPluginAdd,
  pluginRemove as defaultPluginRemove,
  resolveInstallSpec,
  setSpacePlugin as defaultSetSpacePlugin,
} from "../../products/plugin-ops";
import { npmPackumentUrl } from "../../products/package-source";
import { ProcessTerminationError } from "../../runtime/terminate-process";
import { currentPackageSource } from "../../runtime/toolchain";
import { WORKBENCH_CONTROL_DIR_NAME, WorkbenchJobAbortError, WorkbenchJobError, sanitizeJobText, type WorkbenchJobContext } from "../workbench-jobs";
import type { WorkbenchMaintenancePorts } from "../workbench-maintenance-ports";
import {
  ISO_DATE_RE,
  PLAN_ID_RE,
  PLAN_SCHEMA,
  PROFILE_FILE_NAMES,
  REMOVED_DISK_COMMANDS,
  WORKBENCH_MAINTENANCE_ERROR,
  WORKBENCH_PLANS_DIR_NAME,
  WORKBENCH_PLUGIN_MUTATION_FILE,
  WORKBENCH_PLUGIN_MUTATION_FILES_DIR,
  WORKBENCH_PLUGIN_REGISTRY_FILE,
  type WorkbenchMaintenanceErrorCode,
} from "./constants";
import { WorkbenchMaintenanceError } from "./errors";
import {
  assertVersionInPackument,
  defaultFetcher,
  npmCatalogEntry,
  rewriteTarballUrl,
  writeAtomicBin,
} from "./npm-catalog";
import {
  listProfilePluginsSafe,
  publicPlugin,
  snapshotFingerprint,
  spacesUsing,
  versionFromSpec,
} from "./projections";
import type {
  MaintenanceFetcher,
  Packument,
  PlanStatus,
  PluginMutationExpected,
  PluginMutationJournal,
  PluginMutator,
  ResolvedCommand,
  StoredPlan,
  WorkbenchMaintenanceOptions,
} from "./types";
import { affectedFromCommand, isGuardedPackage, isNpmPackageId, isPlanStatus, rejectRawSpec, requirePackageName } from "./validation";
import { sortKeys, unique } from "./util";

/**
 * Shared state and cross-cutting helpers for the maintenance service.
 * Specialised parts extend this class; the public facade owns the last layer.
 */
export class MaintenanceCore {
  protected readonly now: () => Date;
  private readonly fetchImpl: MaintenanceFetcher;
  protected readonly pluginAddImpl: PluginMutator;
  protected readonly pluginRemoveImpl: PluginMutator;
  protected readonly setSpacePluginImpl: typeof defaultSetSpacePlugin;
  protected readonly admittedPlans = new Set<string>();
  private readonly source: () => PackageSource;
  private readonly logImpl?: (message: string, error?: unknown) => void;

  constructor(
    protected readonly ports: WorkbenchMaintenancePorts,
    options: WorkbenchMaintenanceOptions = {},
  ) {
    assertNotRealHome(ports.home);
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetch ?? defaultFetcher;
    this.pluginAddImpl = options.pluginAdd ?? defaultPluginAdd;
    this.pluginRemoveImpl = options.pluginRemove ?? defaultPluginRemove;
    this.setSpacePluginImpl = options.setSpacePlugin ?? defaultSetSpacePlugin;
    this.source = () => {
      const configured = options.packageSource;
      if (typeof configured === "function") return configured();
      return configured ?? currentPackageSource();
    };
    this.logImpl = options.log;
  }

  protected log(message: string, error?: unknown): void {
    this.logImpl?.(message, error);
  }

  protected fail(error: unknown, op: string, code: WorkbenchMaintenanceErrorCode = "workbench/failed"): never {
    if (error instanceof ProcessTerminationError) throw new WorkbenchJobError("workbench/failed");
    if (error instanceof WorkbenchJobError) throw error;
    if (error instanceof WorkbenchMaintenanceError || error instanceof WorkbenchJobAbortError) throw error;
    this.log(op, error);
    const cause = error instanceof Error ? sanitizeJobText(error.message).trim() : "";
    throw new WorkbenchMaintenanceError(code, cause || WORKBENCH_MAINTENANCE_ERROR[code]);
  }

  protected throwIfAborted(ctx: WorkbenchJobContext): void {
    if (ctx.signal.aborted) throw new WorkbenchJobAbortError();
  }

  protected async startRequired(spaceIds: string[]): Promise<void> {
    for (const spaceId of spaceIds) {
      await this.ports.startSpace(spaceId);
    }
  }

  protected owned(): string[] {
    return unique(this.ports.ownedSpaceIds());
  }

  protected runningOf(spaceIds: string[]): string[] {
    return spaceIds.filter((id) => {
      const status = this.ports.statusOf(id);
      return status === "running" || status === "starting";
    });
  }

  protected assertPluginTargetsReady(spaceIds: string[]): void {
    for (const id of spaceIds) {
      const status = this.ports.statusOf(id);
      if (status !== "running" && status !== "stopped" && status !== "crashed") {
        throw new WorkbenchMaintenanceError(
          "workbench/conflict",
          `The workspace ${id} is ${status}; wait for the transition to settle before changing plugins.`,
        );
      }
    }
  }

  protected targetSpace(spaceId: string, allowManager: boolean): string {
    if (typeof spaceId !== "string" || !PROFILE_NAME_RE.test(spaceId)) {
      throw new WorkbenchMaintenanceError("workbench/invalid-input");
    }
    const manager = this.ports.managerId();
    if (!allowManager && manager && spaceId === manager) {
      throw new WorkbenchMaintenanceError("workbench/forbidden");
    }
    try {
      this.ports.validateSpace(spaceId, allowManager);
    } catch (error) {
      this.log("validateSpace", error);
      if (!this.ports.ownedSpaceIds().includes(spaceId)) {
        throw new WorkbenchMaintenanceError("workbench/not-found");
      }
      throw new WorkbenchMaintenanceError("workbench/forbidden");
    }
    return spaceId;
  }

  protected currentVersionLabel(): string {
    try {
      const version = this.ports.currentRuntime().version;
      return isExactRuntimeVersion(version) ? version : "unknown";
    } catch {
      return "unknown";
    }
  }

  protected requireSnapshot(id: string): SnapshotMeta {
    try {
      return this.ports.snapshots.preview(id);
    } catch (error) {
      throw this.fail(error, "snapshots.preview", "workbench/not-found");
    }
  }

  protected storeable(
    id: string,
    createdAt: string,
    expiresAt: string,
    command: ResolvedCommand,
    plan: Omit<WorkbenchPlan, "id" | "serviceEpoch" | "stateRevision">,
  ): StoredPlan {
    const observed = this.ports.observation();
    const publicPlan: WorkbenchPlan = {
      id,
      ...plan,
      serviceEpoch: observed.serviceEpoch,
      stateRevision: observed.expectedRevision,
    };
    return {
      schemaVersion: PLAN_SCHEMA,
      id,
      public: publicPlan,
      command,
      fingerprint: this.fingerprintFor(command),
      createdAt,
      expiresAt,
      status: "previewed",
    };
  }

  private fingerprintFor(command: ResolvedCommand): string {
    const spaces = this.spaceFingerprint(affectedFromCommand(command));
    const payload = {
      command,
      managerId: this.ports.managerId(),
      spaces,
      runtime: this.currentVersionLabel(),
      snapshot: "snapshotId" in command ? snapshotFingerprint(this.requireSnapshot(command.snapshotId)) : null,
    };
    return createHash("sha256").update(JSON.stringify(sortKeys(payload))).digest("hex");
  }

  private spaceFingerprint(spaceIds: string[]): unknown {
    const ids = spaceIds.length ? spaceIds : this.owned();
    const metas = new Map(this.ports.registry.scan().map((row) => [row.name, row.meta]));
    return ids.map((id) => ({
      id,
      status: this.ports.statusOf(id),
      generation: this.ports.generationOf?.(id) ?? 0,
      dshVersion: metas.get(id)?.dshVersion ?? null,
      plugins: listProfilePluginsSafe(this.ports.home, id).map((item) => ({ name: item.name, version: item.version ?? null })),
    }));
  }

  protected writePlan(plan: StoredPlan): void {
    atomicWrite(this.planPath(plan.id), `${JSON.stringify(plan)}\n`);
  }

  protected readPlan(id: string): StoredPlan {
    if (typeof id !== "string" || !PLAN_ID_RE.test(id)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
    const path = this.planPath(id);
    if (!existsSync(path)) throw new WorkbenchMaintenanceError("workbench/not-found");
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredPlan;
      if (parsed.schemaVersion !== PLAN_SCHEMA || parsed.id !== id || !parsed.public || !parsed.command) {
        throw new WorkbenchMaintenanceError("workbench/invalid-input");
      }
      const commandKind = (parsed.command as { kind?: unknown }).kind;
      if (typeof commandKind === "string" && REMOVED_DISK_COMMANDS.has(commandKind)) {
        throw new WorkbenchMaintenanceError("workbench/unsupported");
      }
      if (!isPlanStatus(parsed.status)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
      if (typeof parsed.createdAt !== "string" || !ISO_DATE_RE.test(parsed.createdAt)) {
        throw new WorkbenchMaintenanceError("workbench/invalid-input");
      }
      if (typeof parsed.expiresAt !== "string" || !ISO_DATE_RE.test(parsed.expiresAt)) {
        throw new WorkbenchMaintenanceError("workbench/invalid-input");
      }
      return parsed;
    } catch (error) {
      if (error instanceof WorkbenchMaintenanceError) throw error;
      throw this.fail(error, "readPlan", "workbench/invalid-input");
    }
  }

  protected assertPlanIdentity(plan: StoredPlan): void {
    const observed = this.ports.observation();
    if (!plan.public.serviceEpoch || !plan.public.stateRevision) {
      throw new WorkbenchMaintenanceError("workbench/unsupported");
    }
    if (plan.public.serviceEpoch !== observed.serviceEpoch) {
      throw new WorkbenchMaintenanceError("workbench/stale");
    }
    if (plan.public.scope !== "space" && plan.public.stateRevision !== observed.expectedRevision) {
      throw new WorkbenchMaintenanceError("workbench/stale");
    }
  }

  protected assertFresh(plan: StoredPlan): void {
    if (typeof plan.expiresAt !== "string" || !ISO_DATE_RE.test(plan.expiresAt)) {
      throw new WorkbenchMaintenanceError("workbench/invalid-input");
    }
    const expires = Date.parse(plan.expiresAt);
    if (!Number.isFinite(expires)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
    if (expires <= this.now().getTime()) throw new WorkbenchMaintenanceError("workbench/expired");
  }

  protected markPlan(plan: StoredPlan, status: PlanStatus): void {
    plan.status = status;
    const ts = this.now().toISOString();
    if (status === "running") plan.startedAt = ts;
    if (status === "succeeded" || status === "failed" || status === "cancelled") plan.finishedAt = ts;
    try { this.writePlan(plan); }
    catch (error) {
      this.log("plan settlement persistence", error);
      throw new WorkbenchJobError("workbench/persist-failed");
    }
  }

  private planPath(id: string): string {
    return join(this.ports.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLANS_DIR_NAME, `${id}.json`);
  }

  private registryPath(): string {
    return join(this.ports.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_REGISTRY_FILE);
  }

  protected async resolveNpmCatalog(catalogId: string, version: string, register: boolean): Promise<PluginCatalogEntry> {
    rejectRawSpec(catalogId);
    let entry = this.findCatalog(catalogId);
    if (!entry && isNpmPackageId(catalogId)) {
      const packument = await this.fetchPackument(catalogId);
      const name = typeof packument.name === "string" && packument.name ? packument.name : catalogId;
      assertVersionInPackument(packument, version);
      entry = npmCatalogEntry(name);
      if (register) this.registerCatalogEntry(entry);
    }
    if (!entry) throw new WorkbenchMaintenanceError("workbench/not-found");
    if (entry.installMethod !== "npm" || isGitSpec(entry.installSpec ?? "") || !isInstallableEntry(entry)) {
      throw new WorkbenchMaintenanceError("workbench/forbidden");
    }
    const packageName = requirePackageName(entry);
    if (!isSafeSpec(packageName) || isGitSpec(packageName)) {
      throw new WorkbenchMaintenanceError("workbench/invalid-input");
    }
    if (lookupCatalogEntry(this.ports.home, entry.id)) {
      try {
        await resolveInstallSpec(this.ports.home, { catalogId: entry.id });
      } catch (error) {
        throw this.fail(error, "resolveInstallSpec");
      }
    }
    const packument = await this.fetchPackument(packageName);
    assertVersionInPackument(packument, version);
    return entry;
  }

  protected async ensureExactNpmLibrary(catalogId: string, packageName: string, version: string): Promise<string> {
    const id = `${packageName}@${version}`.toLowerCase();
    const existing = lookupLibraryEntry(this.ports.home, id) ?? lookupLibraryEntry(this.ports.home, packageName);
    if (existing?.tarball && existing.spec === `${packageName}@${version}`) {
      const abs = resolve(this.ports.home, existing.tarball);
      if (isHubPluginArchive(this.ports.home, abs)) return abs;
    }
    const packument = await this.fetchPackument(packageName);
    const tarball = packument.versions?.[version]?.dist?.tarball;
    if (!tarball || !/^https:\/\//i.test(tarball)) {
      throw new WorkbenchMaintenanceError("workbench/not-found");
    }
    const dest = archiveAbsPath(this.ports.home, id);
    const packed = await this.fetchImpl(rewriteTarballUrl(tarball, this.source()));
    if (!packed.ok) throw new WorkbenchMaintenanceError("workbench/failed");
    const bytes = Buffer.from(await packed.arrayBuffer());
    if (bytes.length === 0) throw new WorkbenchMaintenanceError("workbench/failed");
    writeAtomicBin(dest, bytes);
    const entry: PluginLibraryEntry = {
      id,
      spec: `${packageName}@${version}`,
      packageName,
      title: packageName,
      catalogId,
      tarball: archiveRelPath(id),
      source: "catalog",
      downloadedAt: this.now().toISOString(),
    };
    upsertLibraryEntry(this.ports.home, entry);
    return dest;
  }

  protected async lookupNpmPackage(name: string): Promise<WorkbenchPlugin | undefined> {
    try {
      const packument = await this.fetchPackument(name);
      const packageName = typeof packument.name === "string" && packument.name ? packument.name : name;
      const description =
        (typeof packument.description === "string" && packument.description) ||
        "";
      return publicPlugin({
        id: packageName,
        title: packageName,
        packageName,
        description,
        version: null,
        installedIn: [],
        protected: isGuardedPackage(packageName),
      });
    } catch (error) {
      this.log("npm lookup", error);
      return undefined;
    }
  }

  private async fetchPackument(name: string): Promise<Packument> {
    const url = npmPackumentUrl(this.source(), name);
    const response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new WorkbenchMaintenanceError("workbench/not-found");
    const json = await response.json();
    if (!json || typeof json !== "object") throw new WorkbenchMaintenanceError("workbench/failed");
    return json as Packument;
  }

  protected catalogEntries(): PluginCatalogEntry[] {
    const unique = new Map<string, PluginCatalogEntry>();
    for (const entry of seedCatalog().entries) unique.set(entry.id, entry);
    for (const entry of this.readJsonCatalog(join(this.ports.home, "hub", CATALOG_CACHE_FILE))) {
      unique.set(entry.id, entry);
    }
    for (const entry of this.registeredCatalog()) unique.set(entry.id, entry);
    return [...unique.values()];
  }

  private registeredCatalog(): PluginCatalogEntry[] {
    return this.readJsonCatalog(this.registryPath());
  }

  private findCatalog(id: string): PluginCatalogEntry | undefined {
    const key = id.trim().toLowerCase();
    const registered = this.registeredCatalog();
    const hit =
      registered.find((entry) => entry.id === key || entry.packageName?.toLowerCase() === key) ??
      lookupCatalogEntry(this.ports.home, id) ??
      this.catalogEntries().find((entry) => entry.id === key || entry.packageName?.toLowerCase() === key);
    return hit;
  }

  private registerCatalogEntry(entry: PluginCatalogEntry): void {
    const current = this.registeredCatalog().filter((item) => item.id !== entry.id);
    current.push(entry);
    atomicWrite(
      this.registryPath(),
      `${JSON.stringify({ meta: { schemaVersion: 1, generatedAt: this.now().toISOString(), count: current.length, contentHash: "workbench-registry" }, entries: current }, null, 2)}\n`,
    );
  }

  private readJsonCatalog(path: string): PluginCatalogEntry[] {
    if (!existsSync(path)) return [];
    try {
      return parseAnyCatalog(JSON.parse(readFileSync(path, "utf8"))).entries;
    } catch (error) {
      this.log(`catalog ${path}`, error);
      return [];
    }
  }

  protected pluginFromCatalog(entry: PluginCatalogEntry, installed: Record<string, ReturnType<typeof listProfilePlugins>>): WorkbenchPlugin {
    const packageName = entry.packageName || entry.installSpec || entry.id;
    return {
      id: entry.id,
      title: pluginDisplayName(entry),
      packageName,
      description: entry.summaryEn || entry.summary || entry.description,
      version: null,
      installedIn: spacesUsing(installed, packageName, entry.installSpec),
      protected: isGuardedPackage(packageName),
    };
  }

  protected pluginFromLibrary(entry: PluginLibraryEntry, installed: Record<string, ReturnType<typeof listProfilePlugins>>): WorkbenchPlugin {
    return {
      id: entry.id,
      title: entry.title || entry.packageName,
      packageName: entry.packageName,
      description: "",
      version: versionFromSpec(entry.spec),
      installedIn: spacesUsing(installed, entry.packageName, entry.spec),
      protected: isGuardedPackage(entry.packageName),
    };
  }

  protected installedBySpace(): Record<string, ReturnType<typeof listProfilePlugins>> {
    return listAllProfilePlugins(this.ports.home, this.owned());
  }

  protected resolveTogglePackage(spaceId: string, pluginId: string, enabled: boolean): string {
    rejectRawSpec(pluginId);
    const library = lookupLibraryEntry(this.ports.home, pluginId);
    if (library) return library.packageName;
    const catalog = this.findCatalog(pluginId);
    if (catalog?.packageName) return catalog.packageName;
    const installed = listProfilePlugins(this.ports.home, spaceId).find(
      (item) => item.name === pluginId || item.name.toLowerCase() === pluginId.toLowerCase(),
    );
    if (installed) return installed.name;
    if (!enabled) return pluginId;
    throw new WorkbenchMaintenanceError("workbench/not-found");
  }

  protected resolveToggleLiveSpec(pluginId: string, packageName: string): string {
    const library = lookupLibraryEntry(this.ports.home, pluginId) ?? lookupLibraryEntry(this.ports.home, packageName);
    if (library) {
      if (library.tarball) {
        const abs = resolve(this.ports.home, library.tarball);
        if (isHubPluginArchive(this.ports.home, abs)) return abs;
      }
      return library.spec;
    }
    const installed = this.installedBySpace();
    for (const list of Object.values(installed)) {
      const hit = list.find((item) => item.name === packageName && item.version && isExactRuntimeVersion(item.version));
      if (hit?.version) return `${packageName}@${hit.version}`;
    }
    const catalog = this.findCatalog(pluginId);
    if (catalog?.installSpec) return catalog.installSpec;
    return packageName;
  }

  protected spaceHasPlugin(spaceId: string, packageName: string): boolean {
    return listProfilePlugins(this.ports.home, spaceId).some(
      (item) => item.name === packageName || pluginAliases({ spec: packageName, packageName }).includes(item.name),
    );
  }

  protected writePluginMutation(planId: string, spaceIds: string[], expected: PluginMutationExpected[]): void {
    if (this.readPluginMutation().status !== "none") {
      throw new WorkbenchMaintenanceError("workbench/conflict");
    }
    const filesRoot = this.pluginMutationFilesDir();
    for (const spaceId of spaceIds) this.copyProfileEvidence(spaceId, join(filesRoot, spaceId));
    const journal: PluginMutationJournal = {
      schemaVersion: 1,
      phase: "prepared",
      planId,
      spaceIds,
      expected,
      startedAt: this.now().toISOString(),
    };
    atomicWrite(this.pluginMutationPath(), `${JSON.stringify(journal, null, 2)}\n`);
  }

  protected failPluginMutation(): void {
    const path = this.pluginMutationPath();
    if (!existsSync(path)) return;
    try {
      const journal = JSON.parse(readFileSync(path, "utf8")) as PluginMutationJournal;
      journal.phase = "failed";
      atomicWrite(path, `${JSON.stringify(journal, null, 2)}\n`);
    } catch (error) {
      this.log("failPluginMutation", error);
    }
  }

  protected clearPluginMutation(): void {
    const path = this.pluginMutationPath();
    if (existsSync(path)) rmSync(path, { force: true });
    const files = this.pluginMutationFilesDir();
    if (existsSync(files)) rmSync(files, { recursive: true, force: true });
  }

  private readPluginMutation(): { status: "none" | "open" | "unreadable"; planId?: string } {
    const path = this.pluginMutationPath();
    if (!existsSync(path)) return { status: "none" };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as PluginMutationJournal;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.spaceIds)) return { status: "unreadable" };
      if (parsed.phase === "prepared" || parsed.phase === "mutating" || parsed.phase === "failed") {
        return {
          status: "open",
          planId: typeof parsed.planId === "string" && parsed.planId.trim() ? parsed.planId : undefined,
        };
      }
      return { status: "unreadable" };
    } catch {
      return { status: "unreadable" };
    }
  }

  protected pluginTargetsUnchanged(spaceIds: string[]): boolean {
    const root = this.pluginMutationFilesDir();
    for (const spaceId of spaceIds) {
      const liveDir = join(this.ports.home, "profiles", spaceId);
      const evidenceDir = join(root, spaceId);
      for (const name of PROFILE_FILE_NAMES) {
        const live = join(liveDir, name);
        const evidence = join(evidenceDir, name);
        const liveExists = existsSync(live);
        const evidenceExists = existsSync(evidence);
        if (liveExists !== evidenceExists) return false;
        if (liveExists && readFileSync(live, "utf8") !== readFileSync(evidence, "utf8")) return false;
      }
    }
    return true;
  }

  private copyProfileEvidence(spaceId: string, destDir: string): void {
    const srcDir = join(this.ports.home, "profiles", spaceId);
    mkdirSync(destDir, { recursive: true });
    for (const name of PROFILE_FILE_NAMES) {
      const src = join(srcDir, name);
      if (!existsSync(src)) continue;
      copyFileSync(src, join(destDir, name));
    }
  }

  private pluginMutationPath(): string {
    return join(this.ports.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_MUTATION_FILE);
  }

  private pluginMutationFilesDir(): string {
    return join(this.ports.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_MUTATION_FILES_DIR);
  }
}
