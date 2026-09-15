import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicWrite } from "../../main/atomic";
import { assertNotRealHome, samePath } from "../../main/home-guard";
import { archiveAbsPath } from "../../main/plugin-library";
import { pluginAdd as defaultPluginAdd } from "../../main/plugin-ops";
import { ProcessTerminationError } from "../../main/terminate-process";
import type { CoordinatedUpgrade } from "../../main/coordinated-upgrade";
import type { SnapshotExecutor } from "../../main/snapshot-executor";
import { SNAPSHOT_ID_RE, type SnapshotRuntime } from "../../shared/snapshots";
import { PROFILE_NAME_RE } from "../../shared/types";
import type { WorkbenchPackageRelease } from "../../shared/workbench";
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

const SCHEMA_VERSION = 1;
const MARKER_KIND = "workbench.upgrade";
const DIGEST_ID_LENGTH = 32;
const TAR_TIMEOUT_MS = 15_000;
const MAX_TAR_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_TAR_LIST_BYTES = 256 * 1024;
const PLUGIN_ARCHIVE_PREFIX = "dsh-spaces-plugin";
const VIEW_BRIDGE_ARCHIVE_PREFIX = "dsh-spaces-view-bridge";
/** Packed layout from `packages/plugin/lib/supervisor` (`SUPERVISOR_PAYLOAD_DIRNAME`). */
const SUPERVISOR_PAYLOAD_FILES = [
  "lib/supervisor/manifest.json",
  "lib/supervisor/index.js",
  "lib/supervisor/snapshot-worker.mjs",
] as const;
const PLUGIN_FILES = [
  "package.json",
  "lib/index.js",
  "lib/client.js",
  "lib/typert.host.js",
  "lib/typert.remote-client.js",
  ...SUPERVISOR_PAYLOAD_FILES,
] as const;
const VIEW_BRIDGE_FILES = ["package.json", "lib/index.js", "lib/client.js"] as const;

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

export interface WorkbenchPackageUpgradeOptions {
  home: string;
  managerId: () => string | null;
  pluginArtifact?: string;
  viewBridgeArtifact?: string;
  snapshots: Pick<SnapshotExecutor, "create">;
  upgrades: Pick<CoordinatedUpgrade, "restore" | "recover">;
  currentRuntime: () => SnapshotRuntime;
  stopAll: () => Promise<void>;
  reinitializeManager: () => Promise<void>;
  pluginAdd?: typeof defaultPluginAdd;
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

export class WorkbenchPackageUpgrade {
  private readonly home: string;
  private readonly pluginAdd: typeof defaultPluginAdd;

  constructor(private readonly options: WorkbenchPackageUpgradeOptions) {
    assertNotRealHome(options.home);
    this.home = resolve(options.home);
    this.pluginAdd = options.pluginAdd ?? defaultPluginAdd;
  }

  async describe(): Promise<WorkbenchPackageRelease | undefined> {
    const candidate = await this.readCandidateSilent();
    if (!candidate) return undefined;
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
          ? "This workbench package plan is unfinished and must be recovered first."
          : "Another workbench package plan is unfinished.",
      );
    }

    const managerId = this.requireManagerId();
    const candidate = await this.requireCandidate();
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

      ctx.phase("reinitialize");
      await this.options.reinitializeManager();
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

  private finishSettledMarker(marker: UpgradeMarker): WorkbenchPackageRecovery {
    const settlement = marker.settlement;
    if (!settlement) {
      throw new WorkbenchPackageUpgradeError("unavailable", "The workbench package upgrade record is incomplete.");
    }
    this.writeReceipt(settlement);
    this.clearMarker();
    return publicRecovery(settlement);
  }

  private async installCandidate(managerId: string, artifact: ArtifactInspection): Promise<void> {
    const dest = archiveAbsPath(this.home, artifact.archiveId);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(resolve(artifact.artifact), dest);
    await this.pluginAdd(this.home, managerId, dest);
  }

  private verifyInstalled(managerId: string, candidate: CandidateInspection): void {
    const plugin = this.readInstalledFiles(managerId, candidate.plugin.packageName, PLUGIN_FILES);
    const bridge = this.readInstalledFiles(managerId, candidate.viewBridge.packageName, VIEW_BRIDGE_FILES);
    if (!plugin || !bridge) {
      throw new WorkbenchPackageUpgradeError(
        "failed",
        "Installed workbench packages could not be read back after plugin add.",
      );
    }
    assertSamePackage(plugin, candidate.plugin);
    assertSamePackage(bridge, candidate.viewBridge);
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
    const candidate = await this.readCandidateSilent();
    if (!candidate) {
      throw new WorkbenchPackageUpgradeError(
        "invalid-input",
        "The bound workbench plugin and view-bridge artifacts are missing or not official packages.",
      );
    }
    return candidate;
  }

  private async readCandidateSilent(): Promise<CandidateInspection | undefined> {
    const pluginPath = this.options.pluginArtifact;
    const bridgePath = this.options.viewBridgeArtifact;
    if (!pluginPath || !bridgePath) return undefined;
    try {
      if (!isRealFile(pluginPath) || !isRealFile(bridgePath)) return undefined;
      const [plugin, viewBridge] = await Promise.all([
        inspectArtifact(pluginPath, SPACES_PLUGIN_PACKAGE, PLUGIN_FILES, PLUGIN_ARCHIVE_PREFIX),
        inspectArtifact(bridgePath, VIEW_BRIDGE_PACKAGE, VIEW_BRIDGE_FILES, VIEW_BRIDGE_ARCHIVE_PREFIX),
      ]);
      if (plugin.version !== viewBridge.version) return undefined;
      return {
        version: plugin.version,
        digest: sha256Text(`${plugin.packageName}:${plugin.fileDigest}\n${viewBridge.packageName}:${viewBridge.fileDigest}\n`),
        plugin,
        viewBridge,
      };
    } catch {
      return undefined;
    }
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

  private requireReceipt(planId: string): WorkbenchPackageRecovery {
    const receipt = this.readReceipt(planId);
    if (!receipt) {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package receipt could not be read after settlement.",
      );
    }
    return publicRecovery(receipt);
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

  private assertReceiptMatchesMarker(receipt: UpgradeSettlement, marker: UpgradeMarker): void {
    if (receipt.planId !== marker.planId || receipt.snapshotId !== marker.snapshotId) {
      throw new WorkbenchPackageUpgradeError(
        "unavailable",
        "The workbench package receipt does not match this plan settlement.",
      );
    }
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

function publicRecovery(settlement: UpgradeSettlement): WorkbenchPackageRecovery {
  const result: WorkbenchPackageRecovery = {
    planId: settlement.planId,
    rolledBack: settlement.rolledBack,
    outcome: settlement.outcome,
  };
  if (settlement.snapshotId) result.snapshotId = settlement.snapshotId;
  return result;
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
