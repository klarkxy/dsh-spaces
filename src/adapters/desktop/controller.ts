import { existsSync, readFileSync } from "node:fs";
import {
  HomeControlBusyError,
  HomeControlPathError,
  HomeController,
  type HomeControlHandle,
  type HomeControlInspect,
  type PidAliveFn,
} from "../node/home-controller";
import { catalogCachePath, lookupCatalogEntry, parseAnyCatalog, seedCatalog } from "../../main/plugin-catalog";
import { isHubPluginArchive, lookupLibraryEntry, readPluginLibrary } from "../../main/plugin-library";
import { matchesPluginQuery } from "../../shared/plugin";
import type { PluginCatalogEntry, PluginCatalogSnapshot, PluginLibraryEntry } from "../../shared/types";
import {
  type DesktopControllerKind,
  type DesktopControllerState,
  type DesktopReleaseSpace,
  FULL_SPACES_PACKAGE,
  isDesktopWriteIpcChannel,
  isFullSpacesManagerSpec,
  isUnresolvedPluginAlias,
} from "../../shared/desktop-controller";
import { inspectControlResidue, inspectHomeToolchain, type HomeToolchainInspect } from "./control-residue";
import type { DesktopHomeControl } from "./home-control";

export class DesktopReadOnlyError extends Error {
  readonly name = "DesktopReadOnlyError";
  constructor(
    message: string,
    readonly state: DesktopControllerState,
  ) {
    super(message);
  }
}

export class DesktopTransferError extends Error {
  readonly name = "DesktopTransferError";
}

export interface DesktopControllerOptions {
  homeControl: DesktopHomeControl;
  controller?: HomeController;
  pidAlive?: PidAliveFn;
  allowRealHome?: boolean;
  stopOwned?: () => Promise<void>;
  drainPlugins?: () => Promise<void>;
  clearViews?: () => void;
  profileNames?: () => string[];
  ownedSpaces?: () => DesktopReleaseSpace[];
  ownsInstanceRecord?: (record: Record<string, unknown>) => boolean;
  onAdmit?: () => void | Promise<void>;
  onState?: (state: DesktopControllerState) => void;
}

/**
 * Exclusive Home write gate for the desktop app.
 * Runtime ownership is HomeController.acquire("desktop"); the app single-instance
 * lock is not a substitute. Transaction/maintenance work stays on homeControl.
 */
export class DesktopController {
  readonly home: string;
  readonly homeControl: DesktopHomeControl;
  readonly controller: HomeController;
  private handle: HomeControlHandle | undefined;
  private accepting = true;
  private transferPending = false;
  private admitted = false;
  private extraReasons: string[] = [];
  private managerProfileId: string | null = null;
  private readonly stopOwned: () => Promise<void>;
  private readonly drainPlugins: () => Promise<void>;
  private readonly clearViews: () => void;
  private readonly profileNames: () => string[];
  private readonly ownedSpaces: () => DesktopReleaseSpace[];
  private readonly ownsInstanceRecord?: DesktopControllerOptions["ownsInstanceRecord"];
  private readonly onAdmit?: () => void | Promise<void>;
  private readonly onState?: (state: DesktopControllerState) => void;

  constructor(home: string, options: DesktopControllerOptions) {
    this.homeControl = options.homeControl;
    this.controller =
      options.controller ??
      new HomeController(home, {
        pidAlive: options.pidAlive,
        allowRealHome: options.allowRealHome,
      });
    this.home = this.controller.home;
    this.stopOwned = options.stopOwned ?? (async () => undefined);
    this.drainPlugins = options.drainPlugins ?? (async () => undefined);
    this.clearViews = options.clearViews ?? (() => undefined);
    this.profileNames = options.profileNames ?? (() => []);
    this.ownedSpaces = options.ownedSpaces ?? (() => []);
    this.ownsInstanceRecord = options.ownsInstanceRecord;
    this.onAdmit = options.onAdmit;
    this.onState = options.onState;
  }

  get writable(): boolean {
    return this.canOrdinaryWrite();
  }

  get held(): boolean {
    return Boolean(this.handle);
  }

  state(): DesktopControllerState {
    const blocking = this.refreshBlockingReasons();
    return publicState(this.controller.inspect(), this.handle, this.transferPending, this.admitted, blocking);
  }

  /** Startup attempt only. Never reclaimDead, never admit writes. */
  acquireOnStart(): DesktopControllerState {
    if (this.handle) return this.emit();
    const existing = this.controller.inspect();
    if (existing.held) return this.emit();
    try {
      this.handle = this.controller.acquire("desktop");
      this.accepting = true;
      this.transferPending = false;
      this.admitted = false;
    } catch (error) {
      if (!(error instanceof HomeControlBusyError)) throw error;
    }
    return this.emit();
  }

  /**
   * User-explicit takeover. Dead, live, and ambiguous owners are all refused.
   * The ownership record is left in place. Writes stay sealed until admitWrites.
   */
  acquireExplicit(): DesktopControllerState {
    if (this.handle) return this.emit();
    const existing = this.controller.inspect();
    if (existing.held) {
      throw new DesktopReadOnlyError(acquireRefusal(existing), this.state());
    }
    try {
      this.handle = this.controller.acquire("desktop");
      this.accepting = true;
      this.transferPending = false;
      this.admitted = false;
      this.extraReasons = [];
    } catch (error) {
      if (error instanceof HomeControlBusyError) {
        throw new DesktopReadOnlyError(acquireRefusal(error.inspection), this.state());
      }
      throw error;
    }
    return this.emit();
  }

  /** ROOT and startup entry: identity + leftover work, then maybe admit. */
  async hydrateManager(): Promise<DesktopControllerState> {
    return this.admitWrites();
  }

  async admitWrites(): Promise<DesktopControllerState> {
    if (!this.handle) return this.emit();
    this.admitted = false;
    const blocking = this.refreshBlockingReasons();
    if (blocking.length > 0) return this.emit();

    const identity = this.inspectManagerIdentity();
    if (identity === "damaged") return this.emit();
    if (identity !== "skip-create") {
      try {
        const ensured = await this.controller.ensureManager();
        this.managerProfileId = this.verifiedManagerId(ensured.profileId);
      } catch (error) {
        if (error instanceof HomeControlPathError) {
          this.managerProfileId = null;
          this.extraReasons = uniqueReasons(this.extraReasons, [
            "Manager identity is damaged or ambiguous and was not rebuilt.",
          ]);
          return this.emit();
        }
        throw error;
      }
    }

    const afterIdentity = this.refreshBlockingReasons();
    if (afterIdentity.length > 0) return this.emit();

    const toolchain = inspectHomeToolchain(this.home);
    if (toolchain.kind === "invalid") {
      this.extraReasons = uniqueReasons(this.extraReasons, [toolchain.reason]);
      return this.emit();
    }

    if (this.onAdmit) {
      try {
        await this.onAdmit();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.extraReasons = uniqueReasons(this.extraReasons, [
          `Home settings or runtime could not be verified: ${detail}`,
        ]);
        return this.emit();
      }
    }

    if (this.refreshBlockingReasons().length > 0) return this.emit();
    this.admitted = true;
    return this.emit();
  }

  revokeAdmission(reason: string): DesktopControllerState {
    this.admitted = false;
    this.extraReasons = uniqueReasons(this.extraReasons, [reason]);
    return this.emit();
  }

  homeToolchain(): HomeToolchainInspect {
    return inspectHomeToolchain(this.home);
  }

  releasePreview(): DesktopReleaseSpace[] {
    return this.ownedSpaces();
  }

  /**
   * Block new work, wait for maintenance + plugin queue, stop this desktop's
   * instances, clear our views, then release the lease. A stop failure keeps
   * the lease. Allowed while leftover evidence blocks ordinary writes so the
   * lease is not stuck forever.
   */
  async release(): Promise<DesktopControllerState> {
    if (!this.handle) return this.emit();
    const wasAdmitted = this.admitted;
    this.accepting = false;
    this.admitted = false;
    this.transferPending = true;
    this.emit();
    try {
      await this.homeControl.maintenance.idle();
      await this.drainPlugins();
      await this.stopOwned();
      this.clearViews();
      this.handle.release();
      this.handle = undefined;
      this.managerProfileId = null;
      this.transferPending = false;
      this.accepting = true;
      this.extraReasons = [];
      return this.emit();
    } catch (error) {
      this.accepting = true;
      this.admitted = wasAdmitted;
      this.transferPending = false;
      this.emit();
      const detail = error instanceof Error ? error.message : String(error);
      throw new DesktopTransferError(`Control transfer failed; lease kept: ${detail}`);
    }
  }

  assertWritable(channel?: string): void {
    const blocking = this.refreshBlockingReasons();
    const state = publicState(
      this.controller.inspect(),
      this.handle,
      this.transferPending,
      this.admitted,
      blocking,
    );
    if (this.canOrdinaryWrite()) return;
    const suffix = channel ? ` (${channel})` : "";
    if (this.handle && this.transferPending) {
      throw new DesktopTransferError(`Control transfer is in progress${suffix}.`);
    }
    if (this.handle) {
      throw new DesktopReadOnlyError(
        `Holding Home control. Fault or leftover evidence was reported${suffix}. ${state.reasons[0] ?? "Writes are blocked."}`,
        state,
      );
    }
    throw new DesktopReadOnlyError(
      `Home is read-only${suffix}. ${state.reasons[0] ?? "Another controller holds this Home."}`,
      state,
    );
  }

  mutate<T>(action: () => T | Promise<T>): Promise<T> {
    this.assertWritable();
    return this.homeControl.mutate(action);
  }

  runMaintenance<T>(label: string, action: () => Promise<T>): Promise<T> {
    this.assertWritable();
    return this.homeControl.runMaintenance(label, action);
  }

  managerId(): string | null {
    const blocking = this.refreshBlockingReasons();
    if (blocking.some((row) => row.includes("Manager identity"))) return null;
    if (this.managerProfileId) return this.verifiedManagerId(this.managerProfileId);
    try {
      for (const name of this.profileNames()) {
        if (this.controller.roleOf(name) === "manager") {
          this.managerProfileId = name;
          return name;
        }
      }
    } catch (error) {
      if (error instanceof HomeControlPathError) return null;
      throw error;
    }
    return this.managerProfileId;
  }

  assertMutableProfile(name: string, action: "delete" | "rename" | "create"): void {
    if (this.isManagerProfile(name)) {
      throw new Error(`The manager profile cannot be ${action}d from the desktop workspace path.`);
    }
  }

  assertDesktopPluginMutation(profiles: string[], raw: string): void {
    const identity = this.resolvePluginIdentity(raw);
    const uniqueProfiles = [...new Set(profiles)];
    for (const profile of uniqueProfiles) {
      if (this.isManagerProfile(profile)) {
        throw new Error("Manager plugins can only be changed through the supervisor maintenance path.");
      }
    }
    if (isFullSpacesPackage(identity.packageName) || isFullSpacesManagerSpec(identity.spec)) {
      throw new Error(
        `The full Spaces manager (${FULL_SPACES_PACKAGE}) cannot be installed into a workspace.`,
      );
    }
  }

  assertOrdinaryPluginSpec(spec: string): void {
    const identity = this.resolvePluginIdentity(spec);
    if (isFullSpacesPackage(identity.packageName) || isFullSpacesManagerSpec(identity.spec)) {
      throw new Error(
        `The full Spaces manager (${FULL_SPACES_PACKAGE}) cannot be copied onto the ordinary desktop plugin path.`,
      );
    }
  }

  resolvePluginIdentity(raw: string): { spec: string; packageName: string } {
    const trimmed = raw.trim();
    const library = lookupLibraryEntry(this.home, trimmed);
    if (library?.packageName) {
      return { spec: library.spec, packageName: library.packageName };
    }
    const catalog = lookupCatalogEntry(this.home, trimmed);
    if (catalog?.packageName) {
      return { spec: catalog.installSpec || trimmed, packageName: catalog.packageName };
    }
    if (isHubPluginArchive(this.home, trimmed) || looksLikeTarball(trimmed)) {
      throw new Error("A local plugin tarball must resolve through library metadata to a package name.");
    }
    if (isUnresolvedPluginAlias(trimmed)) {
      throw new Error("Plugin aliases must resolve through library or catalog metadata.");
    }
    if (isFullSpacesManagerSpec(trimmed)) {
      return { spec: trimmed, packageName: FULL_SPACES_PACKAGE };
    }
    return { spec: trimmed, packageName: trimmed };
  }

  readPluginCatalog(url: string): PluginCatalogSnapshot {
    const cached = readExistingCatalog(this.home);
    if (cached) return { ...cached, source: "cache", url };
    return { ...seedCatalog(), source: "seed", url };
  }

  searchPluginCatalog(query: string): PluginCatalogEntry[] {
    const catalog = this.readPluginCatalog("");
    return catalog.entries.filter((entry) => matchesPluginQuery(entry, query));
  }

  readPluginLibrary(): PluginLibraryEntry[] {
    return readPluginLibrary(this.home);
  }

  private canOrdinaryWrite(): boolean {
    if (!this.handle || !this.accepting || this.transferPending || !this.admitted) return false;
    return this.refreshBlockingReasons().length === 0;
  }

  private refreshBlockingReasons(): string[] {
    const live: string[] = [];
    const identity = this.inspectManagerIdentity();
    if (identity === "damaged") {
      this.managerProfileId = null;
      live.push("Manager identity is damaged or ambiguous and was not rebuilt.");
    } else if (this.managerProfileId && this.verifiedManagerId(this.managerProfileId) !== this.managerProfileId) {
      this.managerProfileId = null;
      live.push("Manager identity no longer matches the recorded profile and was not rebuilt.");
    }
    live.push(...inspectControlResidue(this.home, this.handle ? this.ownsInstanceRecord : undefined));
    const toolchain = inspectHomeToolchain(this.home);
    if (toolchain.kind === "invalid") live.push(toolchain.reason);
    return uniqueReasons(this.extraReasons, live);
  }

  private inspectManagerIdentity(): "ok" | "damaged" | "skip-create" {
    try {
      this.controller.roleOf("web");
    } catch (error) {
      if (error instanceof HomeControlPathError) return "damaged";
      throw error;
    }
    if (inspectControlResidue(this.home, this.handle ? this.ownsInstanceRecord : undefined).length > 0) return "skip-create";
    return "ok";
  }

  private verifiedManagerId(candidate: string): string | null {
    try {
      return this.controller.roleOf(candidate) === "manager" ? candidate : null;
    } catch (error) {
      if (error instanceof HomeControlPathError) return null;
      throw error;
    }
  }

  private isManagerProfile(name: string): boolean {
    try {
      return this.controller.roleOf(name) === "manager";
    } catch (error) {
      if (error instanceof HomeControlPathError) {
        throw new DesktopReadOnlyError(
          "Holding Home control. Fault or leftover evidence was reported. Manager identity is damaged or ambiguous and was not rebuilt.",
          this.state(),
        );
      }
      throw error;
    }
  }

  private emit(): DesktopControllerState {
    const state = this.state();
    this.onState?.(state);
    return state;
  }
}

export function createDesktopController(home: string, options: DesktopControllerOptions): DesktopController {
  return new DesktopController(home, options);
}

export function guardDesktopWriteIpc(controller: DesktopController, channel: string): void {
  if (isDesktopWriteIpcChannel(channel)) controller.assertWritable(channel);
}

export function isRefreshWrite(channel: string, refresh?: boolean): boolean {
  return channel === "getPluginCatalog" && refresh === true;
}

function publicState(
  inspection: HomeControlInspect,
  handle: HomeControlHandle | undefined,
  transferPending: boolean,
  admitted: boolean,
  blocking: string[],
): DesktopControllerState {
  if (handle) {
    const recoveryRequired = blocking.length > 0;
    const writable = !transferPending && admitted && !recoveryRequired;
    const reasons = uniqueReasons(
      blocking,
      transferPending ? ["Handing off Home control. New writes are blocked."] : [],
      recoveryRequired && !transferPending
        ? ["Holding Home control. Fault or leftover evidence was reported; writes are blocked."]
        : [],
    );
    return {
      ownerKind: "desktop",
      held: true,
      writable,
      recoveryRequired,
      reasons,
      transferPending,
    };
  }

  if (!inspection.held) {
    return {
      ownerKind: null,
      held: false,
      writable: false,
      recoveryRequired: blocking.length > 0,
      reasons: uniqueReasons(blocking, ["No controller holds this Home. Take over to make changes."]),
      transferPending: false,
    };
  }

  if ("reclaim" in inspection && inspection.reclaim) {
    return recoveryState(null, "A reclaim is already in progress.", blocking);
  }
  if ("incomplete" in inspection && inspection.incomplete) {
    return recoveryState(null, "Control ownership is incomplete and cannot be taken.", blocking);
  }
  if ("ambiguous" in inspection && inspection.ambiguous) {
    return recoveryState(null, "Control ownership is ambiguous and cannot be taken.", blocking);
  }
  if ("owner" in inspection) {
    const ownerKind = inspection.owner.kind;
    if (inspection.liveness === "alive") {
      return {
        ownerKind,
        held: false,
        writable: false,
        recoveryRequired: false,
        reasons: uniqueReasons(blocking, [heldReason(ownerKind)]),
        transferPending: false,
      };
    }
    if (inspection.liveness === "dead") {
      return recoveryState(
        ownerKind,
        "The previous owner is dead. The ownership record was left in place and was not taken.",
        blocking,
      );
    }
    return recoveryState(ownerKind, "Owner process liveness is ambiguous and cannot be taken.", blocking);
  }
  return recoveryState(null, "Control ownership cannot be taken.", blocking);
}

function recoveryState(
  ownerKind: DesktopControllerKind | null,
  reason: string,
  extraReasons: string[],
): DesktopControllerState {
  return {
    ownerKind,
    held: false,
    writable: false,
    recoveryRequired: true,
    reasons: uniqueReasons(extraReasons, [reason]),
    transferPending: false,
  };
}

function heldReason(kind: DesktopControllerKind): string {
  return kind === "web"
    ? "The web workbench holds this Home."
    : "Another desktop instance holds this Home.";
}

function acquireRefusal(inspection: HomeControlInspect): string {
  if (!inspection.held) return "Home control could not be acquired.";
  if ("reclaim" in inspection && inspection.reclaim) {
    return "A leftover reclaim record is present. The ownership record was left in place and was not taken.";
  }
  if ("incomplete" in inspection && inspection.incomplete) {
    return "Control ownership is incomplete and cannot be taken.";
  }
  if ("ambiguous" in inspection && inspection.ambiguous) {
    return "Control ownership is ambiguous and cannot be taken.";
  }
  if ("owner" in inspection) {
    if (inspection.liveness === "alive") return heldReason(inspection.owner.kind);
    if (inspection.liveness === "dead") {
      return "The previous owner is dead. The ownership record was left in place and was not taken.";
    }
    return "Owner process liveness is ambiguous and cannot be taken.";
  }
  return "Home control could not be acquired.";
}

function uniqueReasons(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const reason of group) {
      if (!reason || seen.has(reason)) continue;
      seen.add(reason);
      out.push(reason);
    }
  }
  return out;
}

function isFullSpacesPackage(packageName: string): boolean {
  return packageName.trim().toLowerCase() === FULL_SPACES_PACKAGE;
}

function looksLikeTarball(spec: string): boolean {
  const value = spec.trim().toLowerCase();
  return value.endsWith(".tgz") || value.endsWith(".tar.gz");
}

function readExistingCatalog(home: string): { meta: PluginCatalogSnapshot["meta"]; entries: PluginCatalogEntry[] } | undefined {
  const path = catalogCachePath(home);
  if (!existsSync(path)) return undefined;
  try {
    return parseAnyCatalog(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}
