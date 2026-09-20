import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { FileLlmSpaceSettings } from "./llm-space-settings";
import type { WorkbenchJobContext } from "./workbench-jobs";
import { atomicWrite } from "../../main/atomic";
import { assertNotRealHome } from "../../main/home-guard";
import { settingsPath } from "../../main/hub-settings";
import {
  loadPluginCatalog,
  readLocalPluginCatalog,
  type CatalogFetcher,
} from "../../main/plugin-catalog";
import { pluginLibraryPath, spacesUsingPlugin } from "../../main/plugin-library";
import {
  downloadPlugin,
  listAllProfilePlugins,
  parseNpmNameAndVersion,
  removeDownloadedPlugin,
  type GitPacker,
  type PluginFetcher,
} from "../../main/plugin-ops";
import {
  assertSafeShareArchive,
  exportSpaceArchive,
  parseSpaceShare,
  previewSpaceShare,
} from "../../main/space-share";
import { listSpaceTemplates, saveSpaceTemplate } from "../../main/space-templates";
import {
  applySpaceRecipe,
  assertMutableRecipeSpaceId,
  publicSpaceTemplate,
  recipeFromShareParts,
  recipeFromTemplate,
} from "../../core/application/space-recipe";
import { parseLlmShareManifest, type LlmShareManifest } from "../../core/domain/llm-share";
import { isUnresolvedPluginAlias } from "../../shared/desktop-controller";
import { t } from "../../shared/i18n";
import type { LlmApiRequest, LlmApiResult } from "../../shared/llm-api";
import { isBareNpmPackageName, isGitSpec, isSafeSpec, matchesPluginQuery } from "../../shared/plugin";
import { isExactRuntimeVersion } from "../../shared/runtime";
import type { SpaceImportResult, SpaceSharePreview } from "../../shared/space-share";
import { assertShareSecretFree } from "../../core/domain/llm-share";
import {
  DEFAULT_HUB_SETTINGS,
  type LocalePreference,
  type PackageSource,
  type PluginLibraryEntry,
  type PluginLibrarySource,
  type ThemePreference,
} from "../../shared/types";
import type { WorkbenchSpace } from "../../shared/workbench";
import {
  MAX_WORKBENCH_SHARE_BASE64,
  MAX_WORKBENCH_SHARE_BYTES,
  WORKBENCH_IMPORT_TTL_MS,
  type WorkbenchHomeSettings,
  type WorkbenchLibraryItem,
  type WorkbenchProductCommand,
  type WorkbenchProductObservation,
  type WorkbenchProductOutcome,
  type WorkbenchProductRequest,
  type WorkbenchProductResult,
  type WorkbenchDiagnostics,
} from "../../shared/workbench-product";

const MAX_PENDING_IMPORTS = 16;
const PLUGIN_LIBRARY_SCHEMA_VERSION = 1;
const PACKAGE_SOURCES = new Set<PackageSource>(["china", "official"]);
const LOCALES = new Set<LocalePreference>(["system", "en", "zh"]);
const THEMES = new Set<ThemePreference>(["system", "light", "dark"]);
const LIBRARY_SOURCES = new Set<PluginLibrarySource>(["catalog", "manual", "installed"]);

export type WorkbenchProductFetcher = CatalogFetcher & PluginFetcher;

export type WorkbenchProductCreateInput = {
  name: string;
  displayName?: string;
  icon?: string;
};

export interface WorkbenchProductPorts {
  home: string;
  observation(): WorkbenchProductObservation;
  managerId(): string | null;
  listSpaces(): WorkbenchSpace[];
  createSpace(input: WorkbenchProductCreateInput, ctx: WorkbenchJobContext): Promise<unknown>;
  installPlugin(spaceId: string, spec: string): Promise<void>;
  llm(request: LlmApiRequest): Promise<LlmApiResult>;
  diagnostics(spaceId: string): WorkbenchDiagnostics;
  withWrite<T>(label: string, action: () => Promise<T>): Promise<T>;
  settingsChanged?(settings: WorkbenchHomeSettings): void;
  now?(): Date;
  fetchImpl?: WorkbenchProductFetcher;
  packGit?: GitPacker;
  writePatch?(spaceId: string, patch: string): void;
  writeLlmShare?(spaceId: string, manifest: LlmShareManifest): Promise<void> | void;
}

interface StagedImport {
  id: string;
  epoch: string;
  archive: Buffer;
  preview: SpaceSharePreview;
  expiresAt: number;
  consumed: boolean;
}

/**
 * Independent product service. The Supervisor later wires the same Home lock
 * and job queue; this module must not create its own queue.
 *
 * Partial failures call `ctx.result({ product, spaceId })` then throw. JobStore
 * still drops `product` in `publicResult` and clears `result` on failed jobs;
 * protocol wiring must keep that safe subset.
 */
export class WorkbenchProductService {
  private readonly ports: WorkbenchProductPorts;
  private readonly imports = new Map<string, StagedImport>();

  constructor(ports: WorkbenchProductPorts) {
    assertNotRealHome(ports.home);
    this.ports = ports;
  }

  async read(request: WorkbenchProductRequest): Promise<WorkbenchProductResult> {
    const observation = this.ports.observation();
    switch (request.method) {
      case "settings":
        return { method: "settings", ...this.readSettings(), observation };
      case "catalog":
        return { method: "catalog", catalog: this.readCatalog(request.query), observation };
      case "library":
        return { method: "library", items: this.readLibrary(), observation };
      case "diagnostics":
        return {
          method: "diagnostics",
          diagnostics: this.ports.diagnostics(request.spaceId),
          observation,
        };
      case "templates":
        return {
          method: "templates",
          templates: listSpaceTemplates(this.ports.home).map(publicSpaceTemplate),
          observation,
        };
      case "share.export":
        return { method: "share.export", ...(await this.exportShare(request.spaceId, request.includeConfig === true)), observation };
      case "share.previewImport":
        return { method: "share.previewImport", ...this.previewImport(request.archiveBase64, observation), observation };
      default: {
        const method = (request as { method: string }).method;
        throw new Error(`Unsupported product request ${method}.`);
      }
    }
  }

  async execute(command: WorkbenchProductCommand, ctx: WorkbenchJobContext): Promise<WorkbenchProductOutcome> {
    return this.ports.withWrite(`product.${command.kind}`, () => this.executeLocked(command, ctx));
  }

  private async executeLocked(
    command: WorkbenchProductCommand,
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchProductOutcome> {
    switch (command.kind) {
      case "settings.update":
        return this.updateSettings(command.settings, ctx);
      case "catalog.refresh":
        return this.refreshCatalog(command.url, ctx);
      case "plugin.download":
        return this.download(command, ctx);
      case "plugin.library.remove":
        return this.removeLibrary(command.libraryId, ctx);
      case "template.save":
        return this.saveTemplate(command, ctx);
      case "template.create":
        return this.createFromTemplate(command, ctx);
      case "space.import":
        return this.importSpace(command, ctx);
      default: {
        const kind = (command as { kind: string }).kind;
        throw new Error(`Unsupported product command ${kind}.`);
      }
    }
  }

  private readSettings(): {
    settings: WorkbenchHomeSettings;
    clientDefaults: { locale: LocalePreference; theme: ThemePreference };
  } {
    const { raw, missing } = readSettingsRecord(this.ports.home);
    if (missing) {
      return {
        settings: {
          portStart: DEFAULT_HUB_SETTINGS.portStart,
          portEnd: DEFAULT_HUB_SETTINGS.portEnd,
          packageSource: DEFAULT_HUB_SETTINGS.packageSource,
          catalogUrl: DEFAULT_HUB_SETTINGS.catalogUrl,
        },
        clientDefaults: { locale: DEFAULT_HUB_SETTINGS.locale, theme: DEFAULT_HUB_SETTINGS.theme },
      };
    }
    return parseHomeSettingsFile(raw);
  }

  private readCatalog(query?: string) {
    const { settings } = this.readSettings();
    const snapshot = readLocalPluginCatalog(this.ports.home, { url: settings.catalogUrl });
    const q = query?.trim() ?? "";
    const entries = q ? snapshot.entries.filter((entry) => matchesPluginQuery(entry, q)) : snapshot.entries;
    return {
      ...snapshot,
      entries,
      meta: { ...snapshot.meta, count: entries.length },
    };
  }

  private readLibrary(): WorkbenchLibraryItem[] {
    const entries = readLibraryOrThrow(this.ports.home);
    const spaceIds = this.ports.listSpaces().map((space) => space.id);
    const installed = listAllProfilePlugins(this.ports.home, spaceIds);
    return entries.map((entry) => publicLibraryItem(entry, spacesUsingPlugin(installed, entry)));
  }

  private async exportShare(spaceId: string, includeConfig: boolean): Promise<{
    fileName: string;
    archiveBase64: string;
    preview: SpaceSharePreview;
  }> {
    this.assertMutableSpace(spaceId, { mustExist: true });
    const space = this.ports.listSpaces().find((row) => row.id === spaceId);
    const shared = await this.ports.llm({ method: "previewShare", spaceId });
    const llm = parseLlmShareManifest(shared);
    const archive = exportSpaceArchive(this.ports.home, spaceId, {
      displayName: space?.displayName || spaceId,
      icon: space?.icon,
      includeConfig,
      llm,
    });
    if (archive.length > MAX_WORKBENCH_SHARE_BYTES) {
      throw new Error("The space share archive is too large.");
    }
    assertSafeShareArchive(archive);
    const preview = previewSpaceShare(archive);
    return {
      fileName: safeShareFileName(space?.displayName || spaceId),
      archiveBase64: archive.toString("base64"),
      preview,
    };
  }

  private previewImport(
    archiveBase64: string,
    observation: WorkbenchProductObservation,
  ): { importId: string; expiresAt: string; preview: SpaceSharePreview } {
    const archive = decodeShareBase64(archiveBase64);
    assertSafeShareArchive(archive);
    const preview = previewSpaceShare(archive);
    const now = this.nowMs();
    this.pruneImports(now);
    if (this.imports.size >= MAX_PENDING_IMPORTS) {
      throw new Error("Too many pending space imports.");
    }
    const id = randomUUID();
    const expiresAt = now + WORKBENCH_IMPORT_TTL_MS;
    this.imports.set(id, {
      id,
      epoch: observation.serviceEpoch,
      archive,
      preview,
      expiresAt,
      consumed: false,
    });
    return { importId: id, expiresAt: new Date(expiresAt).toISOString(), preview };
  }

  private async updateSettings(
    settings: WorkbenchHomeSettings,
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchProductOutcome> {
    const { raw, missing } = readSettingsRecord(this.ports.home);
    if (!missing) parseHomeSettingsFile(raw);
    const next = validateHomeSettings(settings);
    const merged: Record<string, unknown> = missing ? { ...DEFAULT_HUB_SETTINGS } : { ...raw };
    merged.portStart = next.portStart;
    merged.portEnd = next.portEnd;
    merged.packageSource = next.packageSource;
    merged.catalogUrl = next.catalogUrl;
    atomicWrite(settingsPath(this.ports.home), `${JSON.stringify(merged, null, 2)}\n`);
    this.ports.settingsChanged?.(next);
    const outcome: WorkbenchProductOutcome = { kind: "settings.update", settings: next };
    recordProductResult(ctx, outcome);
    return outcome;
  }

  private async refreshCatalog(url: string | undefined, ctx: WorkbenchJobContext): Promise<WorkbenchProductOutcome> {
    const { settings } = this.readSettings();
    const target = url === undefined ? settings.catalogUrl : requireCatalogUrl(url);
    const snapshot = await loadPluginCatalog(this.ports.home, {
      url: target || undefined,
      refresh: true,
      fetchImpl: this.ports.fetchImpl,
    });
    const outcome: WorkbenchProductOutcome = { kind: "catalog.refresh", count: snapshot.entries.length };
    recordProductResult(ctx, outcome);
    return outcome;
  }

  private async download(
    command: Extract<WorkbenchProductCommand, { kind: "plugin.download" }>,
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchProductOutcome> {
    assertSafeDownloadRequest(command);
    readLibraryOrThrow(this.ports.home);
    const entry = await downloadPlugin(
      this.ports.home,
      { catalogId: command.catalogId, spec: command.spec, version: command.version },
      { fetchImpl: this.ports.fetchImpl, packGit: this.ports.packGit },
    );
    const item = this.publicItem(entry);
    const outcome: WorkbenchProductOutcome = { kind: "plugin.download", item };
    recordProductResult(ctx, outcome);
    return outcome;
  }

  private async removeLibrary(libraryId: string, ctx: WorkbenchJobContext): Promise<WorkbenchProductOutcome> {
    if (!libraryId.trim()) throw new Error("A library id is required.");
    readLibraryOrThrow(this.ports.home);
    const spaceIds = this.ports.listSpaces().map((space) => space.id);
    await removeDownloadedPlugin(this.ports.home, libraryId, spaceIds);
    const outcome: WorkbenchProductOutcome = { kind: "plugin.library.remove", libraryId };
    recordProductResult(ctx, outcome);
    return outcome;
  }

  private async saveTemplate(
    command: Extract<WorkbenchProductCommand, { kind: "template.save" }>,
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchProductOutcome> {
    this.assertMutableSpace(command.spaceId, { mustExist: true });
    if (!command.name.trim()) throw new Error("A template name is required.");
    const shared = await this.ports.llm({ method: "previewShare", spaceId: command.spaceId });
    const llm = parseLlmShareManifest(shared);
    const template = saveSpaceTemplate(this.ports.home, command.spaceId, command.name, {
      displayName: command.name,
      now: this.ports.now?.(),
      includeConfig: command.includeConfig === true,
      llm,
    });
    const outcome: WorkbenchProductOutcome = { kind: "template.save", templateId: template.id };
    recordProductResult(ctx, outcome);
    return outcome;
  }

  private async createFromTemplate(
    command: Extract<WorkbenchProductCommand, { kind: "template.create" }>,
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchProductOutcome> {
    const template = listSpaceTemplates(this.ports.home).find((row) => row.id === command.templateId);
    if (!template) throw new Error("That template was not found.");
    this.assertNewSpaceName(command.name);
    const imported = await applySpaceRecipe(recipeFromTemplate(template), this.recipePorts(ctx), {
      name: command.name,
      displayName: command.displayName || template.displayName,
    });
    return this.finishImport("template.create", imported, ctx);
  }

  private async importSpace(
    command: Extract<WorkbenchProductCommand, { kind: "space.import" }>,
    ctx: WorkbenchJobContext,
  ): Promise<WorkbenchProductOutcome> {
    const staged = this.takeImport(command.importId);
    this.assertNewSpaceName(command.name);
    const parsed = parseSpaceShare(staged.archive);
    const imported = await applySpaceRecipe(
      recipeFromShareParts({
        displayName: command.displayName || parsed.manifest.space.displayName,
        icon: parsed.manifest.space.icon,
        plugins: parsed.plugins,
        patch: parsed.patch,
        llm: parsed.llm,
        source: parsed.manifest.source,
      }),
      this.recipePorts(ctx),
      { name: command.name, displayName: command.displayName || parsed.manifest.space.displayName },
    );
    return this.finishImport("space.import", imported, ctx);
  }

  private finishImport(
    kind: "template.create" | "space.import",
    imported: SpaceImportResult,
    ctx: WorkbenchJobContext,
  ): WorkbenchProductOutcome {
    const outcome: WorkbenchProductOutcome = { kind, import: imported };
    if (imported.spaceId) recordProductResult(ctx, outcome, imported.spaceId);
    if (imported.definition !== "imported" || imported.plugins === "failed" || imported.plugins === "not-run") {
      throw new Error(publicImportError(imported));
    }
    if (!imported.spaceId) recordProductResult(ctx, outcome);
    return outcome;
  }

  private takeImport(importId: string): StagedImport {
    const now = this.nowMs();
    const staged = this.imports.get(importId);
    this.pruneImports(now);
    if (!staged) throw new Error("That import is not available.");
    if (staged.consumed) throw new Error("That import was already used.");
    if (staged.expiresAt <= now) {
      this.imports.delete(importId);
      throw new Error("That import has expired.");
    }
    const epoch = this.ports.observation().serviceEpoch;
    if (staged.epoch !== epoch) throw new Error("That import belongs to a previous service run.");
    staged.consumed = true;
    return staged;
  }

  private pruneImports(now: number): void {
    for (const [id, row] of this.imports) {
      if (row.expiresAt <= now) this.imports.delete(id);
    }
  }

  private recipePorts(ctx: WorkbenchJobContext) {
    return {
      createSpace: async (input: { name: string; displayName: string; icon?: string }) => {
        await this.ports.createSpace(input, ctx);
      },
      installPlugin: (spaceId: string, spec: string) => this.ports.installPlugin(spaceId, spec),
      writePatch: this.ports.writePatch ?? ((spaceId: string, patch: string) => {
        atomicWrite(join(this.ports.home, "profiles", spaceId, "cordis.patch.yml"), patch);
      }),
      writeLlmShare: this.ports.writeLlmShare ?? (async (spaceId: string, manifest: LlmShareManifest) => {
        await new FileLlmSpaceSettings(this.ports.home).writeImport(spaceId, manifest);
      }),
    };
  }

  private publicItem(entry: PluginLibraryEntry): WorkbenchLibraryItem {
    const spaceIds = this.ports.listSpaces().map((space) => space.id);
    const installed = listAllProfilePlugins(this.ports.home, spaceIds);
    return publicLibraryItem(entry, spacesUsingPlugin(installed, entry));
  }

  private assertMutableSpace(spaceId: string, options: { mustExist?: boolean } = {}): void {
    assertMutableRecipeSpaceId(spaceId, this.protectedIds());
    if (options.mustExist && !this.ports.listSpaces().some((row) => row.id === spaceId)) {
      throw new Error("That space was not found.");
    }
  }

  private assertNewSpaceName(name: string): void {
    assertMutableRecipeSpaceId(name, this.protectedIds());
    if (this.ports.listSpaces().some((row) => row.id === name)) {
      throw new Error("A space with that name already exists.");
    }
  }

  private protectedIds(): string[] {
    const managerId = this.ports.managerId();
    return managerId ? [managerId] : [];
  }

  private nowMs(): number {
    return (this.ports.now?.() ?? new Date()).getTime();
  }
}

function recordProductResult(
  ctx: WorkbenchJobContext,
  outcome: WorkbenchProductOutcome,
  spaceId?: string,
): void {
  ctx.result(spaceId ? { spaceId, product: outcome } : { product: outcome });
}

function publicImportError(imported: SpaceImportResult): string {
  const detail = imported.errors.find((row) => row.trim()) || "The space import did not complete.";
  if (detail.length > 800) return `${detail.slice(0, 800)}…`;
  return detail;
}

function publicLibraryItem(entry: PluginLibraryEntry, installedIn: string[]): WorkbenchLibraryItem {
  return {
    id: entry.id,
    packageName: entry.packageName,
    title: entry.title,
    version: parseNpmNameAndVersion(entry.spec)?.version ?? null,
    source: entry.source,
    downloadedAt: entry.downloadedAt,
    installedIn,
  };
}

function readLibraryOrThrow(home: string): PluginLibraryEntry[] {
  const path = pluginLibraryPath(home);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Plugin library could not be read. Original bytes were left unchanged: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Plugin library JSON is invalid. Original bytes were left unchanged.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Plugin library JSON is invalid. Original bytes were left unchanged.");
  }
  const row = parsed as { schemaVersion?: unknown; plugins?: unknown };
  if (row.schemaVersion !== undefined && row.schemaVersion !== PLUGIN_LIBRARY_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported plugin library schema ${String(row.schemaVersion)}. Original bytes were left unchanged.`,
    );
  }
  if (!Array.isArray(row.plugins)) {
    throw new Error("Plugin library JSON is invalid. Original bytes were left unchanged.");
  }
  const unique = new Map<string, PluginLibraryEntry>();
  row.plugins.forEach((item, index) => {
    const entry = parseLibraryEntryOrThrow(item, index);
    if (unique.has(entry.id)) {
      throw new Error(`Plugin library has a duplicate id ${entry.id}. Original bytes were left unchanged.`);
    }
    unique.set(entry.id, entry);
  });
  return [...unique.values()];
}

function parseLibraryEntryOrThrow(value: unknown, index: number): PluginLibraryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Plugin library entry ${index} is invalid. Original bytes were left unchanged.`);
  }
  const row = value as Record<string, unknown>;
  const id = requireLibraryString(row, "id", index).toLowerCase();
  const spec = requireLibraryString(row, "spec", index);
  const packageName = requireLibraryString(row, "packageName", index);
  const title = optionalLibraryString(row, "title", index) || packageName;
  const catalogId = optionalLibraryString(row, "catalogId", index)?.toLowerCase();
  const tarball = optionalLibraryString(row, "tarball", index)?.replaceAll("\\", "/");
  const downloadedAt = optionalLibraryString(row, "downloadedAt", index) || new Date(0).toISOString();
  let source: PluginLibrarySource = "manual";
  if (Object.prototype.hasOwnProperty.call(row, "source") && row.source !== undefined) {
    if (typeof row.source !== "string" || !LIBRARY_SOURCES.has(row.source as PluginLibrarySource)) {
      throw new Error(`Plugin library entry ${index} has an invalid source. Original bytes were left unchanged.`);
    }
    source = row.source as PluginLibrarySource;
  }
  assertLibraryPublicField(id, "id", index);
  assertLibraryPublicField(spec, "spec", index);
  assertLibraryPublicField(packageName, "packageName", index);
  assertLibraryPublicField(title, "title", index);
  if (tarball) assertLibraryTarball(tarball, index);
  return {
    id,
    spec,
    packageName,
    title,
    catalogId,
    tarball,
    source,
    downloadedAt,
  };
}

function requireLibraryString(row: Record<string, unknown>, field: string, index: number): string {
  const value = row[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Plugin library entry ${index} is missing ${field}. Original bytes were left unchanged.`);
  }
  return value.trim();
}

function optionalLibraryString(row: Record<string, unknown>, field: string, index: number): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, field) || row[field] === undefined) return undefined;
  if (typeof row[field] !== "string" || !(row[field] as string).trim()) {
    throw new Error(`Plugin library entry ${index} has an invalid ${field}. Original bytes were left unchanged.`);
  }
  return (row[field] as string).trim();
}

function assertLibraryPublicField(value: string, field: string, index: number): void {
  if (
    /:\/\//.test(value) ||
    /\/\/[^/\s]*@/.test(value) ||
    value.startsWith("file:") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\")
  ) {
    throw new Error(`Plugin library entry ${index} ${field} is not allowed. Original bytes were left unchanged.`);
  }
  assertShareSecretFree([{ name: `plugin-library.${field}`, data: value }]);
}

function assertLibraryTarball(tarball: string, index: number): void {
  if (tarball.includes("..") || tarball.startsWith("/") || /^[A-Za-z]:/.test(tarball) || /:\/\//.test(tarball)) {
    throw new Error(`Plugin library entry ${index} tarball is not allowed. Original bytes were left unchanged.`);
  }
  assertShareSecretFree([{ name: "plugin-library.tarball", data: tarball }]);
}

function readSettingsRecord(home: string): { raw: Record<string, unknown>; missing: boolean } {
  const path = settingsPath(home);
  if (!existsSync(path)) return { raw: {}, missing: true };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Home settings could not be read. Original bytes were left unchanged: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid");
    }
    return { raw: parsed as Record<string, unknown>, missing: false };
  } catch {
    throw new Error("Home settings JSON is invalid. Original bytes were left unchanged.");
  }
}

function parseHomeSettingsFile(raw: Record<string, unknown>): {
  settings: WorkbenchHomeSettings;
  clientDefaults: { locale: LocalePreference; theme: ThemePreference };
} {
  const portStart = optionalSettingsField(raw, "portStart", requireExactPort, DEFAULT_HUB_SETTINGS.portStart);
  const portEnd = optionalSettingsField(raw, "portEnd", requireExactPort, DEFAULT_HUB_SETTINGS.portEnd);
  if (portEnd < portStart) throw new Error(t("errors.portEndRange"));
  const settings: WorkbenchHomeSettings = {
    portStart,
    portEnd,
    packageSource: optionalSettingsField(raw, "packageSource", requirePackageSource, DEFAULT_HUB_SETTINGS.packageSource),
    catalogUrl: optionalSettingsField(raw, "catalogUrl", requireCatalogUrl, DEFAULT_HUB_SETTINGS.catalogUrl),
  };
  return {
    settings,
    clientDefaults: {
      locale: optionalSettingsField(raw, "locale", requireLocale, DEFAULT_HUB_SETTINGS.locale),
      theme: optionalSettingsField(raw, "theme", requireTheme, DEFAULT_HUB_SETTINGS.theme),
    },
  };
}

function optionalSettingsField<T>(
  raw: Record<string, unknown>,
  key: string,
  parse: (value: unknown, field: string) => T,
  fallback: T,
): T {
  if (!Object.prototype.hasOwnProperty.call(raw, key) || raw[key] === undefined) return fallback;
  return parse(raw[key], key);
}

function requireExactPort(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Home settings ${field} is invalid. Original bytes were left unchanged.`);
  }
  if (value < 1024 || value > 65535) throw new Error(t("errors.portBounds"));
  return value;
}

function requirePackageSource(value: unknown, field: string): PackageSource {
  if (typeof value !== "string" || !PACKAGE_SOURCES.has(value as PackageSource)) {
    throw new Error(`Home settings ${field} is invalid. Original bytes were left unchanged.`);
  }
  return value as PackageSource;
}

function requireLocale(value: unknown, field: string): LocalePreference {
  if (typeof value !== "string" || !LOCALES.has(value as LocalePreference)) {
    throw new Error(`Home settings ${field} is invalid. Original bytes were left unchanged.`);
  }
  return value as LocalePreference;
}

function requireTheme(value: unknown, field: string): ThemePreference {
  if (typeof value !== "string" || !THEMES.has(value as ThemePreference)) {
    throw new Error(`Home settings ${field} is invalid. Original bytes were left unchanged.`);
  }
  return value as ThemePreference;
}

function validateHomeSettings(settings: WorkbenchHomeSettings): WorkbenchHomeSettings {
  const portStart = requireExactPort(settings.portStart, "portStart");
  const portEnd = requireExactPort(settings.portEnd, "portEnd");
  if (portEnd < portStart) throw new Error(t("errors.portEndRange"));
  return {
    portStart,
    portEnd,
    packageSource: requirePackageSource(settings.packageSource, "packageSource"),
    catalogUrl: requireCatalogUrl(settings.catalogUrl),
  };
}

function requireCatalogUrl(value: unknown, _field = "catalogUrl"): string {
  if (typeof value !== "string") throw new Error("Catalog URL must be https.");
  const trimmed = value.trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Catalog URL must be https.");
  }
  if (parsed.protocol !== "https:") throw new Error("Catalog URL must be https.");
  return trimmed;
}

function assertSafeDownloadRequest(command: Extract<WorkbenchProductCommand, { kind: "plugin.download" }>): void {
  if (!command.catalogId && !command.spec) {
    throw new Error("A catalog id or plugin spec is required.");
  }
  if (command.version && !isExactRuntimeVersion(command.version)) {
    throw new Error("Plugin download requires an exact version.");
  }
  if (command.spec) assertSafeDownloadSpec(command.spec);
}

function assertSafeDownloadSpec(spec: string): void {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("A plugin spec is required.");
  if (/[;|&`$<>\s]/.test(trimmed)) {
    throw new Error("Plugin download does not accept shell commands.");
  }
  if (isGitSpec(trimmed)) {
    if (!isSafeSpec(trimmed)) throw new Error("That plugin spec is not allowed.");
    return;
  }
  if (
    isUnresolvedPluginAlias(trimmed) ||
    /:\/\//.test(trimmed) ||
    /\/\/[^/\s]*@/.test(trimmed) ||
    (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith("@"))
  ) {
    throw new Error("Plugin download does not accept URLs, credentials, or local paths.");
  }
  if (isAbsolute(trimmed) || trimmed.startsWith(".") || trimmed.includes("\\")) {
    throw new Error("Plugin download does not accept URLs, credentials, or local paths.");
  }
  if (!isSafeSpec(trimmed) || (!isBareNpmPackageName(trimmed) && !parseNpmNameAndVersion(trimmed))) {
    throw new Error("That plugin spec is not allowed.");
  }
}

function decodeShareBase64(value: string): Buffer {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("The space share archive is not valid base64.");
  }
  const cleaned = value.replace(/\s/g, "");
  if (cleaned.length > MAX_WORKBENCH_SHARE_BASE64) {
    throw new Error("The space share archive is too large.");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new Error("The space share archive is not valid base64.");
  }
  const archive = Buffer.from(cleaned, "base64");
  const roundTrip = archive.toString("base64").replace(/=+$/, "");
  if (roundTrip !== cleaned.replace(/=+$/, "")) {
    throw new Error("The space share archive is not valid base64.");
  }
  if (archive.length > MAX_WORKBENCH_SHARE_BYTES) {
    throw new Error("The space share archive is too large.");
  }
  return archive;
}

function safeShareFileName(displayName: string): string {
  const slug =
    displayName
      .normalize("NFKC")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "space";
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) return "space.dshspace";
  return `${slug}.dshspace`;
}
