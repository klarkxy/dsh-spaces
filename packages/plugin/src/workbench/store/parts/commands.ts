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
  createSpace = (input: { name: string; displayName?: string; icon?: string; useSharedLlm?: boolean; modelSource?: 'main'|'shared'|'local'; browser?: boolean }): void => {
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
    void this.submit(
      {
        kind: "space.create",
        input: {
          name,
          displayName: input.displayName?.trim() || undefined,
          icon: icon.icon || undefined,
          ...(input.useSharedLlm === undefined ? {} : { useSharedLlm: input.useSharedLlm }),
          ...(input.modelSource === undefined ? {} : { modelSource: input.modelSource }),
          ...(input.browser ? { browser: true } : {}),
        },
      },
      {
        origin,
        // The dialog closes when the request is accepted. A failed job keeps it
        // open with the reason next to the form.
        onJob: (job) => {
          if (job.status === "failed") {
            this.patch({ commandError: localizeError(this.ui.locale, job.error ?? { code: "workbench/failed" }) });
            return;
          }
          this.patch({ overlay: this.ui.overlay?.type === "create" ? null : this.ui.overlay });
        },
      },
    );
  };

  updateSpace = (spaceId: string, patch: { displayName?: string; icon?: string }): void => {
    if (patch.icon !== undefined) {
      const icon = validateWorkbenchIcon(patch.icon);
      if (!icon.ok) {
        this.patch({ commandError: this.msg(icon.reason === "too-large" ? "app.iconTooLarge" : "app.iconInvalid"), requestOrigin: this.updateOrigin(spaceId) });
        return;
      }
      patch = { ...patch, icon: icon.icon };
    }
    const dialog = this.ui.overlay?.type === "rename" || this.ui.overlay?.type === "icon" ? this.ui.overlay.type : null;
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
        if (dialog && this.ui.overlay?.type === dialog) this.patch({ overlay: null });
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
    void this.submit({ kind: "space.reorder", spaceIds }, { origin: "spaces" });
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

  setHomeSettings = (patch: Partial<WorkbenchHomeSettings>): void => {
    const draft = this.ui.settingsDraft;
    if (!draft) return;
    this.patch({
      settingsDraft: {
        settings: { ...draft.settings, ...patch },
        observation: draft.observation,
        dirty: true,
      },
    });
  };

  saveHomeSettings = (): void => {
    const draft = this.ui.settingsDraft;
    if (!draft) return;
    this.submittedSettingsJson = JSON.stringify(draft.settings);
    void this.submit({ kind: "settings.update", settings: draft.settings }, { context: draft.observation });
  };

  saveTemplate = (): void => {
    const spaceId = this.ui.templateSpaceId;
    const name = this.ui.templateName.trim();
    if (!spaceId || !name) {
      this.patch({ commandError: this.msg("templates.needName") });
      return;
    }
    void this.submit(
      {
        kind: "template.save",
        spaceId,
        name,
        includeConfig: this.ui.templateIncludeConfig,
      },
      { origin: workbenchRequestOrigin(this.ui, { kind: "template.save" }) },
    );
  };

  createFromTemplate = (): void => {
    const templateId = this.ui.templateId;
    const name = this.ui.templateName.trim().toLowerCase();
    if (!templateId || !NAME_RE.test(name)) {
      this.patch({ commandError: this.msg("app.nameInvalid") });
      return;
    }
    if (RESERVED.has(name)) {
      this.patch({ commandError: this.msg("app.nameReserved") });
      return;
    }
    void this.submit(
      {
        kind: "template.create",
        templateId,
        name,
        displayName: this.ui.templateDisplayName.trim() || undefined,
      },
      { origin: workbenchRequestOrigin(this.ui, { kind: "template.create" }) },
    );
  };

  exportShare = (): void => {
    const spaceId = this.ui.shareSpaceId;
    if (!spaceId) {
      this.patch({ commandError: this.msg("share.needSpace"), requestOrigin: workbenchRequestOrigin(this.ui, { kind: "space.import" }) });
      return;
    }
    const cycle = this.cycle;
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
    });
  };

  previewImportArchive = (archiveBase64: string, fileName: string): void => {
    if (archiveBase64.length > MAX_WORKBENCH_SHARE_BASE64) {
      this.patch({ commandError: this.msg("share.tooLarge"), importPreview: null, requestOrigin: workbenchRequestOrigin(this.ui, { kind: "space.import" }) });
      return;
    }
    const cycle = this.cycle;
    this.patch({ requestOrigin: workbenchRequestOrigin(this.ui, { kind: "space.import" }) });
    void this.wrap(async () => {
      const result = await this.api.product({ method: "share.previewImport", archiveBase64 });
      if (!this.stillOpen(cycle)) return;
      if (result.method !== "share.previewImport") {
        throw wrongProduct("share.previewImport", result.method);
      }
      this.patch({
        overlay: { type: "import" },
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
    this.patch({ overlay: null, importPreview: null });
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
