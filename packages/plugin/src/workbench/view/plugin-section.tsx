/**
 * The plugin section of one space.
 *
 * Installing, upgrading and removing a plugin happens here and nowhere else:
 * the section lists what this space has, offers an upgrade when the registry
 * publishes a newer version, and installs from the catalog with an exact
 * version the interface fills in.
 *
 * The published versions are read once per catalog entry. A failed read keeps
 * its reason next to the version list; there is no retry button and no guessed
 * version. Picking the entry again reads it once more.
 *
 * Failure content is never part of an entrance animation: the reason is
 * readable from the first frame.
 */

import React, { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { gt as semverGt, valid as semverValid } from "semver";
import { StaggerItem, springSoft } from "../../../../../src/shared/ui/motion";
import type { PluginCatalogEntry } from "../../../../../src/shared/types";
import type { WorkbenchPlugin, WorkbenchSpace } from "../../../../../src/shared/workbench";
import { EmptyState } from "../empty-state";
import { t, type WorkbenchLocale } from "../i18n";
import type { WorkbenchController, WorkbenchUiState, WorkbenchPluginVersions } from "../store";

/** A published version is newer than the installed one. */
function isNewerVersion(candidate: string, installed: string | null): boolean {
  if (!installed) return true;
  if (!semverValid(candidate) || !semverValid(installed)) return candidate !== installed;
  return semverGt(candidate, installed);
}

function versionsKey(catalogId: string): string {
  return catalogId.trim().toLowerCase();
}

/** Only an npm entry can be installed and has a published version list. */
function installable(entry: PluginCatalogEntry): boolean {
  return entry.installMethod === "npm" && Boolean(entry.packageName);
}

export function PluginsSection({
  locale,
  space,
  controller,
  writable,
  busy,
  ui,
}: {
  locale: WorkbenchLocale;
  space: WorkbenchSpace;
  controller: WorkbenchController;
  writable: boolean;
  busy: boolean;
  ui: WorkbenchUiState;
}): ReactElement {
  const installed = ui.plugins.filter((plugin) => plugin.installedIn.includes(space.id));
  // The empty state expands the install area and points at the search field.
  const searchRef = useRef<HTMLInputElement>(null);
  const [installOpen, setInstallOpen] = useState(false);
  return (
    <section className="dsh-wb-space-detail-card" data-space-section="plugins">
      <h3 className="dsh-wb-title">{t(locale, "detail.plugins")}</h3>
      <p className="dsh-wb-muted">{t(locale, "plugins.toggleHint")}</p>
      {ui.pluginsStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">{ui.readError.plugins ?? t(locale, "app.genericError")}</p>
      ) : null}

      {installed.length === 0 && ui.pluginsStatus === "ready" ? (
        <EmptyState
          testId="plugins"
          title={t(locale, "detail.pluginsEmpty")}
          hint={t(locale, "detail.pluginsEmptyHint")}
          action={
            <button
              type="button"
              className="dsh-wb-btn primary"
              data-space-plugin-search-focus="true"
              onClick={() => { setInstallOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }}
            >
              {t(locale, "plugins.search")}
            </button>
          }
        />
      ) : null}
      {installed.map((plugin, index) => (
        <StaggerItem key={plugin.id} transition={{ ...springSoft, delay: index * 0.035 }}>
          <PluginRow
            plugin={plugin}
            locale={locale}
            spaceId={space.id}
            writable={writable}
            controller={controller}
            versions={ui.pluginVersions[versionsKey(plugin.packageName)]}
          />
        </StaggerItem>
      ))}
      {installed.length > 0 || ui.pluginsStatus === "ready" ? (
        <div className="dsh-wb-actions">
          <button
            type="button"
            className="dsh-wb-btn"
            aria-expanded={installOpen}
            data-space-plugin-install-open="true"
            onClick={() => setInstallOpen((open) => !open)}
          >
            {t(locale, "plugins.installArea")}
          </button>
        </div>
      ) : null}
      <div data-space-plugin-install-area="true" hidden={!installOpen}>
        <PluginInstallArea locale={locale} space={space} controller={controller} writable={writable} busy={busy} ui={ui} searchRef={searchRef} />
      </div>
    </section>
  );
}

function PluginRow({
  plugin,
  locale,
  spaceId,
  writable,
  controller,
  versions,
}: {
  plugin: WorkbenchPlugin;
  locale: WorkbenchLocale;
  spaceId: string;
  writable: boolean;
  controller: WorkbenchController;
  versions: WorkbenchPluginVersions | undefined;
}): ReactElement {
  const latest = versions?.status === "ready" ? versions.latest : null;
  const newer = latest && isNewerVersion(latest, plugin.version) ? latest : null;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']:not(:disabled)");
    (first ?? menuRef.current)?.focus();
    return () => { triggerRef.current?.focus(); };
  }, [menu]);
  const openMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  return (
    <div className="dsh-wb-space-row" data-space-plugin={plugin.id}>
      <span>
        <strong>{plugin.title}</strong>
        {plugin.id !== plugin.title ? <small className="dsh-wb-muted"> · {plugin.id}</small> : null}
        {plugin.version ? ` @ ${plugin.version}` : ""}
        {plugin.protected ? ` · ${t(locale, "plugins.protected")}` : ""}
      </span>
      {newer ? (
        <button
          type="button"
          className="dsh-wb-btn"
          data-space-plugin-upgrade={plugin.id}
          disabled={!writable}
          onClick={() => controller.preview({ kind: "plugin.install", spaceIds: [spaceId], catalogId: plugin.packageName, version: newer })}
        >
          {t(locale, "plugins.upgradeTo", { version: newer })}
        </button>
      ) : null}
      {versions?.status === "error" ? (
        <small className="dsh-wb-muted" data-space-plugin-versions-note={plugin.id} title={versions.error ?? undefined}>
          {t(locale, "plugins.versionsUnavailable")}
        </small>
      ) : null}
      <button
        type="button"
        ref={triggerRef}
        className="dsh-wb-btn"
        aria-haspopup="menu"
        aria-expanded={menu ? true : undefined}
        aria-label={t(locale, "plugins.moreActions")}
        data-space-plugin-actions={plugin.id}
        onClick={openMenu}
      >
        ⋯
      </button>
      {menu ? (<>
      <div
        ref={menuRef}
        className="dsh-wb-menu"
        role="menu"
        style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 30 }}
        data-space-plugin-menu={plugin.id}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); setMenu(null); return; }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const items = [...menuRef.current!.querySelectorAll<HTMLButtonElement>("button[role='menuitem']")];
          if (items.length === 0) return;
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        <button
          type="button"
          role="menuitem"
          disabled={!writable || plugin.protected}
          onClick={() => { setMenu(null); controller.preview({ kind: "plugin.toggle", spaceId, pluginId: plugin.id, enabled: false }); }}
        >
          {t(locale, "plugins.removeFromSpace")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!writable || plugin.protected}
          onClick={() => { setMenu(null); controller.preview({ kind: "plugin.remove", spaceId, packageName: plugin.packageName }); }}
        >
          {t(locale, "app.delete")}
        </button>
      </div>
      <div
        className="dsh-wb-menu-backdrop"
        style={{ position: "fixed", inset: 0, zIndex: 29 }}
        onClick={() => setMenu(null)}
      />
      </>) : null}
    </div>
  );
}

/**
 * The install area: search the catalog, pick an entry, pick a version.
 *
 * The version list comes from the registry. The exact version the plan needs
 * is filled in from that list; a version the registry did not list can still
 * be typed in, and it stays exact.
 */
function PluginInstallArea({
  locale,
  space,
  controller,
  writable,
  busy,
  ui,
  searchRef,
}: {
  locale: WorkbenchLocale;
  space: WorkbenchSpace;
  controller: WorkbenchController;
  writable: boolean;
  busy: boolean;
  ui: WorkbenchUiState;
  /** The search field the empty state points at. */
  searchRef: React.RefObject<HTMLInputElement | null>;
}): ReactElement {
  const entries = ui.catalog?.entries ?? [];
  const selected = ui.pluginCatalogId.trim();
  const versions = selected ? ui.pluginVersions[versionsKey(selected)] : undefined;
  const published = versions?.status === "ready" ? versions.versions : [];
  const manual = ui.pluginVersion;
  // A version the registry did not publish stays selectable: it is the way to
  // install a version that is not listed.
  const options = manual && !published.includes(manual) ? [manual, ...published] : published;
  const value = options.includes(manual) ? manual : (published[0] ?? "");
  return (
    <>
      <h4 className="dsh-wb-title">{t(locale, "detail.pluginsInstall")}</h4>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void controller.loadCatalog(ui.pluginQuery);
        }}
      >
        <label className="dsh-wb-field">
          {t(locale, "plugins.query")}
          <input
            ref={searchRef}
            value={ui.pluginQuery}
            onChange={(event) => controller.setPluginQuery(event.target.value)}
            data-space-plugin-search="true"
            autoComplete="off"
          />
        </label>
        <div className="dsh-wb-actions">
          <button
            type="submit"
            className="dsh-wb-btn"
            disabled={busy}
            data-space-plugin-search-submit="true"
          >
            {t(locale, "plugins.search")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn"
            disabled={!writable || busy}
            onClick={controller.refreshCatalog}
          >
            {t(locale, "plugins.refresh")}
          </button>
        </div>
      </form>
      {ui.catalogStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">{ui.readError.catalog ?? t(locale, "app.genericError")}</p>
      ) : null}
      {entries.length === 0 && ui.catalogStatus === "ready" ? (
        <EmptyState
          testId="catalog"
          title={t(locale, "plugins.empty")}
          action={
            <button type="button" className="dsh-wb-btn primary" disabled={busy} onClick={controller.refreshCatalog}>
              {t(locale, "plugins.refresh")}
            </button>
          }
        />
      ) : null}
      <div className="dsh-wb-product-list">
        {entries.map((entry) => {
          const entrySelected = selected !== "" && (entry.packageName ?? entry.id) === selected;
          return (
            <div key={entry.id} className="dsh-wb-space-row dsh-wb-product-card" data-selected={entrySelected ? "true" : undefined}>
              <span>
                <strong>{entry.id}</strong>
                {entry.packageName ? ` · ${entry.packageName}` : ""}
                <br />
                <small>{entry.description || entry.summary || entry.tier}</small>
              </span>
              {installable(entry) ? (
                <button
                  type="button"
                  className="dsh-wb-btn"
                  data-space-plugin-entry={entry.id}
                  aria-pressed={entrySelected}
                  onClick={() => controller.setPluginCatalog(entry.packageName ?? entry.id)}
                >
                  {t(locale, "plugins.catalogId")}
                </button>
              ) : (
                <small className="dsh-wb-muted">{t(locale, "plugins.notInstallable")}</small>
              )}
            </div>
          );
        })}
      </div>
      <label className="dsh-wb-field">
        {t(locale, "plugins.version")}
        <select
          value={value}
          disabled={options.length === 0}
          data-space-plugin-versions="true"
          onChange={(event) => controller.setPluginVersion(event.target.value)}
        >
          {options.map((version) => (
            <option
              key={version}
              value={version}
              data-manual={!published.includes(version) ? "true" : undefined}
            >
              {version}
            </option>
          ))}
        </select>
      </label>
      {versions?.status === "loading" ? (
        <p className="dsh-wb-muted" data-space-plugin-versions-loading="true">
          {t(locale, "plugins.versionsLoading")}
        </p>
      ) : null}
      {versions?.status === "error" ? (
        <p className="dsh-wb-alert" role="alert" data-space-plugin-versions-error="true">
          {versions.error}
        </p>
      ) : null}
      {!selected ? <p className="dsh-wb-muted">{t(locale, "plugins.selectEntry")}</p> : null}
      <details className="dsh-wb-field">
        <summary>{t(locale, "plugins.versionManual")}</summary>
        <label className="dsh-wb-field">
          {t(locale, "plugins.versionExact")}
          <input
            value={ui.pluginVersion}
            onChange={(event) => controller.setPluginVersion(event.target.value)}
            data-space-plugin-version="true"
            autoComplete="off"
          />
        </label>
      </details>
      <div className="dsh-wb-actions">
        <button
          type="button"
          className="dsh-wb-btn primary"
          disabled={!writable || busy || !selected || !ui.pluginVersion}
          data-space-plugin-install="true"
          onClick={() => controller.previewInstallSelected(space.id)}
        >
          {t(locale, "plugins.previewInstall")}
        </button>
      </div>
    </>
  );
}
