/**
 * The failure ownership of the workbench client.
 *
 * A failure belongs to the surface that started the request. These two
 * functions decide that surface; they were module-level functions of
 * `workbench/store.ts` and move here unchanged.
 */

import { isSettingsOverlay, type WorkbenchUiState } from "./types";

/**
 * The surface that owns the failure of a command.
 *
 * An origin is only set when the surface that shows it is on screen. A request
 * from a surface that is not open has no origin, and its reason stays in the
 * global banner at the top of the client.
 */
export function workbenchRequestOrigin(
  ui: WorkbenchUiState,
  request: { kind: string; spaceId?: string; spaceIds?: string[] },
): string | null {
  const settings = isSettingsOverlay(ui.overlay);
  const tab = ui.settingsTab;
  const detail = ui.detailSpaceId;
  const templates = settings && (tab === "templates" || tab === "blueprints");
  const spaces = settings && tab === "spaces";
  const detailOf = (spaceId: string | undefined): string | null =>
    spaceId && detail === spaceId ? `detail:${spaceId}` : null;
  switch (request.kind) {
    case "space.create":
      return ui.overlay?.type === "create" ? "create" : null;
    case "space.update":
      return detailOf(request.spaceId) ?? (spaces ? "spaces" : null);
    case "space.reorder":
      return spaces ? "spaces" : null;
    case "space.start":
    case "space.stop":
    case "space.restart":
    case "space.delete":
      return detailOf(request.spaceId) ?? (spaces ? "spaces" : null);
    case "space.models.sync":
      return detailOf(request.spaceId);
    case "space.runtime.set":
      return detail && detail === request.spaceId ? `detail:${request.spaceId}:dsh` : null;
    case "space.import":
      return ui.overlay?.type === "create"
        ? "create"
        : ui.overlay?.type === "import"
          ? "import"
          : templates
            ? "templates:import"
            : null;
    case "plugin.install":
      return detail && (request.spaceIds ?? []).includes(detail) ? `detail:${detail}:plugins` : null;
    case "plugin.toggle":
    case "plugin.remove":
    case "plugin.cleanup-manager":
      return detail && detail === request.spaceId ? `detail:${detail}:plugins` : null;
    case "plugin.download":
    case "plugin.library.remove":
    case "catalog.refresh":
      return detail ? `detail:${detail}:plugins` : null;
    case "snapshot.create":
    case "snapshot.delete":
      return settings && (tab === "overview" || tab === "snapshots") ? "backups" : null;
    case "runtime.remove":
      return settings && (tab === "overview" || tab === "runtime") ? "dshVersions" : null;
    case "service.shutdown":
      return settings && (tab === "overview" || tab === "advanced") ? "service" : null;
    case "settings.update":
      return settings && tab === "general"
        ? "general:settings"
        : settings && tab === "advanced"
          ? "service:settings"
          : null;
    case "template.save":
      return ui.overlay?.type === "save-template" ? "save-template" : templates ? "templates:export" : null;
    case "template.create":
      return ui.overlay?.type === "create" ? "create" : templates ? "templates:create" : null;
    case "template.delete":
      return templates ? "templates" : null;
    default:
      return null;
  }
}

/**
 * Whether the surface that owns `requestOrigin` is on screen right now and
 * actually renders its failures. When it is not (the user navigated away, the
 * dialog closed, or no surface renders that origin), the failure belongs in the
 * global banner. A failure is never dropped (let it crash).
 */
export function requestOriginMounted(ui: WorkbenchUiState): boolean {
  const origin = ui.requestOrigin;
  if (origin === null) return false;
  const overlay = ui.overlay?.type;
  if (
    origin === "create" ||
    origin === "rename" ||
    origin === "icon" ||
    origin === "save-template" ||
    origin === "export-share" ||
    origin === "import"
  ) {
    return overlay === origin;
  }
  if (!isSettingsOverlay(ui.overlay)) return false;
  const tab = ui.settingsTab;
  if (origin === "spaces") return tab === "spaces" && !ui.detailSpaceId;
  if (origin === "dshVersions") return tab === "overview" || tab === "runtime";
  if (origin === "general:settings") return tab === "general";
  if (origin === "service") return tab === "overview" || tab === "advanced";
  if (origin === "service:settings") return tab === "advanced";
  if (origin === "templates" || origin === "templates:import" || origin === "templates:export") {
    return tab === "templates" || tab === "blueprints";
  }
  const detail = /^detail:([a-z0-9][a-z0-9-]{0,38})(?::(plugins|dsh))?$/.exec(origin);
  if (detail) return tab === "spaces" && ui.detailSpaceId === detail[1];
  // "backups", "templates:create" and any future origin without a rendered
  // inline host fall back to the banner.
  return false;
}
