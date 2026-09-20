import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicWrite } from "./atomic";
import { assertNotRealHome, samePath } from "./home-guard";
import { archiveAbsPath, isHubPluginArchive } from "./plugin-library";
import {
  downloadPlugin as defaultDownloadPlugin,
  parseNpmNameAndVersion,
  pluginAdd as defaultPluginAdd,
  type PluginFetcher,
} from "./plugin-ops";
import { readLibraryOrThrow } from "./workbench-products";
import { ProcessTerminationError } from "./terminate-process";
import type { CoordinatedUpgrade } from "./coordinated-upgrade";
import type { SnapshotExecutor } from "./snapshot-executor";
import { SNAPSHOT_ID_RE, type SnapshotRuntime } from "../../shared/snapshots";
import { PROFILE_NAME_RE } from "../../shared/types";
import { isExactRuntimeVersion } from "../../shared/runtime";
import type { WorkbenchPackageRelease } from "../../shared/workbench";
import {
  COMPONENT_PAYLOAD_ENTRIES,
  COMPONENT_PAYLOAD_MANIFEST_REL,
  COMPONENT_PAYLOAD_NAMES,
  COMPONENT_PAYLOAD_REQUIRED_FILES,
  parseComponentPayloadManifest,
  validateComponentPayload,
  type ComponentPayloadName,
  type ValidatedComponentPayload,
} from "./component-payload";
import { stageComponentPayload } from "./component-selection";
import {
  packLocalArtifacts,
  type PackOneRequest,
} from "../../../packages/plugin/src/host/supervisor-pack.ts";
import {
  WORKBENCH_CONTROL_DIR_NAME,
  WorkbenchJobAbortError,
  type WorkbenchJobContext,
} from "./workbench-jobs";

export const WORKBENCH_PACKAGE_CATALOG_ID = "bundled-workbench" as const;
export const WORKBENCH_UPGRADE_MARKER_FILE = "workbench-upgrade.json";
export const WORKBENCH_UPGRADE_RECEIPTS_DIR = "workbench-upgrade-receipts";
export const WORKBENCH_UPGRADE_SNAPSHOT_REASON = "workbench-upgrade";
export const SPACES_PLUGIN_PACKAGE = "@dsh-spaces/plugin";
export const VIEW_BRIDGE_PACKAGE = "@dsh-spaces/view-bridge";
export const LLM_BRIDGE_PACKAGE = "@dsh-spaces/llm-bridge";

const SCHEMA_VERSION = 1;
const MARKER_KIND = "workbench.upgrade";
const DIGEST_ID_LENGTH = 32;
const TAR_TIMEOUT_MS = 15_000;
const MAX_TAR_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_TAR_LIST_BYTES = 256 * 1024;
const PLUGIN_ARCHIVE_PREFIX = "dsh-spaces-plugin";
const VIEW_BRIDGE_ARCHIVE_PREFIX = "dsh-spaces-view-bridge";
const VIEW_BRIDGE_FILES = ["package.json", "lib/index.js", "lib/client.js"] as const;
const LLM_BRIDGE_FILES = ["package.json", "lib/index.js"] as const;
const LLM_BRIDGE_ARCHIVE_PREFIX = "dsh-spaces-llm-bridge";
const PREPARE_SCRATCH_DIR = "workbench-prepare";
const IDENTITY_JSON: Record<ComponentPayloadName, string> = {
  supervisor: "lib/supervisor/package.json",
  "manager-plugin": "package.json",
  "view-bridge": "lib/view-bridge/package.json",
  "llm-bridge": "lib/llm-bridge/package.json",
  "installation-worker": "lib/supervisor/package.json",
};

export type WorkbenchPackageUpgradeErrorCode =
  | "invalid-input"
  | "conflict"
  | "unavailable"
  | "failed";

export class WorkbenchPackageUpgradeError extends Error {
  readonly name = "WorkbenchPackageUpgradeError";
  constructor(
    readonly code: WorkbenchPackageUpgradeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type WorkbenchPackageOutcome = "succeeded" | "rolled-back" | "abandoned";

export interface WorkbenchPackageRecovery {
  planId: string;
  rolledBack: boolean;
  outcome: WorkbenchPackageOutcome;
  snapshotId?: string;
}

export interface WorkbenchPackageUpgradeInput {
  planId: string;
  catalogId: string;
  version: string;
  expectedDigest: string;
}

export type WorkbenchPackagePrepareInput = {
  version?: string;
  libraryId?: string;
};

export type WorkbenchPackageHandoffInput = {
  planId: string;
  snapshotId: string;
  payload: ValidatedComponentPayload;
};

export type WorkbenchPackageHandoff = (
  input: WorkbenchPackageHandoffInput,
  ctx: WorkbenchJobContext,
) => Promise<void>;

export interface WorkbenchPackageUpgradeOptions {
  home: string;
  managerId: () => string | null;
  pluginArtifact?: string;
  viewBridgeArtifact?: string;
  toolsRoot?: string;
  handoff?: WorkbenchPackageHandoff;
  snapshots: Pick<SnapshotExecutor, "create">;
  upgrades: Pick<CoordinatedUpgrade, "restore" | "recover">;
  currentRuntime: () => SnapshotRuntime;
  stopAll: () => Promise<void>;
  /** Kept for Supervisor construction; execute does not restart the old manager. */
  reinitializeManager: () => Promise<void>;
  pluginAdd?: typeof defaultPluginAdd;
  fetchImpl?: PluginFetcher;
  downloadPlugin?: typeof defaultDownloadPlugin;
  pack?: (request: PackOneRequest) => Promise<string>;
  execPath?: string;
  downloadTimeoutMs?: number;
}

interface UpgradeSettlement {
  schemaVersion: 1;
  planId: string;
  snapshotId?: string;
  outcome: WorkbenchPackageOutcome;
  rolledBack: boolean;
  at: string;
}

interface UpgradeMarker {
  schemaVersion: 1;
  kind: typeof MARKER_KIND;
  planId: string;
  catalogId: typeof WORKBENCH_PACKAGE_CATALOG_ID;
  version: string;
  expectedDigest: string;
  home: string;
  managerId: string;
  pluginDigest: string;
  viewBridgeDigest: string;
  startedAt: string;
  snapshotId?: string;
  settlement?: UpgradeSettlement;
}

interface ArtifactInspection {
  packageName: string;
  version: string;
  artifact: string;
  fileDigest: string;
  archiveId: string;
  files: Record<string, string>;
}

interface CandidateInspection {
  version: string;
  digest: string;
  plugin: ArtifactInspection;
  viewBridge: ArtifactInspection;
}

interface PreparedCandidate extends CandidateInspection {
  llmBridge: ArtifactInspection;
  payload: ValidatedComponentPayload;
}

interface ExecuteCandidate extends CandidateInspection {
  payload: ValidatedComponentPayload;
}

export class WorkbenchPackageUpgrade {
  private readonly home: string;
  private readonly pluginAdd: typeof defaultPluginAdd;
  private prepared: PreparedCandidate | undefined;

  constructor(private readonly options: WorkbenchPackageUpgradeOptions) {
    assertNotRealHome(options.home);
    this.home = resolve(options.home);
    this.pluginAdd = options.pluginAdd ?? defaultPluginAdd;
  }

  async describe(): Promise<WorkbenchPackageRelease | undefined> {
    const candidate = await this.readCandidateSilent();
    if (!candidate) return undefined;
    return this.toRelease(candidate);
  }

  /**
   * Download or reuse a cached @dsh-spaces/plugin, stage the immutable group, and
   * pack plugin/view/llm. Does not stop, install, or change the selected pointer.
   * Startup pluginArtifact/viewBridgeArtifact stay bound and are never selected here.
   */
  async prepare(
    input: WorkbenchPackagePrepareInput,
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchPackageRelease> {
    const requested = optionalText(input?.version);
    const libraryId = optionalText(input?.libraryId);
    if (requested && libraryId) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "Prepare accepts an exact version or a cached library id, not both.",
      );
    }
    const version = requested === "latest" ? "" : requested;
    if (version && !isExactRuntimeVersion(version)) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "A precise package version is required.");
    }
    if (this.readMarker()) {
      throw new WorkbenchPackageUpgradeError(
        "conflict",
        "Another workbench package plan is unfinished.",
      );
    }
    const toolsRoot = this.requireToolsRoot();
    assertExistingAncestorsOutsideHome(
      this.home,
      join(toolsRoot, PREPARE_SCRATCH_DIR, "extract-"),
      "The prepare scratch",
    );
    this.readOfficialLibrary();
    ctx.cancellable(true);
    ctx.phase("prepare");
    this.throwIfAborted(ctx);
    const source = libraryId
      ? this.requireCachedPluginArchive(libraryId)
      : await this.downloadOfficialPlugin(version, ctx);
    this.throwIfAborted(ctx);
    const built = await this.buildPreparedCandidate(source.archive, source.expectedVersion, toolsRoot, ctx);
    this.prepared = built;
    return this.toRelease(built);
  }

  async execute(
    input: WorkbenchPackageUpgradeInput,
    ctx: WorkbenchJobContext,
  ): Promise<{ snapshotId: string }> {
    const planId = requireUuid(input.planId, "planId");
    if (input.catalogId !== WORKBENCH_PACKAGE_CATALOG_ID) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "Workbench package upgrades accept only the bundled workbench candidate.",
      );
    }
    if (typeof input.version !== "string" || !input.version.trim()) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "A precise package version is required.");
    }
    if (typeof input.expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(input.expectedDigest)) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "A precise content digest is required.");
    }

    const existingReceipt = this.readReceipt(planId);
    if (existingReceipt) {
      throw new WorkbenchPackageUpgradeError(
        "conflict",
        "This workbench package plan has already been settled.",
      );
    }
    const existing = this.readMarker();
    if (existing) {
      throw new WorkbenchPackageUpgradeError(
        "conflict",
        existing.planId === planId
          ? "This workbench package plan is unfinished. Unfinished update evidence remains."
          : "Another workbench package plan is unfinished. Unfinished update evidence remains.",
      );
    }

    const ports = this.requireHandoffPort();
    const managerId = this.requireManagerId();
    const candidate = await this.resolveExecuteCandidate(ports.toolsRoot, ctx);
    if (candidate.version !== input.version.trim()) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "The bundled workbench version changed after preview.",
      );
    }
    if (candidate.digest !== input.expectedDigest) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "The bundled workbench digest changed after preview.",
      );
    }

    ctx.cancellable(true);
    ctx.phase("plan");
    const marker: UpgradeMarker = {
      schemaVersion: SCHEMA_VERSION,
      kind: MARKER_KIND,
      planId,
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: candidate.version,
      expectedDigest: candidate.digest,
      home: this.home,
      managerId,
      pluginDigest: candidate.plugin.fileDigest,
      viewBridgeDigest: candidate.viewBridge.fileDigest,
      startedAt: new Date().toISOString(),
    };
    this.writeMarker(marker);
    this.throwIfAborted(ctx);

    try {
      ctx.phase("stop");
      ctx.message("Stopping owned spaces before replacing the manager packages.");
      await this.options.stopAll();
      this.throwIfAborted(ctx);

      ctx.phase("snapshot");
      ctx.cancellable(false);
      const snapshot = await this.options.snapshots.create(
        this.options.currentRuntime(),
        WORKBENCH_UPGRADE_SNAPSHOT_REASON,
      );
      const snapshotId = requireUuid(snapshot.id, "snapshotId");
      marker.snapshotId = snapshotId;
      this.writeMarker(marker);

      ctx.phase("install");
      ctx.message("Replacing the manager plugin and view-bridge archives.");
      await this.installCandidate(managerId, candidate.plugin);
      await this.installCandidate(managerId, candidate.viewBridge);

      ctx.phase("verify");
      this.verifyInstalled(managerId, candidate);
      const installedLib = this.installedPluginLib(managerId);
      if (!installedLib) {
        throw new WorkbenchPackageUpgradeError(
          "failed",
          "Installed workbench plugin payload could not be read back after plugin add.",
        );
      }
      const installed = validateComponentPayload(installedLib);
      this.assertPayloadMatchesCandidate(installed, candidate);
      if (installed.digest !== candidate.payload.digest) {
        throw new WorkbenchPackageUpgradeError(
          "failed",
          "Installed workbench payload does not match the prepared payload.",
        );
      }
      const livePayload = this.revalidateStagedPayload(candidate.payload);
      if (livePayload.digest !== candidate.payload.digest) {
        throw new WorkbenchPackageUpgradeError(
          "failed",
          "Staged workbench payload does not match the prepared payload.",
        );
      }

      ctx.phase("handoff");
      await ports.handoff({ planId, snapshotId, payload: livePayload }, ctx);
      this.settle(marker, "succeeded", false);
      return { snapshotId };
    } catch (error) {
      if (error instanceof ProcessTerminationError) throw error;
      // Once settlement starts, preserve its evidence. Do not restore or recover
      // after a snapshot; report the original failure in place.
      if (marker.settlement) throw error;
      try {
        this.settle(marker, "abandoned", false);
      } catch {
        // Settlement is best-effort evidence. Never replace the original failure.
      }
      throw error;
    }
  }

  /**
   * Consume one unfinished marker, or read one exact-plan receipt.
   * Does not list historical receipts. Root selects consumption via unfinishedPlanIds.
   * Cold recover success/abandon does not start the manager; root reinitializes once.
   */
  async recover(
    _ctx: WorkbenchJobContext,
    _planId?: string,
  ): Promise<WorkbenchPackageRecovery | undefined> {
    throw new WorkbenchPackageUpgradeError("unavailable", "Workbench package recovery is not supported.");
  }

  hasEvidence(): boolean {
    try {
      lstatSync(this.markerPath());
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  private settle(marker: UpgradeMarker, outcome: WorkbenchPackageOutcome, rolledBack: boolean): void {
    const settlement: UpgradeSettlement = {
      schemaVersion: SCHEMA_VERSION,
      planId: marker.planId,
      snapshotId: marker.snapshotId,
      outcome,
      rolledBack,
      at: new Date().toISOString(),
    };
    marker.settlement = settlement;
    this.writeMarker(marker);
    this.writeReceipt(settlement);
    this.clearMarker();
  }

  private async installCandidate(managerId: string, artifact: ArtifactInspection): Promise<void> {
    const dest = archiveAbsPath(this.home, artifact.archiveId);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(resolve(artifact.artifact), dest);
    await this.pluginAdd(this.home, managerId, dest);
  }

  private requireHandoffPort(): { toolsRoot: string; handoff: WorkbenchPackageHandoff } {
    const toolsRoot = this.requireToolsRoot();
    const handoff = this.options.handoff;
    if (typeof handoff !== "function") {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "Workbench package upgrades require a tools root and a handoff port.",
      );
    }
    return { toolsRoot, handoff };
  }

  private requireToolsRoot(): string {
    const toolsRoot = this.options.toolsRoot;
    if (typeof toolsRoot !== "string" || !toolsRoot.trim()) {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "Workbench package upgrades require a tools root and a handoff port.",
      );
    }
    return mkdirOutsideHome(this.home, resolve(toolsRoot.trim()), "The tools root");
  }

  private verifyInstalled(managerId: string, candidate: CandidateInspection): void {
    const pluginFiles = Object.keys(candidate.plugin.files);
    const plugin = this.readInstalledFiles(managerId, candidate.plugin.packageName, pluginFiles);
    const bridge = this.readInstalledFiles(managerId, candidate.viewBridge.packageName, Object.keys(candidate.viewBridge.files));
    if (!plugin || !bridge) {
      throw new WorkbenchPackageUpgradeError(
        "failed",
        "Installed workbench packages could not be read back after plugin add.",
      );
    }
    assertSamePackage(plugin, candidate.plugin);
    assertSamePackage(bridge, candidate.viewBridge);
  }

  private installedPluginLib(managerId: string): string | undefined {
    const path = this.installedFile(managerId, SPACES_PLUGIN_PACKAGE, "lib/index.js");
    if (!path) return undefined;
    return dirname(path);
  }

  private assertPayloadMatchesCandidate(payload: ValidatedComponentPayload, candidate: CandidateInspection): void {
    for (const [rel, hash] of Object.entries(candidate.plugin.files)) {
      const listed = payload.files.find((file) => file.path === rel);
      if (!listed || listed.sha256 !== hash) {
        throw new WorkbenchPackageUpgradeError(
          "failed",
          "Staged workbench payload does not match the candidate archive.",
        );
      }
    }
    for (const file of payload.files) {
      if (candidate.plugin.files[file.path] !== file.sha256) {
        throw new WorkbenchPackageUpgradeError(
          "failed",
          "Staged workbench payload does not match the candidate archive.",
        );
      }
    }
  }

  private installedMatches(candidate: CandidateInspection): boolean {
    const managerId = this.options.managerId();
    if (!managerId || !PROFILE_NAME_RE.test(managerId)) return false;
    try {
      this.verifyInstalled(managerId, candidate);
      return true;
    } catch {
      return false;
    }
  }

  private readInstalledPlugin(): { name: string; version: string } | undefined {
    const managerId = this.options.managerId();
    if (!managerId || !PROFILE_NAME_RE.test(managerId)) return undefined;
    const pkg = this.readInstalledPackageJson(managerId, SPACES_PLUGIN_PACKAGE);
    if (!pkg || pkg.name !== SPACES_PLUGIN_PACKAGE || !pkg.version) return undefined;
    return pkg;
  }

  private async requireCandidate(): Promise<CandidateInspection> {
    const candidate = await this.readBoundCandidateSilent();
    if (!candidate) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "The bound workbench plugin and view-bridge artifacts are missing or not official packages.",
      );
    }
    return candidate;
  }

  private async readCandidateSilent(): Promise<CandidateInspection | undefined> {
    if (this.prepared) {
      try {
        return await this.revalidatePrepared(this.prepared);
      } catch {
        return undefined;
      }
    }
    return this.readBoundCandidateSilent();
  }

  private async readBoundCandidateSilent(): Promise<CandidateInspection | undefined> {
    const pluginPath = this.options.pluginArtifact;
    const bridgePath = this.options.viewBridgeArtifact;
    if (!pluginPath || !bridgePath) return undefined;
    try {
      if (!isRealFile(pluginPath) || !isRealFile(bridgePath)) return undefined;
      const [plugin, viewBridge] = await Promise.all([
        inspectPluginArchive(pluginPath),
        inspectArtifact(bridgePath, VIEW_BRIDGE_PACKAGE, VIEW_BRIDGE_FILES, VIEW_BRIDGE_ARCHIVE_PREFIX),
      ]);
      return {
        version: plugin.version,
        digest: boundArtifactDigest(plugin, viewBridge),
        plugin,
        viewBridge,
      };
    } catch {
      return undefined;
    }
  }

  private async resolveExecuteCandidate(toolsRoot: string, ctx: WorkbenchJobContext): Promise<ExecuteCandidate> {
    if (this.prepared) {
      const live = await this.revalidatePrepared(this.prepared);
      return live;
    }
    const bound = await this.requireCandidate();
    this.throwIfAborted(ctx);
    const payload = await this.stageFromPluginArchive(bound.plugin.artifact, toolsRoot, bound.plugin);
    this.assertPayloadMatchesCandidate(payload, bound);
    const viewBridge = await inspectArtifact(bound.viewBridge.artifact, VIEW_BRIDGE_PACKAGE, bridgeFiles(payload, "view-bridge"), VIEW_BRIDGE_ARCHIVE_PREFIX);
    assertBridgeMatchesPayload(payload, "view-bridge", viewBridge);
    return { ...bound, viewBridge, payload };
  }

  private readOfficialLibrary(): ReturnType<typeof readLibraryOrThrow> {
    try {
      return readLibraryOrThrow(this.home);
    } catch (error) {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        error instanceof Error && error.message.trim()
          ? error.message
          : "Plugin library could not be read. Original bytes were left unchanged.",
      );
    }
  }

  private requireCachedPluginArchive(libraryId: string): { archive: string; expectedVersion: string } {
    const key = libraryId.toLowerCase();
    const entry = this.readOfficialLibrary().find((row) => row.id === key);
    if (!entry) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "The cached workbench plugin was not found.");
    }
    if (entry.packageName !== SPACES_PLUGIN_PACKAGE) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "Workbench prepare accepts only the official Spaces plugin package.",
      );
    }
    const pinned = parseNpmNameAndVersion(entry.spec);
    if (!pinned || pinned.name !== SPACES_PLUGIN_PACKAGE || !isExactRuntimeVersion(pinned.version)) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "The cached workbench plugin does not have a pinned exact version.",
      );
    }
    if (!entry.tarball) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "The cached workbench plugin archive is missing.");
    }
    const archive = resolve(this.home, entry.tarball);
    if (!isHubPluginArchive(this.home, archive) || !isRealFile(archive)) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "The cached workbench plugin archive is missing.");
    }
    return { archive, expectedVersion: pinned.version };
  }

  private async downloadOfficialPlugin(
    version: string,
    ctx: WorkbenchJobContext,
  ): Promise<{ archive: string; expectedVersion: string }> {
    ctx.message(
      version
        ? `Downloading the official workbench plugin ${version}.`
        : "Downloading the latest official workbench plugin.",
    );
    const spec = version ? `${SPACES_PLUGIN_PACKAGE}@${version}` : SPACES_PLUGIN_PACKAGE;
    const download = this.options.downloadPlugin ?? defaultDownloadPlugin;
    let entry;
    try {
      entry = await download(
        this.home,
        { spec },
        {
          fetchImpl: this.options.fetchImpl,
          signal: ctx.signal,
          timeoutMs: this.options.downloadTimeoutMs,
        },
      );
    } catch (error) {
      if (ctx.signal.aborted) throw new WorkbenchJobAbortError();
      throwUpgradeFailure(error, "The official workbench plugin could not be downloaded.");
    }
    if (entry.packageName !== SPACES_PLUGIN_PACKAGE) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "Workbench prepare accepts only the official Spaces plugin package.",
      );
    }
    const pinned = parseNpmNameAndVersion(entry.spec);
    if (!pinned || pinned.name !== SPACES_PLUGIN_PACKAGE || !isExactRuntimeVersion(pinned.version)) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "The official workbench plugin download did not pin an exact version.",
      );
    }
    if (version && pinned.version !== version) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "The downloaded workbench plugin version does not match the requested version.",
      );
    }
    if (!entry.tarball) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "The official workbench plugin archive is missing.");
    }
    const archive = resolve(this.home, entry.tarball);
    if (!isHubPluginArchive(this.home, archive) || !isRealFile(archive)) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "The official workbench plugin archive is missing.");
    }
    return { archive, expectedVersion: pinned.version };
  }

  private async buildPreparedCandidate(
    archive: string,
    expectedVersion: string,
    toolsRoot: string,
    ctx: WorkbenchJobContext,
  ): Promise<PreparedCandidate> {
    ctx.phase("validate");
    ctx.message("Validating the official workbench plugin archive.");
    let plugin;
    try {
      plugin = await inspectPluginArchive(archive);
    } catch (error) {
      if (error instanceof WorkbenchPackageUpgradeError) throw error;
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        error instanceof Error && error.message.trim()
          ? error.message
          : "The official workbench plugin archive is not a valid payload.",
      );
    }
    if (plugin.packageName !== SPACES_PLUGIN_PACKAGE) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "Workbench prepare accepts only the official Spaces plugin package.",
      );
    }
    assertPluginMatchesExpectedVersion(plugin, expectedVersion);
    this.throwIfAborted(ctx);
    ctx.phase("stage");
    ctx.message("Staging the immutable workbench component group.");
    const payload = await this.stageFromPluginArchive(archive, toolsRoot, plugin);
    assertPayloadMatchesExpectedVersion(payload, expectedVersion);
    this.throwIfAborted(ctx);
    ctx.phase("pack");
    ctx.message("Packing the staged workbench plugin, view-bridge, and llm-bridge.");
    const packed = await this.packStagedGroup(payload, toolsRoot);
    const inspected = await this.inspectPackedGroup(packed, payload);
    assertPackedMatchesPayload(inspected, payload);
    assertPluginMatchesExpectedVersion(inspected.plugin, expectedVersion);
    const digest = preparedCandidateDigest(
      inspected.plugin,
      inspected.viewBridge,
      inspected.llmBridge,
      payload.digest,
    );
    const candidate: PreparedCandidate = {
      version: inspected.plugin.version,
      digest,
      plugin: inspected.plugin,
      viewBridge: inspected.viewBridge,
      llmBridge: inspected.llmBridge,
      payload,
    };
    return this.revalidatePrepared(candidate);
  }

  private async stageFromPluginArchive(
    archive: string,
    toolsRoot: string,
    inspected?: ArtifactInspection,
  ): Promise<ValidatedComponentPayload> {
    const plugin = inspected ?? await inspectPluginArchive(archive);
    const scratchParent = mkdirOutsideHome(
      this.home,
      join(toolsRoot, PREPARE_SCRATCH_DIR),
      "The prepare scratch",
    );
    const extractRoot = mkdtempSync(join(scratchParent, "extract-"));
    assertRealDirOutsideHome(this.home, extractRoot, "The prepare scratch");
    const packageRoot = mkdirOutsideHome(this.home, join(extractRoot, "package"), "The prepare scratch");
    try {
      await materializeDeclaredFiles(archive, plugin.files, packageRoot, this.home);
      const materialized = validateComponentPayload(join(packageRoot, "lib"));
      this.assertPayloadMatchesCandidate(materialized, {
        version: plugin.version,
        digest: plugin.fileDigest,
        plugin,
        viewBridge: plugin,
      });
      const staged = stageComponentPayload(this.home, toolsRoot, materialized.payloadRootLib);
      this.assertPayloadMatchesCandidate(staged, {
        version: plugin.version,
        digest: plugin.fileDigest,
        plugin,
        viewBridge: plugin,
      });
      return staged;
    } catch (error) {
      return throwUpgradeFailure(error, "The workbench payload could not be staged.");
    } finally {
      try {
        rmSync(extractRoot, { recursive: true, force: true });
      } catch {
        // Scratch leftover is not selected. Do not roll back the staged group.
      }
    }
  }

  private async packStagedGroup(
    payload: ValidatedComponentPayload,
    toolsRoot: string,
  ): Promise<{ pluginArtifact: string; viewBridgeArtifact: string; llmBridgeArtifact: string }> {
    const artifactDir = mkdirOutsideHome(
      this.home,
      join(toolsRoot, PREPARE_SCRATCH_DIR, payload.digest, "artifacts"),
      "The packed artifact directory",
    );
    const packed = await packLocalArtifacts({
      home: this.home,
      pluginPackageRoot: payload.packageRoot,
      viewBridgeRoot: join(payload.packageRoot, "lib", "view-bridge"),
      llmBridgeRoot: join(payload.packageRoot, "lib", "llm-bridge"),
      artifactDir,
      execPath: this.options.execPath ?? process.execPath,
      pack: this.options.pack,
    });
    if ("reasons" in packed || !packed.llmBridgeArtifact) {
      const detail = "reasons" in packed ? packed.reasons[0] : "llm-bridge pack is missing.";
      throw new WorkbenchPackageUpgradeError(
        "failed",
        detail || "The staged workbench group could not be packed.",
      );
    }
    return {
      pluginArtifact: packed.pluginArtifact,
      viewBridgeArtifact: packed.viewBridgeArtifact,
      llmBridgeArtifact: packed.llmBridgeArtifact,
    };
  }

  private async inspectPackedGroup(
    packed: { pluginArtifact: string; viewBridgeArtifact: string; llmBridgeArtifact: string },
    payload: ValidatedComponentPayload,
  ): Promise<{ plugin: ArtifactInspection; viewBridge: ArtifactInspection; llmBridge: ArtifactInspection }> {
    if (!isRealFile(packed.pluginArtifact) || !isRealFile(packed.viewBridgeArtifact) || !isRealFile(packed.llmBridgeArtifact)) {
      throw new WorkbenchPackageUpgradeError("failed", "Packed workbench artifacts are missing.");
    }
    try {
      return await inspectComponentPayloadArtifacts(payload, packed);
    } catch (error) {
      throwUpgradeFailure(error, "Packed workbench artifacts are not official packages.");
    }
  }

  private async revalidatePrepared(candidate: PreparedCandidate): Promise<PreparedCandidate> {
    if (
      !isRealFile(candidate.plugin.artifact) ||
      !isRealFile(candidate.viewBridge.artifact) ||
      !isRealFile(candidate.llmBridge.artifact)
    ) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "The prepared workbench artifacts are missing.");
    }
    if (
      sha256File(candidate.plugin.artifact) !== candidate.plugin.fileDigest ||
      sha256File(candidate.viewBridge.artifact) !== candidate.viewBridge.fileDigest ||
      sha256File(candidate.llmBridge.artifact) !== candidate.llmBridge.fileDigest
    ) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "The prepared workbench artifacts changed after prepare.");
    }
    const inspected = await this.inspectPackedGroup({
      pluginArtifact: candidate.plugin.artifact,
      viewBridgeArtifact: candidate.viewBridge.artifact,
      llmBridgeArtifact: candidate.llmBridge.artifact,
    }, candidate.payload);
    assertPackedMatchesPayload(inspected, candidate.payload);
    if (
      inspected.plugin.fileDigest !== candidate.plugin.fileDigest ||
      inspected.viewBridge.fileDigest !== candidate.viewBridge.fileDigest ||
      inspected.llmBridge.fileDigest !== candidate.llmBridge.fileDigest
    ) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "The prepared workbench artifacts changed after prepare.");
    }
    const payload = this.revalidateStagedPayload(candidate.payload);
    const digest = preparedCandidateDigest(
      inspected.plugin,
      inspected.viewBridge,
      inspected.llmBridge,
      payload.digest,
    );
    if (digest !== candidate.digest || payload.digest !== candidate.payload.digest) {
      throw new WorkbenchPackageUpgradeError("invalid-input", "The prepared workbench digest changed after prepare.");
    }
    return {
      version: inspected.plugin.version,
      digest,
      plugin: inspected.plugin,
      viewBridge: inspected.viewBridge,
      llmBridge: inspected.llmBridge,
      payload,
    };
  }

  private revalidateStagedPayload(payload: ValidatedComponentPayload): ValidatedComponentPayload {
    try {
      const live = validateComponentPayload(payload.payloadRootLib);
      if (live.digest !== payload.digest) {
        throw new WorkbenchPackageUpgradeError(
          "invalid-input",
          "The prepared workbench payload changed after prepare.",
        );
      }
      return live;
    } catch (error) {
      if (error instanceof WorkbenchPackageUpgradeError) throw error;
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "The prepared workbench payload changed after prepare.",
      );
    }
  }

  private toRelease(candidate: CandidateInspection): WorkbenchPackageRelease {
    const installed = this.readInstalledPlugin();
    const installedVersion = installed?.version ?? null;
    const updateAvailable = !this.installedMatches(candidate);
    return {
      id: WORKBENCH_PACKAGE_CATALOG_ID,
      version: candidate.version,
      installedVersion,
      digest: candidate.digest,
      updateAvailable,
    };
  }

  private requireManagerId(): string {
    const managerId = this.options.managerId();
    if (!managerId || !PROFILE_NAME_RE.test(managerId)) {
      throw new WorkbenchPackageUpgradeError("unavailable", "The manager profile is not available.");
    }
    const profile = join(this.home, "profiles", managerId);
    if (inspectLeaf(this.home, profile) !== "dir") {
      throw new WorkbenchPackageUpgradeError("unavailable", "The manager profile is not available.");
    }
    return managerId;
  }

  private readInstalledFiles(
    managerId: string,
    packageName: string,
    files: readonly string[],
  ): ArtifactInspection | undefined {
    const pkg = this.readInstalledPackageJson(managerId, packageName);
    if (!pkg) return undefined;
    const hashes: Record<string, string> = {};
    for (const rel of files) {
      const path = this.installedFile(managerId, packageName, rel);
      if (!path) return undefined;
      hashes[rel] = sha256File(path);
    }
    return {
      packageName: pkg.name,
      version: pkg.version,
      artifact: "",
      fileDigest: "",
      archiveId: "",
      files: hashes,
    };
  }

  private readInstalledPackageJson(
    managerId: string,
    packageName: string,
  ): { name: string; version: string } | undefined {
    const path = this.installedFile(managerId, packageName, "package.json");
    if (!path) return undefined;
    return readPackageIdentity(readFileSync(path, "utf8"));
  }

  private installedFile(managerId: string, packageName: string, rel: string): string | undefined {
    const root = join(this.home, "profiles", managerId, "node_modules", ...packageName.split("/"));
    const target = join(root, ...rel.split("/"));
    const kind = inspectLeaf(join(this.home, "profiles", managerId), target);
    if (kind !== "file") return undefined;
    try {
      return realpathSync(target);
    } catch {
      return undefined;
    }
  }

  private markerPath(): string {
    return join(this.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_UPGRADE_MARKER_FILE);
  }

  private receiptsDir(): string {
    return join(this.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_UPGRADE_RECEIPTS_DIR);
  }

  private receiptPath(planId: string): string {
    return join(this.receiptsDir(), `${planId}.json`);
  }

  private peekMarker(): UpgradeMarker | "missing" | "invalid" {
    const path = this.markerPath();
    const kind = inspectLeaf(this.home, path);
    if (kind === "missing") return "missing";
    if (kind !== "file") return "invalid";
    try {
      return parseMarker(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return "invalid";
    }
  }

  private readMarker(): UpgradeMarker | undefined {
    const marker = this.peekMarker();
    if (marker === "missing") return undefined;
    if (marker === "invalid") {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package upgrade record requires offline inspection.",
      );
    }
    this.assertMarkerHome(marker);
    return marker;
  }

  private assertMarkerHome(marker: UpgradeMarker): void {
    if (!samePath(marker.home, this.home)) {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package upgrade record does not match this Home.",
      );
    }
    const managerId = this.options.managerId();
    if (!managerId || managerId !== marker.managerId) {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package upgrade record does not match this manager.",
      );
    }
  }

  private writeMarker(marker: UpgradeMarker): void {
    const path = this.markerPath();
    const existing = inspectLeaf(this.home, path);
    if (existing === "invalid" || existing === "dir") {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package upgrade record requires offline inspection.",
      );
    }
    atomicWrite(path, `${JSON.stringify(marker, null, 2)}\n`);
    if (inspectLeaf(this.home, path) !== "file") {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package upgrade record could not be saved.",
      );
    }
  }

  private writeReceipt(settlement: UpgradeSettlement): void {
    this.ensureReceiptsDir();
    const path = this.receiptPath(settlement.planId);
    const existing = inspectLeaf(this.home, path);
    if (existing === "file") {
      const current = this.readReceipt(settlement.planId);
      if (!current || !receiptAgrees(current, settlement)) {
        throw new WorkbenchPackageUpgradeError(
          "unavailable",
          "The workbench package receipt does not match this plan settlement.",
        );
      }
      return;
    }
    if (existing !== "missing") {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package receipt requires offline inspection.",
      );
    }
    atomicWrite(path, `${JSON.stringify(settlement, null, 2)}\n`);
    if (inspectLeaf(this.home, path) !== "file") {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package receipt could not be saved.",
      );
    }
    const written = this.readReceipt(settlement.planId);
    if (!written || !receiptAgrees(written, settlement)) {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package receipt does not match this plan settlement.",
      );
    }
  }

  private readReceipt(planId: string): UpgradeSettlement | undefined {
    const path = this.receiptPath(planId);
    const kind = inspectLeaf(this.home, path);
    if (kind === "missing") return undefined;
    if (kind !== "file") {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package receipt requires offline inspection.",
      );
    }
    let parsed: UpgradeSettlement;
    try {
      parsed = parseSettlement(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package receipt requires offline inspection.",
      );
    }
    if (parsed.planId !== planId) {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package receipt does not match this plan identity.",
      );
    }
    return parsed;
  }

  private ensureReceiptsDir(): void {
    const dir = this.receiptsDir();
    const existing = inspectLeaf(this.home, dir);
    if (existing === "missing") mkdirSync(dir, { recursive: true });
    if (inspectLeaf(this.home, dir) !== "dir") {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package receipt directory requires offline inspection.",
      );
    }
  }

  private clearMarker(): void {
    const path = this.markerPath();
    const kind = inspectLeaf(this.home, path);
    if (kind === "missing") return;
    if (kind !== "file") {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package upgrade record requires offline inspection.",
      );
    }
    unlinkSync(path);
  }

  private throwIfAborted(ctx: WorkbenchJobContext): void {
    if (ctx.signal.aborted) throw new WorkbenchJobAbortError();
  }
}

function boundArtifactDigest(plugin: ArtifactInspection, viewBridge: ArtifactInspection): string {
  return sha256Text(`${plugin.packageName}:${plugin.fileDigest}\n${viewBridge.packageName}:${viewBridge.fileDigest}\n`);
}

function preparedCandidateDigest(
  plugin: ArtifactInspection,
  viewBridge: ArtifactInspection,
  llmBridge: ArtifactInspection,
  payloadDigest: string,
): string {
  return sha256Text(
    `${plugin.packageName}:${plugin.fileDigest}\n${viewBridge.packageName}:${viewBridge.fileDigest}\n${llmBridge.packageName}:${llmBridge.fileDigest}\n${payloadDigest}\n`,
  );
}

function assertPluginMatchesExpectedVersion(plugin: ArtifactInspection, expectedVersion: string): void {
  if (plugin.version !== expectedVersion) {
    throw new WorkbenchPackageUpgradeError(
      "invalid-input",
      "The workbench plugin archive version does not match the pinned version.",
    );
  }
}

function assertPayloadMatchesExpectedVersion(payload: ValidatedComponentPayload, expectedVersion: string): void {
  if (payload.manifest.components["manager-plugin"].version !== expectedVersion) {
    throw new WorkbenchPackageUpgradeError(
      "invalid-input",
      "The workbench plugin archive version does not match the pinned version.",
    );
  }
}

type ComponentArtifactPaths = { pluginArtifact: string; viewBridgeArtifact: string; llmBridgeArtifact: string };

/** Verify CLI install archives against the selected component group's actual bytes. */
export async function validateComponentPayloadArtifacts(
  payload: ValidatedComponentPayload,
  artifacts: ComponentArtifactPaths,
): Promise<void> {
  const current = validateComponentPayload(payload.payloadRootLib);
  if (current.digest !== payload.digest) {
    throw new WorkbenchPackageUpgradeError("invalid-input", "Selected component payload changed before startup.");
  }
  assertPackedMatchesPayload(await inspectComponentPayloadArtifacts(current, artifacts), current);
}

function bridgeFiles(payload: ValidatedComponentPayload, name: "view-bridge" | "llm-bridge"): string[] {
  const prefix = `lib/${name}/`;
  return payload.manifest.components[name].files.map((file) => {
    if (!file.path.startsWith(prefix)) {
      throw new WorkbenchPackageUpgradeError("invalid-input", `Component ${name} declares a file outside its package.`);
    }
    return file.path.slice(prefix.length);
  });
}

function assertBridgeMatchesPayload(payload: ValidatedComponentPayload, name: "view-bridge" | "llm-bridge", artifact: ArtifactInspection): void {
  const component = payload.manifest.components[name];
  const prefix = `lib/${name}/`;
  if (artifact.version !== component.version || artifact.packageName !== component.packageName) {
    throw new WorkbenchPackageUpgradeError("failed", `Packed ${name} identity does not match the staged payload.`);
  }
  for (const file of component.files) {
    if (!file.path.startsWith(prefix) || artifact.files[file.path.slice(prefix.length)] !== file.sha256) {
      throw new WorkbenchPackageUpgradeError("failed", `Packed ${name} bytes do not match the staged payload.`);
    }
  }
}

async function inspectComponentPayloadArtifacts(payload: ValidatedComponentPayload, artifacts: ComponentArtifactPaths) {
  const [plugin, viewBridge, llmBridge] = await Promise.all([
    inspectPluginArchive(artifacts.pluginArtifact),
    inspectArtifact(artifacts.viewBridgeArtifact, VIEW_BRIDGE_PACKAGE, bridgeFiles(payload, "view-bridge"), VIEW_BRIDGE_ARCHIVE_PREFIX),
    inspectArtifact(artifacts.llmBridgeArtifact, LLM_BRIDGE_PACKAGE, bridgeFiles(payload, "llm-bridge"), LLM_BRIDGE_ARCHIVE_PREFIX),
  ]);
  return { plugin, viewBridge, llmBridge };
}

function assertPackedMatchesPayload(
  packed: { plugin: ArtifactInspection; viewBridge: ArtifactInspection; llmBridge: ArtifactInspection },
  payload: ValidatedComponentPayload,
): void {
  if (packed.plugin.packageName !== SPACES_PLUGIN_PACKAGE) {
    throw new WorkbenchPackageUpgradeError("failed", "Packed plugin is not the official Spaces plugin.");
  }
  if (packed.viewBridge.packageName !== VIEW_BRIDGE_PACKAGE || packed.llmBridge.packageName !== LLM_BRIDGE_PACKAGE) {
    throw new WorkbenchPackageUpgradeError("failed", "Packed workbench artifacts are not official packages.");
  }
  if (packed.plugin.version !== payload.manifest.components["manager-plugin"].version) {
    throw new WorkbenchPackageUpgradeError("failed", "Packed plugin version does not match the staged manager plugin.");
  }
  if (packed.viewBridge.version !== payload.manifest.components["view-bridge"].version) {
    throw new WorkbenchPackageUpgradeError("failed", "Packed view-bridge version does not match the staged view-bridge.");
  }
  if (packed.llmBridge.version !== payload.manifest.components["llm-bridge"].version) {
    throw new WorkbenchPackageUpgradeError("failed", "Packed llm-bridge version does not match the staged llm-bridge.");
  }
  for (const [name, artifact] of [["view-bridge", packed.viewBridge], ["llm-bridge", packed.llmBridge]] as const) {
    assertBridgeMatchesPayload(payload, name, artifact);
  }
  for (const file of payload.files) {
    if (packed.plugin.files[file.path] !== file.sha256) {
      throw new WorkbenchPackageUpgradeError("failed", "Packed workbench plugin does not match the staged payload.");
    }
  }
  for (const [rel, hash] of Object.entries(packed.plugin.files)) {
    const listed = payload.files.find((file) => file.path === rel);
    if (!listed || listed.sha256 !== hash) {
      throw new WorkbenchPackageUpgradeError("failed", "Packed workbench plugin does not match the staged payload.");
    }
  }
}

async function materializeDeclaredFiles(
  archive: string,
  files: Record<string, string>,
  destRoot: string,
  home: string,
): Promise<void> {
  assertRealDirOutsideHome(home, destRoot, "The prepare scratch");
  const entries = await listTarEntries(archive);
  const root = packageRoot(entries);
  const rels = [...Object.keys(files), COMPONENT_PAYLOAD_MANIFEST_REL];
  const unique = [...new Set(rels)];
  for (const rel of unique) {
    if (!isSafeTarEntry(rel)) {
      throw new WorkbenchPackageUpgradeError("invalid-input", `Unsafe payload path ${rel}.`);
    }
    const dest = join(destRoot, ...rel.split("/"));
    if (!isInsideRoot(destRoot, dest) || samePath(destRoot, dest)) {
      throw new WorkbenchPackageUpgradeError("invalid-input", `Payload path escapes the scratch: ${rel}`);
    }
    const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    mkdirSafeOutsideHome(destRoot, parentRel, home);
    if (inspectOutsideLeaf(home, dest) !== "missing") {
      throw new WorkbenchPackageUpgradeError("invalid-input", `Payload path is not a fresh file: ${rel}`);
    }
    const bytes = await readTarEntry(archive, `${root}${rel}`);
    if (files[rel] && sha256Bytes(bytes) !== files[rel]) {
      throw new WorkbenchPackageUpgradeError("invalid-input", `Payload file digest does not match archive: ${rel}`);
    }
    writeFileSync(dest, bytes);
    const written = inspectOutsideLeaf(home, dest);
    if (written !== "file") {
      throw new WorkbenchPackageUpgradeError("failed", `Payload file could not be written: ${rel}`);
    }
    if (sha256File(dest) !== sha256Bytes(bytes)) {
      throw new WorkbenchPackageUpgradeError("failed", `Payload file changed while writing: ${rel}`);
    }
  }
}

function mkdirSafeOutsideHome(root: string, relDir: string, home: string): void {
  assertRealDirOutsideHome(home, root, "The prepare scratch");
  if (!relDir) return;
  if (!isSafeTarEntry(relDir)) {
    throw new WorkbenchPackageUpgradeError("invalid-input", `Unsafe payload directory ${relDir}.`);
  }
  let cursor = root;
  for (const part of relDir.split("/")) {
    cursor = join(cursor, part);
    if (!isInsideRoot(root, cursor) || samePath(root, cursor)) {
      throw new WorkbenchPackageUpgradeError("invalid-input", `Payload directory escapes the scratch: ${relDir}`);
    }
    mkdirOutsideHome(home, cursor, "The prepare scratch");
  }
}

function mkdirOutsideHome(home: string, path: string, label: string): string {
  const abs = resolve(path);
  if (!abs || abs.includes("\0")) {
    throw new WorkbenchPackageUpgradeError("unavailable", `${label} is missing.`);
  }
  assertExistingAncestorsOutsideHome(home, abs, label);
  const missing: string[] = [];
  let cursor = abs;
  for (;;) {
    let st;
    try {
      st = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new WorkbenchPackageUpgradeError("unavailable", `${label} could not be read.`);
      }
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
      continue;
    }
    if (st.isSymbolicLink()) {
      throw new WorkbenchPackageUpgradeError("unavailable", `${label} is a symlink or junction.`);
    }
    if (!st.isDirectory()) {
      throw new WorkbenchPackageUpgradeError("unavailable", `${label} is not a directory.`);
    }
    break;
  }
  for (const dir of missing.reverse()) {
    assertExistingAncestorsOutsideHome(home, dir, label);
    mkdirSync(dir);
    assertRealDirOutsideHome(home, dir, label);
  }
  assertRealDirOutsideHome(home, abs, label);
  return realpathSync(abs);
}

function assertExistingAncestorsOutsideHome(home: string, path: string, label: string): void {
  const abs = resolve(path);
  if (isInsideHome(home, abs)) {
    throw new WorkbenchPackageUpgradeError("unavailable", `${label} must be outside Home.`);
  }
  let cursor = abs;
  for (;;) {
    let st;
    try {
      st = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = dirname(cursor);
        if (parent === cursor) return;
        cursor = parent;
        continue;
      }
      throw new WorkbenchPackageUpgradeError("unavailable", `${label} could not be read.`);
    }
    if (st.isSymbolicLink()) {
      throw new WorkbenchPackageUpgradeError("unavailable", `${label} is a symlink or junction.`);
    }
    let real: string;
    try {
      real = realpathSync(cursor);
    } catch {
      throw new WorkbenchPackageUpgradeError("unavailable", `${label} could not be resolved.`);
    }
    if (!samePath(cursor, real)) {
      throw new WorkbenchPackageUpgradeError("unavailable", `${label} is a path alias.`);
    }
    if (isInsideHome(home, real)) {
      throw new WorkbenchPackageUpgradeError("unavailable", `${label} must be outside Home.`);
    }
    if (!st.isDirectory()) {
      throw new WorkbenchPackageUpgradeError("unavailable", `${label} is not a directory.`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function assertRealDirOutsideHome(home: string, path: string, label: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new WorkbenchPackageUpgradeError("unavailable", `${label} is missing.`);
  }
  if (st.isSymbolicLink()) {
    throw new WorkbenchPackageUpgradeError("unavailable", `${label} is a symlink or junction.`);
  }
  if (!st.isDirectory()) {
    throw new WorkbenchPackageUpgradeError("unavailable", `${label} is not a directory.`);
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new WorkbenchPackageUpgradeError("unavailable", `${label} could not be resolved.`);
  }
  if (!samePath(path, real)) {
    throw new WorkbenchPackageUpgradeError("unavailable", `${label} is a path alias.`);
  }
  if (isInsideHome(home, real)) {
    throw new WorkbenchPackageUpgradeError("unavailable", `${label} must be outside Home.`);
  }
}

function inspectOutsideLeaf(home: string, path: string): "missing" | "file" | "dir" | "invalid" {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "invalid";
  }
  if (st.isSymbolicLink()) return "invalid";
  if (!st.isFile() && !st.isDirectory()) return "invalid";
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return "invalid";
  }
  if (isInsideHome(home, real)) return "invalid";
  if (!samePath(path, real)) return "invalid";
  return st.isFile() ? "file" : "dir";
}

function isInsideRoot(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function throwUpgradeFailure(error: unknown, fallback: string): never {
  if (error instanceof WorkbenchPackageUpgradeError) throw error;
  if (error instanceof WorkbenchJobAbortError || error instanceof ProcessTerminationError) throw error;
  if (error && typeof error === "object" && "name" in error && (error as { name: unknown }).name === "AbortError") {
    throw error;
  }
  const message = error instanceof Error && error.message.trim() ? error.message : fallback;
  throw new WorkbenchPackageUpgradeError("failed", message);
}

function optionalText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new WorkbenchPackageUpgradeError("invalid-input", "Prepare version and library id must be strings.");
  }
  return value.trim();
}

function receiptAgrees(current: UpgradeSettlement, intended: UpgradeSettlement): boolean {
  return current.planId === intended.planId &&
    current.snapshotId === intended.snapshotId &&
    current.outcome === intended.outcome;
}

function assertSamePackage(installed: ArtifactInspection, candidate: ArtifactInspection): void {
  if (installed.packageName !== candidate.packageName || installed.version !== candidate.version) {
    throw new WorkbenchPackageUpgradeError(
      "failed",
      "Installed workbench package identity does not match the candidate.",
    );
  }
  for (const rel of Object.keys(candidate.files)) {
    if (installed.files[rel] !== candidate.files[rel]) {
      throw new WorkbenchPackageUpgradeError(
        "failed",
        "Installed workbench package contents do not match the candidate.",
      );
    }
  }
}

function parseMarker(value: unknown): UpgradeMarker {
  if (!isPlainObject(value)) throw new Error("invalid marker");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error("future marker");
  if (value.kind !== MARKER_KIND) throw new Error("invalid marker");
  const planId = requireUuid(text(value.planId), "planId");
  const catalogId = text(value.catalogId);
  if (catalogId !== WORKBENCH_PACKAGE_CATALOG_ID) throw new Error("invalid marker");
  const version = text(value.version);
  const expectedDigest = text(value.expectedDigest);
  const home = text(value.home);
  const managerId = text(value.managerId);
  const pluginDigest = text(value.pluginDigest);
  const viewBridgeDigest = text(value.viewBridgeDigest);
  const startedAt = text(value.startedAt);
  if (!version || !expectedDigest || !home || !managerId || !pluginDigest || !viewBridgeDigest || !startedAt) {
    throw new Error("invalid marker");
  }
  if (!PROFILE_NAME_RE.test(managerId)) throw new Error("invalid marker");
  const marker: UpgradeMarker = {
    schemaVersion: SCHEMA_VERSION,
    kind: MARKER_KIND,
    planId,
    catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
    version,
    expectedDigest,
    home,
    managerId,
    pluginDigest,
    viewBridgeDigest,
    startedAt,
  };
  if (value.snapshotId !== undefined) marker.snapshotId = requireUuid(text(value.snapshotId), "snapshotId");
  if (value.settlement !== undefined) {
    marker.settlement = parseSettlement(value.settlement);
    if (marker.settlement.planId !== marker.planId || marker.settlement.snapshotId !== marker.snapshotId) {
      throw new Error("settlement does not match marker");
    }
  }
  return marker;
}

function parseSettlement(value: unknown): UpgradeSettlement {
  if (!isPlainObject(value)) throw new Error("invalid receipt");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error("future receipt");
  const planId = requireUuid(text(value.planId), "planId");
  const outcome = value.outcome;
  if (outcome !== "succeeded" && outcome !== "rolled-back" && outcome !== "abandoned") {
    throw new Error("invalid receipt");
  }
  if (typeof value.rolledBack !== "boolean") throw new Error("invalid receipt");
  if (outcome === "rolled-back" && !value.rolledBack) throw new Error("invalid receipt");
  if ((outcome === "succeeded" || outcome === "abandoned") && value.rolledBack) throw new Error("invalid receipt");
  const at = text(value.at);
  if (!at) throw new Error("invalid receipt");
  const settlement: UpgradeSettlement = {
    schemaVersion: SCHEMA_VERSION,
    planId,
    outcome,
    rolledBack: value.rolledBack,
    at,
  };
  if (value.snapshotId !== undefined) settlement.snapshotId = requireUuid(text(value.snapshotId), "snapshotId");
  if ((outcome === "succeeded" || outcome === "rolled-back") && !settlement.snapshotId) throw new Error("missing snapshot evidence");
  return settlement;
}

async function inspectPluginArchive(artifact: string): Promise<ArtifactInspection> {
  const resolved = resolve(artifact);
  const entries = await listTarEntries(resolved);
  const root = packageRoot(entries);
  const manifestBytes = await readTarEntry(resolved, `${root}${COMPONENT_PAYLOAD_MANIFEST_REL}`);
  const parsed = parseComponentPayloadManifest(JSON.parse(manifestBytes.toString("utf8")));
  const hashes: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of COMPONENT_PAYLOAD_NAMES) {
    const row = parsed.components[name];
    const listed = new Set(row.files.map((file) => file.path));
    for (const required of COMPONENT_PAYLOAD_REQUIRED_FILES[name]) {
      if (!listed.has(required)) throw new Error(`component is missing ${required}`);
    }
    if (!listed.has(row.entry) || row.entry !== COMPONENT_PAYLOAD_ENTRIES[name]) {
      throw new Error(`component does not list its entry: ${name}`);
    }
    for (const file of row.files) {
      if (seen.has(file.path)) throw new Error(`duplicate component path ${file.path}`);
      seen.add(file.path);
      const bytes = await readTarEntry(resolved, `${root}${file.path}`);
      if (bytes.length !== file.size) {
        throw new Error(`component file size does not match archive: ${file.path}`);
      }
      const digest = sha256Bytes(bytes);
      if (digest !== file.sha256) {
        throw new Error(`component file digest does not match archive: ${file.path}`);
      }
      hashes[file.path] = digest;
    }
    const identity = readPackageIdentity((await readTarEntry(resolved, `${root}${IDENTITY_JSON[name]}`)).toString("utf8"));
    if (!identity || identity.name !== row.packageName || identity.version !== row.version) {
      throw new Error(`component identity does not match archive: ${name}`);
    }
  }
  const pkg = parsed.components["manager-plugin"];
  const fileDigest = sha256File(resolved);
  return {
    packageName: pkg.packageName,
    version: pkg.version,
    artifact: resolved,
    fileDigest,
    archiveId: `${PLUGIN_ARCHIVE_PREFIX}-${fileDigest.slice(0, DIGEST_ID_LENGTH)}`,
    files: hashes,
  };
}

async function inspectArtifact(
  artifact: string,
  expectedName: string,
  files: readonly string[],
  archivePrefix: string,
): Promise<ArtifactInspection> {
  const resolved = resolve(artifact);
  const entries = await listTarEntries(resolved);
  const root = packageRoot(entries);
  const manifestBytes = await readTarEntry(resolved, `${root}package.json`);
  const identity = readPackageIdentity(manifestBytes.toString("utf8"));
  if (!identity || identity.name !== expectedName) {
    throw new Error("artifact package name is not official");
  }
  const hashes: Record<string, string> = { "package.json": sha256Bytes(manifestBytes) };
  await Promise.all(
    files.filter((rel) => rel !== "package.json").map(async (rel) => {
      hashes[rel] = sha256Bytes(await readTarEntry(resolved, `${root}${rel}`));
    }),
  );
  const fileDigest = sha256File(resolved);
  return {
    packageName: identity.name,
    version: identity.version,
    artifact: resolved,
    fileDigest,
    archiveId: `${archivePrefix}-${fileDigest.slice(0, DIGEST_ID_LENGTH)}`,
    files: hashes,
  };
}

function packageRoot(entries: string[]): string {
  const normalized = entries.map((entry) => entry.replaceAll("\\", "/"));
  if (normalized.includes("package/package.json")) return "package/";
  if (normalized.includes("package.json")) return "";
  throw new Error("tarball has no package manifest");
}

function readPackageIdentity(source: string): { name: string; version: string } | undefined {
  try {
    const parsed = JSON.parse(source) as { name?: unknown; version?: unknown };
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
    if (!name || !version) return undefined;
    return { name, version };
  } catch {
    return undefined;
  }
}

function listTarEntries(archive: string): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      tarExecutable(),
      ["-tf", archive],
      { timeout: TAR_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_TAR_LIST_BYTES },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const entries = stdout
          .split(/\r?\n/)
          .map((line) => line.trim().replaceAll("\\", "/"))
          .filter((line) => line && !line.endsWith("/") && isSafeTarEntry(line));
        resolvePromise(entries);
      },
    );
  });
}

function readTarEntry(archive: string, entry: string): Promise<Buffer> {
  if (!isSafeTarEntry(entry)) return Promise.reject(new Error("unsafe tarball entry"));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(tarExecutable(), ["-xOf", archive, entry], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("tarball read timed out")), TAR_TIMEOUT_MS);
    const finish = (error?: Error, data?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      if (error) reject(error);
      else resolvePromise(data ?? Buffer.alloc(0));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_TAR_ENTRY_BYTES) {
        finish(new Error("tarball entry exceeds the read limit"));
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) finish(new Error("tarball entry could not be read"));
      else finish(undefined, Buffer.concat(chunks));
    });
  });
}

function tarExecutable(): string {
  if (process.platform === "win32") {
    return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  }
  return "tar";
}

function isSafeTarEntry(entry: string): boolean {
  const normalized = entry.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return false;
  }
  return normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function requireUuid(value: string, label: string): string {
  if (!SNAPSHOT_ID_RE.test(value)) {
    throw new WorkbenchPackageUpgradeError("invalid-input", `The ${label} is not a valid identity.`);
  }
  return value.toLowerCase();
}

function inspectLeaf(home: string, path: string): "missing" | "file" | "dir" | "invalid" {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "invalid";
  }
  if (st.isSymbolicLink()) return "invalid";
  if (!st.isFile() && !st.isDirectory()) return "invalid";
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return "invalid";
  }
  if (!isInsideHome(home, real)) return "invalid";
  return st.isFile() ? "file" : "dir";
}

function isRealFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function isInsideHome(home: string, path: string): boolean {
  const rel = relative(resolve(home), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
