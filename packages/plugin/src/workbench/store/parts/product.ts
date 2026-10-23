/**
 * The product reads of the workbench client.
 *
 * This part owns what the client reads from the supervisor: the plugin
 * catalog, the library, the snapshots, the runtimes, the settings, the logs,
 * the templates and the space detail. The code moves unchanged from
 * `workbench/store.ts`.
 */

import type { WorkbenchPlugin } from "../../../../../../src/shared/workbench";
import type { WorkbenchDiagnostics } from "../../../../../../src/shared/workbench-product";
import type { WorkbenchLogEntry } from "../../../../../../src/shared/workbench-log";
import { localizeError } from "../../i18n";
import { createWorkbenchLlmClient, type LlmUiClient, type LlmUiSpace } from "../../llm/client";
import { errorCode, wrongProduct } from "../errors";
import type { WorkbenchUiState } from "../types";
import { JobPart } from "./jobs";

export abstract class ProductPart extends JobPart {
  protected cachedLlmClient: LlmUiClient | null = null;

  llmClient = (): LlmUiClient => {
    this.cachedLlmClient ??= createWorkbenchLlmClient(this.api, this.env.uuid);
    return this.cachedLlmClient;
  };

  llmSpaces = (): LlmUiSpace[] => {
    const epoch = this.ui.state?.serviceEpoch ?? "";
    return (this.ui.state?.spaces ?? []).map((space) => ({
      spaceId: space.id,
      displayName: space.displayName,
      status: space.status,
      generation: space.generation,
      serviceEpoch: epoch,
    }));
  };

  setPluginQuery = (pluginQuery: string): void => this.patch({ pluginQuery });

  setPluginSpace = (pluginSpaceId: string): void => this.patch({ pluginSpaceId });

  setPluginCatalog = (pluginCatalogId: string, pluginVersion?: string): void => {
    this.patch({
      pluginCatalogId,
      pluginVersion: pluginVersion ?? "",
    });
    // Picking an entry reads its published versions again: the previous read
    // belongs to another entry and a failed read may be retried by picking
    // the entry once more.
    void this.loadPluginVersions(pluginCatalogId, true);
  };

  setPluginVersion = (pluginVersion: string): void => this.patch({ pluginVersion });

  setPluginSpec = (pluginSpec: string): void => this.patch({ pluginSpec });

  /**
   * Read the published versions of one catalog entry.
   *
   * One request per entry, no retry. A failed read keeps its reason next to
   * the version list instead of offering a guessed version.
   */
  loadPluginVersions = (catalogId: string, force = false): Promise<void> => {
    const key = catalogId.trim().toLowerCase();
    if (!key) return Promise.resolve();
    const known = this.ui.pluginVersions[key];
    if (!force && known && known.status !== "error") return Promise.resolve();
    const cycle = this.cycle;
    this.patch({
      pluginVersions: {
        ...this.ui.pluginVersions,
        [key]: { catalogId: key, packageName: "", versions: [], latest: null, status: "loading", error: null },
      },
    });
    return this.wrap(async () => {
      const result = await this.api.product({ method: "plugin.versions", catalogId: key });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "plugin.versions") {
        throw wrongProduct("plugin.versions", result.method);
      }
      const selected = this.ui.pluginCatalogId.trim().toLowerCase();
      this.patch({
        pluginVersions: {
          ...this.ui.pluginVersions,
          [key]: {
            catalogId: key,
            packageName: result.packageName,
            versions: result.versions,
            latest: result.latest,
            status: "ready",
            error: null,
          },
        },
        // The selected entry starts at its newest version. Another entry keeps
        // the version the user chose for the selected one.
        pluginVersion: selected === key && !this.ui.pluginVersion ? (result.latest ?? "") : this.ui.pluginVersion,
      });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({
        pluginVersions: {
          ...this.ui.pluginVersions,
          [key]: { catalogId: key, packageName: "", versions: [], latest: null, status: "error", error: message },
        },
      });
    });
  };

  searchPlugins = (query: string): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ pluginQuery: query, pluginsStatus: "loading", readError: this.readErrors("plugins") });
    return this.wrap(async () => {
      const plugins = await this.api.plugins(query);
      if (!this.stillOpen(cycle)) return;
      this.patch({ plugins: Array.isArray(plugins) ? plugins : [], pluginsStatus: "ready", readError: this.readErrors("plugins") });
      this.loadSpacePluginVersions(this.ui.plugins);
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ pluginsStatus: "error", readError: this.readErrors("plugins", message) });
    });
  };

  /**
   * Read the published versions of the plugins this space has.
   *
   * The upgrade row needs them, and the read belongs to the store: the space
   * detail page renders whatever the store knows.
   */
  protected loadSpacePluginVersions(plugins: WorkbenchPlugin[]): void {
    const spaceId = this.ui.pluginSpaceId;
    if (!spaceId) return;
    for (const plugin of plugins) {
      if (!plugin.installedIn.includes(spaceId)) continue;
      void this.loadPluginVersions(plugin.packageName);
    }
  }

  loadCatalog = (query?: string): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ catalogStatus: "loading", readError: this.readErrors("catalog") });
    return this.wrap(async () => {
      const result = await this.api.product({ method: "catalog", query: query ?? this.ui.pluginQuery });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "catalog") {
        throw wrongProduct("catalog", result.method);
      }
      this.patch({ catalog: result.catalog, catalogStatus: "ready", readError: this.readErrors("catalog") });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ catalogStatus: "error", catalog: this.ui.catalog, readError: this.readErrors("catalog", message) });
    });
  };

  loadLibrary = (): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ libraryStatus: "loading", readError: this.readErrors("library") });
    return this.wrap(async () => {
      const result = await this.api.product({ method: "library" });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "library") {
        throw wrongProduct("library", result.method);
      }
      this.patch({ library: result.items, libraryStatus: "ready", readError: this.readErrors("library") });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ libraryStatus: "error", readError: this.readErrors("library", message) });
    });
  };

  loadSnapshots = (): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ snapshotsStatus: "loading", readError: this.readErrors("snapshots") });
    return this.wrap(async () => {
      const snapshots = await this.api.snapshots();
      if (!this.stillOpen(cycle)) return;
      this.patch({ snapshots: Array.isArray(snapshots) ? snapshots : [], snapshotsStatus: "ready", readError: this.readErrors("snapshots") });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ snapshotsStatus: "error", readError: this.readErrors("snapshots", message) });
    });
  };

  loadRuntimes = (): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ runtimesStatus: "loading", readError: this.readErrors("runtimes") });
    return this.wrap(async () => {
      const runtimes = await this.api.runtimes();
      if (!this.stillOpen(cycle)) return;
      this.patch({ runtimes: Array.isArray(runtimes) ? runtimes : [], runtimesStatus: "ready", readError: this.readErrors("runtimes") });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ runtimesStatus: "error", readError: this.readErrors("runtimes", message) });
    });
  };

  loadSettings = (): Promise<void> => {
    if (this.ui.settingsDraft?.dirty) return Promise.resolve();
    const cycle = this.cycle;
    this.patch({ settingsStatus: "loading", readError: this.readErrors("settings") });
    return this.wrap(async () => {
      const result = await this.api.product({ method: "settings" });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "settings") {
        throw wrongProduct("settings", result.method);
      }
      if (this.ui.settingsDraft?.dirty) return;
      this.applyClientDefaults(result.clientDefaults);
      this.patch({
        settingsDraft: { settings: result.settings, observation: result.observation, dirty: false },
        settingsStatus: "ready",
        readError: this.readErrors("settings"),
      });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ settingsStatus: "error", readError: this.readErrors("settings", message) });
    });
  };

  loadLogs = (): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ logsStatus: "loading", readError: this.readErrors("logs") });
    return this.wrap(async () => {
      const result = await this.api.product({ method: "logs" });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "logs") throw wrongProduct("logs", result.method);
      this.patch({
        logs: result.entries,
        logsError: result.logError,
        logsStatus: "ready",
        readError: this.readErrors("logs"),
      });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ logsStatus: "error", readError: this.readErrors("logs", message) });
    });
  };

  copyWorkbenchLog = (): string => {
    return this.ui.logs
      .map((entry) => [entry.at, entry.level, entry.area, entry.event, entry.code, entry.message].filter(Boolean).join(" "))
      .join("\n");
  };

  protected lastLocalLog = "";

  protected persistLocalLog(message: string): void {
    if (!message || message === this.lastLocalLog) return;
    this.lastLocalLog = message;
    const entry: WorkbenchLogEntry = {
      at: new Date().toISOString(),
      level: "error",
      area: "client",
      event: "request",
      message,
    };
    void this.api.product({ method: "log.record", level: "error", area: "client", event: "request", message }).then(
      (result) => {
        if (!this.running || result.method !== "logs") return;
        this.patch({ logs: result.entries, logsError: result.logError, logsStatus: "ready" });
      },
      () => {
        if (!this.running) return;
        this.patch({ logs: [...this.ui.logs, entry].slice(-400) });
      },
    );
  };

  loadTemplates = (): Promise<void> => {
    const cycle = this.cycle;
    this.patch({ templatesStatus: "loading", readError: this.readErrors("templates") });
    return this.wrap(async () => {
      const result = await this.api.product({ method: "templates" });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "templates") {
        throw wrongProduct("templates", result.method);
      }
      const templates = result.templates;
      const templateId = this.ui.templateId && templates.some((row) => row.id === this.ui.templateId)
        ? this.ui.templateId
        : templates[0]?.id ?? "";
      const workspaces = this.workspaceSpaces();
      const templateSpaceId =
        this.ui.templateSpaceId && workspaces.some((space) => space.id === this.ui.templateSpaceId)
          ? this.ui.templateSpaceId
          : workspaces[0]?.id ?? "";
      const shareSpaceId =
        this.ui.shareSpaceId && workspaces.some((space) => space.id === this.ui.shareSpaceId)
          ? this.ui.shareSpaceId
          : workspaces[0]?.id ?? "";
      this.patch({
        templates,
        templatesStatus: "ready",
        templateId,
        templateSpaceId,
        shareSpaceId,
        readError: this.readErrors("templates"),
      });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ templatesStatus: "error", readError: this.readErrors("templates", message) });
    });
  };

  setTemplateId = (templateId: string): void => this.patch({ templateId });

  setTemplateName = (templateName: string): void => this.patch({ templateName });

  setTemplateDisplayName = (templateDisplayName: string): void => this.patch({ templateDisplayName });

  setTemplateSpaceId = (templateSpaceId: string): void => this.patch({ templateSpaceId });

  setTemplateIncludeConfig = (templateIncludeConfig: boolean): void => this.patch({ templateIncludeConfig });

  setShareSpaceId = (shareSpaceId: string): void => this.patch({ shareSpaceId });

  setShareIncludeConfig = (shareIncludeConfig: boolean): void => this.patch({ shareIncludeConfig });

  setImportName = (importName: string): void => this.patch({ importName });

  setImportDisplayName = (importDisplayName: string): void => this.patch({ importDisplayName });

  copyDiagnostics = (): string => {
    const diag = this.ui.diagnostics;
    const lines = [
      diag?.lastError,
      ...(diag?.logs ?? []).map((entry) => `${entry.at} ${entry.channel} ${entry.text}`),
      diag?.logError,
    ].filter((line): line is string => Boolean(line));
    return lines.join("\n");
  };

  loadDetail = (spaceId: string): Promise<void> => {
    const cycle = this.cycle;
    const cleared = this.readErrors("detail");
    delete cleared.diagnostics;
    this.patch({ detailStatus: "loading", diagnosticsStatus: "loading", diagnostics: null, readError: cleared });
    return this.wrap(async () => {
      const [detailResult, backupsResult, diagResult] = await Promise.allSettled([
        this.api.detail(spaceId),
        this.api.backups(spaceId),
        this.api.product({ method: "diagnostics", spaceId }),
      ]);
      if (!this.stillOpen(cycle)) return;
      const backups = backupsResult.status === "fulfilled" && Array.isArray(backupsResult.value)
        ? backupsResult.value
        : [];
      let diagnostics: WorkbenchDiagnostics | null = null;
      let diagnosticsStatus: WorkbenchUiState["diagnosticsStatus"] = "error";
      let diagnosticsMessage: string | undefined;
      if (diagResult.status === "fulfilled" && diagResult.value.method === "diagnostics") {
        diagnostics = diagResult.value.diagnostics;
        diagnosticsStatus = "ready";
      } else if (diagResult.status === "rejected") {
        diagnosticsMessage = localizeError(this.ui.locale, errorCode(diagResult.reason));
      } else if (diagResult.status === "fulfilled") {
        diagnosticsMessage = localizeError(this.ui.locale, errorCode(wrongProduct("diagnostics", diagResult.value.method)));
      }
      const detailParts: string[] = [];
      if (detailResult.status !== "fulfilled") {
        detailParts.push(localizeError(this.ui.locale, errorCode(detailResult.reason)));
      }
      if (backupsResult.status === "rejected") {
        detailParts.push(localizeError(this.ui.locale, errorCode(backupsResult.reason)));
      }
      const readError = { ...this.ui.readError };
      delete readError.detail;
      delete readError.diagnostics;
      if (diagnosticsMessage) readError.diagnostics = diagnosticsMessage;
      if (detailParts.length > 0) readError.detail = detailParts.join("\n");
      this.patch({
        detail: detailResult.status === "fulfilled" ? detailResult.value : null,
        backups,
        diagnostics,
        diagnosticsStatus,
        detailStatus: detailResult.status === "fulfilled" ? "ready" : "error",
        readError,
      });
    }, (message) => {
      if (!this.stillOpen(cycle)) return;
      this.patch({ detailStatus: "error", readError: this.readErrors("detail", message) });
    });
  };
}
