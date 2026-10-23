/**
 * The overlays and navigation surfaces of the workbench client.
 *
 * This part owns the dialogs, the settings tabs and the space detail page.
 * The code moves unchanged from `workbench/store.ts`.
 */

import { localizeError } from "../../i18n";
import { errorCode } from "../errors";
import type { HomeTab, WorkbenchUiState } from "../types";
import { NavigationPart } from "./navigation";

export abstract class OverlayPart extends NavigationPart {
  openCreate = (): void => {
    if (!this.canMutate()) {
      this.patch({ commandError: localizeError(this.ui.locale, "workbench/read-only"), requestOrigin: null });
      return;
    }
    this.clearRequestError();
    this.patch({ overlay: { type: "create" } });
  };

  openRename = (spaceId: string): void => {
    if (!this.canMutate()) return this.rejectReadonly();
    this.clearRequestError();
    this.patch({ overlay: { type: "rename", spaceId } });
  };

  openIcon = (spaceId: string): void => {
    if (!this.canMutate()) return this.rejectReadonly();
    this.clearRequestError();
    this.patch({ overlay: { type: "icon", spaceId } });
  };

  openSettings = (): void => {
    this.clearRequestError();
    this.patch({ overlay: { type: "settings" }, settingsTab: "general" });
    void this.loadSettings();
  };

  setSettingsTab = (settingsTab: WorkbenchUiState["settingsTab"]): void => {
    if (settingsTab !== "general" && settingsTab !== "llm" && settingsTab !== "advanced") {
      this.setHomeTab(settingsTab);
      return;
    }
    this.clearRequestError();
    this.patch({ settingsTab, detailSpaceId: null });
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
    this.patch({
      homeTab,
      settingsTab: homeTab,
      detailSpaceId: homeTab === "spaces" ? null : this.ui.detailSpaceId,
      overlay: { type: "settings" },
    });
    if (homeTab === "plugins") {
      if (this.ui.pluginsStatus === "idle") void this.searchPlugins(this.ui.pluginQuery);
      if (this.ui.catalogStatus === "idle") void this.loadCatalog(this.ui.pluginQuery);
      if (this.ui.libraryStatus === "idle") void this.loadLibrary();
    }
    if (homeTab === "snapshots" && this.ui.snapshotsStatus === "idle") void this.loadSnapshots();
    if (homeTab === "runtime" && this.ui.runtimesStatus === "idle") void this.loadRuntimes();
    if (homeTab === "templates" && this.ui.templatesStatus === "idle") void this.loadTemplates();
    if (homeTab === "overview") void this.loadLogs();
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

  /** Leave the space detail page and show the space list again. */
  closeDetail = (): void => {
    this.patch({ detailSpaceId: null });
  };

  openMenu = (spaceId: string, x: number, y: number): void => {
    this.patch({ overlay: { type: "menu", spaceId, x, y } });
  };

  closeOverlay = (): void => {
    this.clearRequestError();
    this.patch({ overlay: null, planError: null });
  };

  closePlan = (): void => this.patch({ pendingPlan: null, planError: null, requestOrigin: null });

  closeImport = (): void => {
    this.clearRequestError();
    this.patch({ overlay: null, importPreview: null, planError: null });
  };

  reportFailure = (error: unknown): void => {
    this.patch({ commandError: localizeError(this.ui.locale, errorCode(error)) });
  };
}
