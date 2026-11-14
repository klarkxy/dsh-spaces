/**
 * The command dispatch of the workbench client.
 *
 * This part turns a user action into a workbench command: the create, rename,
 * reorder, template, share and import flows. The code moves unchanged from
 * `workbench/store.ts`.
 */

import type { WorkbenchPlanRequest } from "../../../../../../src/shared/workbench";
import { MAX_WORKBENCH_SHARE_BASE64, type WorkbenchHomeSettings } from "../../../../../../src/shared/workbench-product";
import { localizeError } from "../../i18n";
import { validateWorkbenchIcon } from "../../icons";
import { NAME_RE, RESERVED } from "../constants";
import { wrongProduct } from "../errors";
import { workbenchRequestOrigin } from "../origin";
import { OverlayPart } from "./overlays";

export abstract class CommandPart extends OverlayPart {
  createSpace = (input: { name: string; displayName?: string; icon?: string; modelSource?: 'main'|'local'; browser?: boolean; base?: 'web'|'browser'; baseVersion?: string; startAfterCreate?: boolean }): void => {
    const name = input.name.trim().toLowerCase();
    // The create dialog owns the failure of its own form.
    const origin = this.ui.overlay?.type === "create" ? "create" : null;
    if (!NAME_RE.test(name)) {
      this.patch({ commandError: this.msg("app.nameInvalid"), requestOrigin: origin });
      return;
    }
    if (RESERVED.has(name)) {
      this.patch({ commandError: this.msg("app.nameReserved"), requestOrigin: origin });
      return;
    }
    const icon = validateWorkbenchIcon(input.icon);
    if (!icon.ok) {
      this.patch({ commandError: this.msg(icon.reason === "too-large" ? "app.iconTooLarge" : "app.iconInvalid"), requestOrigin: origin });
      return;
    }
    const restore = this.restoreOverlay();
    void this.submit(
      {
        kind: "space.create",
        input: {
          name,
          ...(input.base === undefined ? {} : { base: input.base }),
          ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
          displayName: input.displayName?.trim() || undefined,
          icon: icon.icon || undefined,
          ...(input.modelSource === undefined ? {} : { modelSource: input.modelSource }),
          ...(input.browser ? { browser: true } : {}),
        },
      },
      {
        origin,
        autoEnter: input.startAfterCreate !== false,
        // The dialog closes when the request is accepted. A failed job keeps it
        // open with the reason next to the form.
        onJob: (job) => {
          if (job.status === "failed") {
            this.patch({ commandError: localizeError(this.ui.locale, job.error ?? { code: "workbench/failed" }) });
            return;
          }
          this.patch({ overlay: this.ui.overlay?.type === "create" ? restore : this.ui.overlay });
        },
      },
    );
  };

  updateSpace = (spaceId: string, patch: { displayName?: string; icon?: string; startWithDesktop?: boolean }): void => {
    if (patch.icon !== undefined) {
      const icon = validateWorkbenchIcon(patch.icon);
      if (!icon.ok) {
        this.patch({ commandError: this.msg(icon.reason === "too-large" ? "app.iconTooLarge" : "app.iconInvalid"), requestOrigin: this.updateOrigin(spaceId) });
        return;
      }
      patch = { ...patch, icon: icon.icon };
    }
    const dialog = this.ui.overlay?.type === "rename" || this.ui.overlay?.type === "icon" ? this.ui.overlay.type : null;
    const restore = this.restoreOverlay();
    void this.submit({ kind: "space.update", spaceId, ...patch }, {
      origin: this.updateOrigin(spaceId),
      // Like the create dialog, the rename and icon dialogs close only once the
      // request is accepted; a failure keeps them open with the reason inside.
      // The detail page stays open either way.
      onJob: (job) => {
        if (job.status === "failed") {
          this.patch({ commandError: localizeError(this.ui.locale, job.error ?? { code: "workbench/failed" }) });
          return;
        }
        if (dialog && this.ui.overlay?.type === dialog) this.patch({ overlay: restore });
      },
    });
  };

  moveSpace = (spaceId: string, direction: -1 | 1): void => {
    const ids = this.workspaceIds();
    const index = ids.indexOf(spaceId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ids.length) return;
    const copy = [...ids];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    const managerId = this.ui.state?.managerId;
    const spaceIds = managerId && !copy.includes(managerId) ? [managerId, ...copy] : copy;
    void this.submit({ kind: "space.reorder", spaceIds }, { origin: workbenchRequestOrigin(this.ui, { kind: "space.reorder" }) });
  };

  refreshCatalog = (): void => {
    const url = this.ui.settingsDraft?.settings.catalogUrl?.trim();
    void this.submit({ kind: "catalog.refresh", ...(url ? { url } : {}) }, { origin: workbenchRequestOrigin(this.ui, { kind: "catalog.refresh" }) });
  };

  downloadPlugin = (): void => {
    const catalogId = this.ui.pluginCatalogId.trim();
    const spec = this.ui.pluginSpec.trim();
    const version = this.ui.pluginVersion.trim();
    if (!catalogId && !spec) {
      this.patch({ commandError: this.msg("plugins.needDownload") });
      return;
    }
    void this.submit(
      {
        kind: "plugin.download",
        ...(catalogId ? { catalogId } : {}),
        ...(spec ? { spec } : {}),
        ...(version ? { version } : {}),
      },
      { origin: workbenchRequestOrigin(this.ui, { kind: "plugin.download" }) },
    );
  };

  removeLibraryItem = (libraryId: string): void => {
    void this.submit({ kind: "plugin.library.remove", libraryId }, { origin: workbenchRequestOrigin(this.ui, { kind: "plugin.library.remove" }) });
  };

  previewInstallSelected = (spaceId?: string): void => {
    const target = spaceId ?? this.ui.pluginSpaceId;
    const { pluginCatalogId, pluginVersion } = this.ui;
    const request: WorkbenchPlanRequest = {
      kind: "plugin.install",
      spaceIds: [target ?? ""],
      catalogId: pluginCatalogId,
      version: pluginVersion,
    };
    if (!target || !pluginCatalogId || !pluginVersion) {
      this.patch({ planError: this.msg("plugins.needExact"), pendingPlan: null, requestOrigin: workbenchRequestOrigin(this.ui, request) });
      return;
    }
    this.preview(request);
  };

  /**
   * One-click install of the newest published version of a catalog entry.
   *
   * If published versions have not been read yet, reads them once first. A
   * failed read leaves the entry expanded with its error and never guesses a
   * version.
   */
  installCatalogPlugin = (spaceId: string, catalogId: string): void => {
    const trimmed = catalogId.trim();
    if (!spaceId || !trimmed) return;
    const key = trimmed.toLowerCase();
    const existing = this.ui.pluginVersions[key];
    if (existing?.status === "ready" && existing.latest) {
      this.patch({ pluginCatalogId: trimmed, pluginVersion: existing.latest });
      this.preview({ kind: "plugin.install", spaceIds: [spaceId], catalogId: trimmed, version: existing.latest });
      return;
    }
    const cycle = this.cycle;
    this.patch({ pluginCatalogId: trimmed, pluginVersion: "" });
    void this.loadPluginVersions(trimmed, true).then(() => {
      if (!this.stillOpen(cycle)) return;
      const loaded = this.ui.pluginVersions[key];
      if (loaded?.status !== "ready" || !loaded.latest) return;
      if (this.ui.pluginCatalogId.trim().toLowerCase() !== key) return;
      this.patch({ pluginVersion: loaded.latest });
      this.preview({ kind: "plugin.install", spaceIds: [spaceId], catalogId: trimmed, version: loaded.latest });
    });
  };

  setHomeSettings = (patch: Partial<WorkbenchHomeSettings>): void => {
    const draft = this.ui.settingsDraft;
    if (!draft) return;
    const saved = draft.saved ?? draft.settings;
    const settings = { ...draft.settings, ...patch };
    const dirty =
      settings.portStart !== saved.portStart ||
      settings.portEnd !== saved.portEnd ||
      settings.packageSource !== saved.packageSource ||
      settings.catalogUrl !== saved.catalogUrl;
    this.patch({
      settingsDraft: {
        settings,
        saved,
        observation: draft.observation,
        dirty,
      },
    });
  };

  saveHomeSettings = (): void => {
    const draft = this.ui.settingsDraft;
    if (!draft || !draft.dirty) return;
    this.submittedSettingsJson = JSON.stringify(draft.settings);
    void this.submit({ kind: "settings.update", settings: draft.settings }, { context: draft.observation });
  };

  saveTemplate = (): void => {
    const spaceId = this.ui.templateSpaceId;
    const name = this.ui.templateName.trim();
    const origin = workbenchRequestOrigin(this.ui, { kind: "template.save" });
    if (!spaceId || !name) {
      this.patch({ commandError: this.msg("templates.needName"), requestOrigin: origin });
      return;
    }
    const dialogOpen = this.ui.overlay?.type === "save-template";
    const restore = this.restoreOverlay();
    void this.submit(
      {
        kind: "template.save",
        spaceId,
        name,
        includeConfig: this.ui.templateIncludeConfig,
      },
      {
        origin,
        onJob: (job) => {
          if (job.status === "failed") {
            this.patch({ commandError: localizeError(this.ui.locale, job.error ?? { code: "workbench/failed" }), requestOrigin: origin });
            return;
          }
          if (dialogOpen && this.ui.overlay?.type === "save-template") {
            this.patch({ overlay: restore });
          }
        },
      },
    );
  };

  deleteTemplate = (templateId: string): void => {
    const trimmed = templateId.trim();
    if (!trimmed) return;
    void this.submit(
      { kind: "template.delete", templateId: trimmed },
      { origin: workbenchRequestOrigin(this.ui, { kind: "template.delete" }) },
    );
  };

  createFromTemplate = (): void => {
    const templateId = this.ui.templateId;
    const name = this.ui.templateName.trim().toLowerCase();
    const origin = workbenchRequestOrigin(this.ui, { kind: "template.create" });
    if (!templateId) {
      this.patch({ commandError: this.msg("templates.needSelection"), requestOrigin: origin });
      return;
    }
    if (!NAME_RE.test(name)) {
      this.patch({ commandError: this.msg("app.nameInvalid"), requestOrigin: origin });
      return;
    }
    if (RESERVED.has(name)) {
      this.patch({ commandError: this.msg("app.nameReserved"), requestOrigin: origin });
      return;
    }
    const restore = this.restoreOverlay();
    void this.submit(
      {
        kind: "template.create",
        templateId,
        name,
        displayName: this.ui.templateDisplayName.trim() || undefined,
      },
      {
        origin,
        onJob: (job) => {
          if (job.status === "failed") {
            this.patch({ commandError: localizeError(this.ui.locale, job.error ?? { code: "workbench/failed" }), requestOrigin: origin });
            return;
          }
          if (this.ui.overlay?.type === "create") this.patch({ overlay: restore });
        },
      },
    );
  };

  exportShare = (): void => {
    const spaceId = this.ui.shareSpaceId;
    const dialogOpen = this.ui.overlay?.type === "export-share";
    const origin = dialogOpen ? "export-share" : workbenchRequestOrigin(this.ui, { kind: "space.import" });
    if (!spaceId) {
      this.patch({ commandError: this.msg("share.needSpace"), requestOrigin: origin });
      return;
    }
    const restore = this.restoreOverlay();
    const cycle = this.cycle;
    this.patch({ requestOrigin: origin });
    void this.wrap(async () => {
      const result = await this.api.product({
        method: "share.export",
        spaceId,
        includeConfig: this.ui.shareIncludeConfig,
      });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "share.export") {
        throw wrongProduct("share.export", result.method);
      }
      this.env.downloadFile(result.fileName, result.archiveBase64);
      if (dialogOpen && this.ui.overlay?.type === "export-share") {
        this.patch({ overlay: restore, commandError: null });
      }
    });
  };

  previewImportArchive = (archiveBase64: string, fileName: string): void => {
    const origin = workbenchRequestOrigin(this.ui, { kind: "space.import" });
    if (archiveBase64.length > MAX_WORKBENCH_SHARE_BASE64) {
      this.patch({ commandError: this.msg("share.tooLarge"), importPreview: null, requestOrigin: origin });
      return;
    }
    const overSettings = this.hasSettingsUnderlay();
    const cycle = this.cycle;
    this.patch({ requestOrigin: origin });
    void this.wrap(async () => {
      const result = await this.api.product({ method: "share.previewImport", archiveBase64 });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "share.previewImport") {
        throw wrongProduct("share.previewImport", result.method);
      }
      this.patch({
        overlay: { type: "import", ...(overSettings ? { overSettings: true } : {}) },
        importPreview: {
          importId: result.importId,
          expiresAt: result.expiresAt,
          preview: result.preview,
          observation: result.observation,
          fileName,
        },
        importName: "",
        importDisplayName: "",
        commandError: null,
      });
    });
  };

  confirmImport = (): void => {
    const preview = this.ui.importPreview;
    if (!preview) {
      this.patch({ commandError: this.msg("share.noPreview"), requestOrigin: workbenchRequestOrigin(this.ui, { kind: "space.import" }) });
      return;
    }
    const name = this.ui.importName.trim().toLowerCase();
    if (!NAME_RE.test(name)) {
      this.patch({ commandError: this.msg("app.nameInvalid"), requestOrigin: workbenchRequestOrigin(this.ui, { kind: "space.import" }) });
      return;
    }
    if (RESERVED.has(name)) {
      this.patch({ commandError: this.msg("app.nameReserved"), requestOrigin: workbenchRequestOrigin(this.ui, { kind: "space.import" }) });
      return;
    }
    const liveEpoch = this.ui.state?.serviceEpoch;
    if (!liveEpoch || liveEpoch !== preview.observation.serviceEpoch) {
      this.patch({ commandError: this.msg("share.epochChanged"), requestOrigin: workbenchRequestOrigin(this.ui, { kind: "space.import" }) });
      return;
    }
    const expires = Date.parse(preview.expiresAt);
    if (!Number.isFinite(expires) || this.env.now() >= expires) {
      this.patch({ commandError: this.msg("share.expired"), requestOrigin: workbenchRequestOrigin(this.ui, { kind: "space.import" }) });
      return;
    }
    const importId = preview.importId;
    const restore = this.ui.overlay?.type === "import" ? this.restoreOverlay() : null;
    this.patch({ overlay: restore, importPreview: null });
    void this.submit(
      {
        kind: "space.import",
        importId,
        name,
        displayName: this.ui.importDisplayName.trim() || undefined,
      },
      { context: preview.observation, origin: workbenchRequestOrigin(this.ui, { kind: "space.import" }) },
    );
  };
}
