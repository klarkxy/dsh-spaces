/**
 * The overlays and navigation surfaces of the workbench client.
 *
 * This part owns the dialogs, the settings tabs and the space detail page.
 * The code moves unchanged from `workbench/store.ts`.
 */

import { localizeError } from "../../i18n";
import { errorCode } from "../errors";
import { isSettingsOverlay, type CreateDialogMode, type HomeTab, type OverlayKind, type WorkbenchUiState } from "../types";
import { NavigationPart } from "./navigation";

export abstract class OverlayPart extends NavigationPart {
  protected hasSettingsUnderlay(): boolean {
    return isSettingsOverlay(this.ui.overlay);
  }

  protected restoreOverlay(): OverlayKind {
    return this.hasSettingsUnderlay() ? { type: "settings" } : null;
  }

  openCreate = (options?: { mode?: CreateDialogMode; templateId?: string } | unknown): void => {
    if (!this.canMutate()) {
      this.patch({ commandError: localizeError(this.ui.locale, "workbench/read-only"), requestOrigin: null });
      return;
    }
    const opts =
      options && typeof options === "object" && !("nativeEvent" in options)
        ? (options as { mode?: CreateDialogMode; templateId?: string })
        : undefined;
    const overSettings = this.hasSettingsUnderlay();
    const mode = opts?.mode ?? (opts?.templateId ? "template" : "blank");
    this.clearRequestError();
    this.patch({
      ...(opts?.templateId ? { templateId: opts.templateId } : {}),
      overlay: {
        type: "create",
        mode,
        ...(opts?.templateId ? { templateId: opts.templateId } : {}),
        ...(overSettings ? { overSettings: true } : {}),
      },
    });
    if (this.ui.templatesStatus === "idle") void this.loadTemplates();
  };

  openRename = (spaceId: string): void => {
    if (!this.canMutate()) return this.rejectReadonly();
    const overSettings = this.hasSettingsUnderlay();
    this.clearRequestError();
    this.patch({ overlay: { type: "rename", spaceId, ...(overSettings ? { overSettings: true } : {}) } });
  };

  openIcon = (spaceId: string): void => {
    if (!this.canMutate()) return this.rejectReadonly();
    const overSettings = this.hasSettingsUnderlay();
    this.clearRequestError();
    this.patch({ overlay: { type: "icon", spaceId, ...(overSettings ? { overSettings: true } : {}) } });
  };

  openSaveTemplate = (spaceId: string): void => {
    if (!this.canMutate()) return this.rejectReadonly();
    if (this.isManagerId(spaceId) || spaceId === "web") return;
    const overSettings = this.hasSettingsUnderlay();
    const space = this.space(spaceId);
    this.clearRequestError();
    this.patch({
      templateSpaceId: spaceId,
      templateName: space?.displayName ?? "",
      overlay: { type: "save-template", spaceId, ...(overSettings ? { overSettings: true } : {}) },
    });
  };

  openExportShare = (spaceId: string): void => {
    if (this.isManagerId(spaceId) || spaceId === "web") return;
    const overSettings = this.hasSettingsUnderlay();
    this.clearRequestError();
    this.patch({
      shareSpaceId: spaceId,
      overlay: { type: "export-share", spaceId, ...(overSettings ? { overSettings: true } : {}) },
    });
  };

  openSettings = (): void => {
    this.clearRequestError();
    this.patch({ overlay: { type: "settings" }, settingsTab: "general", detailSpaceId: null });
    void this.loadSettings();
  };

  setSettingsTab = (settingsTab: WorkbenchUiState["settingsTab"]): void => {
    if (settingsTab === "advanced") {
      this.clearRequestError();
      this.patch({
        homeTab: "overview",
        settingsTab: "advanced",
        overlay: { type: "settings" },
      });
      void this.loadLogs();
      if (this.ui.snapshotsStatus === "idle") void this.loadSnapshots();
      if (this.ui.runtimesStatus === "idle") void this.loadRuntimes();
      return;
    }
    if (settingsTab !== "general") {
      this.setHomeTab(settingsTab);
      return;
    }
    this.clearRequestError();
    this.patch({ settingsTab: "general", detailSpaceId: null });
    if (this.ui.settingsStatus === "idle") void this.loadSettings();
  };

  setHomeTab = (homeTab: HomeTab): void => {
    this.clearRequestError();
    // The plugin tab is not a top-level destination any more: it is the
    // plugin section of the space detail page.
    if (homeTab === "plugins") {
      const spaceId = this.ui.pluginSpaceId || this.workspaceSpaces()[0]?.id;
      if (spaceId) {
        this.openDetail(spaceId);
        return;
      }
    }
    const canonical: HomeTab =
      homeTab === "snapshots" || homeTab === "runtime" ? "overview" : homeTab;
    this.patch({
      homeTab: canonical,
      settingsTab: homeTab,
      detailSpaceId: canonical === "spaces" ? null : this.ui.detailSpaceId,
      overlay: { type: "settings" },
    });
    if (canonical === "plugins") {
      if (this.ui.pluginsStatus === "idle") void this.searchPlugins(this.ui.pluginQuery);
      if (this.ui.catalogStatus === "idle") void this.loadCatalog(this.ui.pluginQuery);
      if (this.ui.libraryStatus === "idle") void this.loadLibrary();
    }
    if (canonical === "templates" && this.ui.templatesStatus === "idle") void this.loadTemplates();
    if (canonical === "overview") {
      void this.loadLogs();
      if (this.ui.snapshotsStatus === "idle") void this.loadSnapshots();
      if (this.ui.runtimesStatus === "idle") void this.loadRuntimes();
    }
  };

  /** The maintenance group of the settings navigation. It stays expanded while one of its tabs is open. */
  toggleMaintenance = (): void => {
    this.patch({ maintenanceExpanded: !this.ui.maintenanceExpanded });
  };

  /**
   * Open the detail page of one space.
   *
   * The detail page lives inside the settings surface (the spaces tab), so it
   * replaces the old detail dialog: the space id, its status, its appearance,
   * its plugins, its model binding, its DSH version, its diagnostics and its
   * destructive actions have exactly one authoritative place.
   */
  openDetail = (spaceId: string): void => {
    this.clearRequestError();
    this.patch({
      overlay: { type: "settings" },
      settingsTab: "spaces",
      homeTab: "spaces",
      detailSpaceId: spaceId,
      pluginSpaceId: spaceId,
    });
    void this.loadDetail(spaceId);
    if (this.ui.runtimesStatus === "idle") void this.loadRuntimes();
    if (this.ui.pluginsStatus === "idle") void this.searchPlugins(this.ui.pluginQuery);
    else this.loadSpacePluginVersions(this.ui.plugins);
    if (this.ui.catalogStatus === "idle") void this.loadCatalog(this.ui.pluginQuery);
    if (this.ui.libraryStatus === "idle") void this.loadLibrary();
  };

  /** Re-read the open space's detail, diagnostics and installed plugins on demand. */
  refreshSpaceDetail = (spaceId: string): void => {
    this.clearRequestError();
    void this.loadDetail(spaceId);
    void this.searchPlugins(this.ui.pluginQuery);
  };

  /** Leave the space detail page and show the space list again. */
  closeDetail = (): void => {
    this.patch({ detailSpaceId: null });
  };

  openMenu = (spaceId: string, x: number, y: number): void => {
    const overSettings = this.hasSettingsUnderlay();
    this.patch({ overlay: { type: "menu", spaceId, x, y, ...(overSettings ? { overSettings: true } : {}) } });
  };

  closeOverlay = (): void => {
    const next =
      this.ui.overlay &&
      this.ui.overlay.type !== "settings" &&
      "overSettings" in this.ui.overlay &&
      this.ui.overlay.overSettings
        ? ({ type: "settings" } as const)
        : null;
    this.clearRequestError();
    this.patch({ overlay: next, planError: null });
  };

  closePlan = (): void => this.patch({ pendingPlan: null, planError: null, requestOrigin: null });

  closeImport = (): void => {
    const next =
      this.ui.overlay?.type === "import" && this.ui.overlay.overSettings
        ? ({ type: "settings" } as const)
        : null;
    this.clearRequestError();
    this.patch({ overlay: next, importPreview: null, planError: null });
  };

  reportFailure = (error: unknown): void => {
    this.patch({ commandError: localizeError(this.ui.locale, errorCode(error)) });
  };
}
