import React, { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import type {
  WorkbenchJob,
  WorkbenchPlan,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchSnapshot,
  WorkbenchSpace,
  WorkbenchState,
} from "../../../../src/shared/workbench";
import { readLocalIcon } from "./fit-icon";
import { glyphPath, isDataImageIcon, KNOWN_GLYPHS } from "./icons";
import { BRAND_IMAGE_URL } from "../../../../src/shared/brand-artwork";
import { t, type WorkbenchLocale } from "./i18n";
import { LlmModelCenter } from "./llm/center";
import {
  DiagnosticsSection,
  HomeSettingsFields,
  ImportPreviewDialog,
  ImportResultCard,
  PluginsCatalogLibrary,
  TemplatesShareTab,
  ThemeSwitch,
} from "./product-ui";
import { BlueprintJobResult, BlueprintsPage } from "./blueprint-ui";
import type { WorkbenchController, WorkbenchUiState } from "./store";
import { WORKBENCH_CSS } from "./styles";
import type { ViewFrameState } from "./view-session";

function copyRedacted(text: string): void {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.writeText) void clipboard.writeText(text);
}

export interface WorkbenchViewProps {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  homeUrl?: string;
}

export function WorkbenchView({ ui, controller, homeUrl }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  return (
    <div className="dsh-workbench" lang={locale === "zh" ? "zh-CN" : "en"} data-locale={locale} data-theme={ui.theme}>
      <style>{WORKBENCH_CSS}</style>
      <Rail ui={ui} controller={controller} />
      <div className="dsh-wb-main" inert={ui.overlay?.type === "settings" || undefined}>
        {homeUrl && <iframe className="dsh-wb-frame dsh-wb-home-frame" title="DSH" src={homeUrl} data-home-view="true" allow="clipboard-write" hidden={ui.selected !== "home"} referrerPolicy="no-referrer" />}
        <WorkspaceFrames ui={ui} controller={controller} />
        {ui.boot === "loading" && (
          <div className="dsh-wb-boot" role="status">
            <LanguageSwitch locale={locale} onChange={controller.setLocale} />
            <span>{t(locale, "app.loading")}</span>
          </div>
        )}
        {ui.boot === "error" && ui.frames.length === 0 && (
          <div className="dsh-wb-boot">
            <LanguageSwitch locale={locale} onChange={controller.setLocale} />
            <p className="dsh-wb-alert" role="alert">
              {ui.error ?? t(locale, "app.error")}
            </p>
            <button type="button" className="dsh-wb-btn" onClick={() => void controller.poll()}>
              {t(locale, "app.retry")}
            </button>
          </div>
        )}

        {ui.createdNotice && (
          <div className="dsh-wb-banner" role="status" data-created={ui.createdNotice.spaceId}>
            {t(locale, "create.done")}
            <button type="button" className="dsh-wb-btn primary" onClick={controller.enterCreated}>
              {t(locale, "create.enter")}
            </button>
          </div>
        )}
        <WorkspaceChrome ui={ui} controller={controller} />
        {ui.overlay?.type !== "settings" && <div className="dsh-wb-global-status"><StatusBanners ui={ui} /></div>}
      </div>
      <Overlays ui={ui} controller={controller} />
    </div>
  );
}

function Rail({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const spaces = controller.workspaceSpaces();
  const writable = controller.canMutate();
  return (
    <aside className="dsh-wb-rail" inert={ui.overlay?.type === "settings" || undefined} aria-label={t(locale, "app.title")}>
      <RailButton
        label={t(locale, "app.home")}
        current={ui.selected === "home"}
        onClick={controller.selectHome}
        glyph="home"
      />
      <div className="dsh-wb-rail-list" role="list">
        {spaces.map((space, index) => (
          <RailButton
            key={space.id}
            label={space.displayName}
            current={ui.selected === space.id}
            pending={ui.pendingId === space.id}
            status={space.status}
            icon={space.icon}
            onClick={() => controller.selectSpace(space.id)}
            onMenu={(x, y) => controller.openMenu(space.id, x, y)}
            onMoveUp={writable ? () => controller.moveSpace(space.id, -1) : undefined}
            onMoveDown={writable ? () => controller.moveSpace(space.id, 1) : undefined}
            canMoveUp={index > 0}
            canMoveDown={index < spaces.length - 1}
          />
        ))}
      </div>
      <RailButton
        label={t(locale, "app.newSpace")}
        onClick={controller.openCreate}
        glyph="plus"
        disabled={!writable}
        tool
      />
      <RailButton label={t(locale, "app.settings")} onClick={controller.openSettings} glyph="gear" tool />
    </aside>
  );
}

function RailButton({
  label,
  current,
  pending,
  status,
  icon,
  onClick,
  onMenu,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  glyph,
  disabled,
  tool,
}: {
  label: string;
  current?: boolean;
  pending?: boolean;
  status?: WorkbenchSpace["status"];
  icon?: string;
  onClick: () => void;
  onMenu?: (x: number, y: number) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  glyph?: "home" | "plus" | "gear";
  disabled?: boolean;
  tool?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className={`dsh-wb-rail-btn${tool ? " tool" : ""}`}
      aria-label={label}
      aria-current={current ? "true" : undefined}
      aria-busy={pending || undefined}
      data-pending={pending ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
      onContextMenu={(event) => {
        if (!onMenu) return;
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu?.(rect.right, rect.top);
        }
        if (event.key === "ArrowUp" && event.altKey && canMoveUp) {
          event.preventDefault();
          onMoveUp?.();
        }
        if (event.key === "ArrowDown" && event.altKey && canMoveDown) {
          event.preventDefault();
          onMoveDown?.();
        }
      }}
    >
      {current ? <span className="dsh-wb-rail-indicator" /> : null}
      {glyph === "home" ? <HomeGlyph /> : glyph === "plus" ? <PlusGlyph /> : glyph === "gear" ? <GearGlyph /> : <SpaceGlyph icon={icon} />}
      {status ? <span className="dsh-wb-status" data-status={status} /> : null}
      <span className="dsh-wb-sr">{label}</span>
    </button>
  );
}

export function SpaceGlyph({ icon }: { icon?: string }): ReactElement {
  if (!icon || icon === "whale") {
    return <img className="dsh-wb-glyph-img" src={BRAND_IMAGE_URL} alt="" draggable={false} />;
  }
  if (isDataImageIcon(icon)) {
    return <img className="dsh-wb-glyph-img" src={icon} alt="" draggable={false} />;
  }
  const d = glyphPath(icon) ?? "";
  const viewBox = "0 0 40 40";
  return (
    <svg className="dsh-wb-glyph" viewBox={viewBox} aria-hidden>
      <path d={d} fillRule="nonzero" />
    </svg>
  );
}

function HomeGlyph(): ReactElement {
  return <SpaceGlyph />;
}

function PlusGlyph(): ReactElement {
  return (
    <svg className="dsh-wb-glyph" viewBox="0 0 24 24" aria-hidden>
      <path d="M11 5h2v14h-2zM5 11h14v2H5z" />
    </svg>
  );
}

function GearGlyph(): ReactElement {
  return (
    <svg className="dsh-wb-glyph" viewBox="0 0 24 24" aria-hidden>
      <path d="M10 3h4l.6 2.4 2.1.9 2.1-1.4 2.8 2.8-1.4 2.1.9 2.1L24 11v4l-2.4.6-.9 2.1 1.4 2.1-2.8 2.8-2.1-1.4-2.1.9L14 24h-4l-.6-2.4-2.1-.9-2.1 1.4L2.4 19.3l1.4-2.1-.9-2.1L0 14v-4l2.4-.6.9-2.1L1.9 5.2 4.7 2.4l2.1 1.4 2.1-.9zM12 9a3 3 0 1 0 .01 6.01A3 3 0 0 0 12 9z" />
    </svg>
  );
}

function ManagementContent({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  return (
    <>
      {ui.settingsTab === "overview" && <OverviewTab ui={ui} controller={controller} />}
      {ui.settingsTab === "spaces" && <SpacesTab ui={ui} controller={controller} />}
      {ui.settingsTab === "plugins" && <PluginsTab ui={ui} controller={controller} />}
      {ui.settingsTab === "snapshots" && <SnapshotsTab ui={ui} controller={controller} />}
      {ui.settingsTab === "runtime" && <RuntimeTab ui={ui} controller={controller} />}
      {ui.settingsTab === "templates" ? <TemplatesShareTab ui={ui} controller={controller} /> : null}
      {ui.settingsTab === "blueprints" ? (
        <BlueprintsPage
          locale={locale}
          ui={ui.blueprint}
          controller={controller}
          spaces={controller.blueprintSourceSpaces()}
        />
      ) : null}
    </>
  );
}

function StatusBanners({ ui }: { ui: WorkbenchUiState }): ReactElement | null {
  const locale = ui.locale;
  const state = ui.state;
  return (
    <>
      {state && !state.writable && (
        <p className="dsh-wb-notice" role="status">
          {t(locale, "app.readonly")}
        </p>
      )}
      {state?.maintenance && <p className="dsh-wb-notice">{t(locale, "app.maintenance")}</p>}
      {state?.availability === "unavailable" && (
        <p className="dsh-wb-alert" role="alert">
          {t(locale, "home.availability.unavailable")}
        </p>
      )}
      {ui.commandError && (
        <p className="dsh-wb-alert" role="alert">
          {ui.commandError}
        </p>
      )}
      {ui.planError && (
        <p className="dsh-wb-alert" role="alert">
          {ui.planError}
        </p>
      )}
    </>
  );
}

function OverviewTab({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const state = ui.state;
  if (!state) return <p className="dsh-wb-muted">{t(locale, "app.loading")}</p>;
  return (
    <>
      <dl className="dsh-wb-dl">
        <dt>{t(locale, "home.mode")}</dt>
        <dd>{state.mode}</dd>
        <dt>{t(locale, "home.protocol")}</dt>
        <dd>{state.protocolVersion}</dd>
        <dt>{t(locale, "home.availability")}</dt>
        <dd>
          {t(
            locale,
            state.availability === "limited"
              ? "home.availability.limited"
              : state.availability === "unavailable"
                ? "home.availability.unavailable"
                : "home.availability.ready",
          )}
        </dd>
        <dt>{t(locale, "home.dshVersion")}</dt>
        <dd>{state.dshVersion ?? "—"}</dd>
        <dt>{t(locale, "home.owner")}</dt>
        <dd>
          {state.owner ? `${state.owner.kind} · ${state.owner.since}` : t(locale, "home.ownerNone")}
        </dd>
        <dt>{state.writable ? t(locale, "home.writable") : t(locale, "home.readonlyFlag")}</dt>
        <dd>{state.role}</dd>
      </dl>
      <section>
        <h2 className="dsh-wb-title">{t(locale, "home.reasons")}</h2>
        {state.reasons.length === 0 ? (
          <p className="dsh-wb-muted">{t(locale, "home.noReasons")}</p>
        ) : (
          <ul>
            {state.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </section>
      <JobsList locale={locale} jobs={state.jobs} onCancel={controller.cancelJob} />
      <WorkbenchLogSection ui={ui} controller={controller} />
    </>
  );
}

function WorkbenchLogSection({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const text = controller.copyWorkbenchLog();
  return (
    <section data-workbench-log="true">
      <h2 className="dsh-wb-title">{t(locale, "logs.title")}</h2>
      {ui.logsStatus === "loading" ? <p role="status">{t(locale, "app.loading")}</p> : null}
      {ui.logsStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.logs ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {ui.logsError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.logsError}
        </p>
      ) : null}
      {ui.logsStatus === "ready" && ui.logs.length === 0 ? <p className="dsh-wb-muted">{t(locale, "logs.empty")}</p> : null}
      {ui.logs.map((entry, index) => (
        <pre key={`${entry.at}-${index}`} className="dsh-wb-log">
          {entry.at} {t(locale, entry.level === "info" ? "logs.level.info" : entry.level === "warn" ? "logs.level.warn" : "logs.level.error")} {entry.area} {entry.event}
          {entry.code ? ` ${entry.code}` : ""}
          {"\n"}
          {entry.message}
        </pre>
      ))}
      <div className="dsh-wb-actions">
        <button
          type="button"
          className="dsh-wb-btn"
          disabled={!text}
          onClick={() => copyRedacted(text)}
        >
          {t(locale, "app.copyLogs")}
        </button>
      </div>
    </section>
  );
}

function SpacesTab({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const spaces = controller.workspaceSpaces();
  const writable = controller.canMutate();
  return (
    <>
      <div className="dsh-wb-actions">
        <button type="button" className="dsh-wb-btn primary" disabled={!writable} onClick={controller.openCreate}>
          {t(locale, "app.newSpace")}
        </button>
      </div>
      {spaces.length === 0 ? <p className="dsh-wb-muted">{t(locale, "home.spacesEmpty")}</p> : null}
      {spaces.map((space, index) => (
        <div key={space.id} className="dsh-wb-space-row">
          <SpaceGlyph icon={space.icon} />
          <span>
            {space.displayName}{" "}
            <small>
              {t(locale, statusKey(space.status))}
              {space.isHost ? ` · ${t(locale, "detail.host")}` : ""}
              {!space.managed ? ` · ${t(locale, "app.unmanaged")}` : ""}
            </small>
          </span>
          <button type="button" className="dsh-wb-btn" onClick={() => controller.selectSpace(space.id)}>
            {space.status === "running" ? space.displayName : t(locale, "app.start")}
          </button>
          <button type="button" className="dsh-wb-btn" disabled={!writable || index === 0} onClick={() => controller.moveSpace(space.id, -1)}>
            {t(locale, "app.moveUp")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn"
            disabled={!writable || index === spaces.length - 1}
            onClick={() => controller.moveSpace(space.id, 1)}
          >
            {t(locale, "app.moveDown")}
          </button>
          <button type="button" className="dsh-wb-btn" onClick={() => controller.openDetail(space.id)}>
            {t(locale, "app.diagnose")}
          </button>
        </div>
      ))}
    </>
  );
}

function PluginsTab({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const writable = controller.canMutate();
  const busy = controller.isBusy();
  const spaces = controller.workspaceSpaces();
  const managerSelected = controller.isManagerId(ui.pluginSpaceId);
  return (
    <>
      <p className="dsh-wb-muted">{t(locale, "plugins.toggleHint")}</p>
      <p className="dsh-wb-muted">{t(locale, "plugins.notInstalled")}</p>
      <PluginsCatalogLibrary ui={ui} controller={controller} />
      <h3 className="dsh-wb-title">{t(locale, "plugins.installed")}</h3>
      {ui.pluginsStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.plugins ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      <form
        className="dsh-wb-form"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.searchPlugins(ui.pluginQuery);
        }}
      >
        <label className="dsh-wb-field">
          {t(locale, "plugins.query")}
          <input
            value={ui.pluginQuery}
            onChange={(event) => controller.setPluginQuery(event.target.value)}
            aria-label={t(locale, "plugins.search")}
          />
        </label>
        <label className="dsh-wb-field">
          {t(locale, "plugins.space")}
          <select value={ui.pluginSpaceId} onChange={(event) => controller.setPluginSpace(event.target.value)}>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="dsh-wb-field">
          {t(locale, "plugins.catalogId")}
          <input
            value={ui.pluginCatalogId}
            onChange={(event) => controller.setPluginCatalog(event.target.value)}
          />
        </label>
        <label className="dsh-wb-field">
          {t(locale, "plugins.version")}
          <input value={ui.pluginVersion} onChange={(event) => controller.setPluginVersion(event.target.value)} />
        </label>
        <div className="dsh-wb-actions">
          <button type="submit" className="dsh-wb-btn">
            {t(locale, "plugins.search")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn primary"
            disabled={!writable || busy || managerSelected}
            onClick={controller.previewInstallSelected}
          >
            {t(locale, "plugins.previewInstall")}
          </button>
        </div>
      </form>
      {managerSelected && <p className="dsh-wb-notice">{t(locale, "plugins.managerDenied")}</p>}
      {ui.plugins.length === 0 && ui.pluginsStatus === "ready" ? (
        <p className="dsh-wb-muted">{t(locale, "plugins.empty")}</p>
      ) : null}
      {ui.plugins.map((plugin) => (
        <PluginRow
          key={plugin.id}
          plugin={plugin}
          locale={locale}
          spaceId={ui.pluginSpaceId}
          writable={writable && !managerSelected && !busy}
          onPick={() => controller.setPluginCatalog(plugin.id, plugin.version ?? ui.pluginVersion)}
          onToggle={(enabled) =>
            controller.preview({
              kind: "plugin.toggle",
              spaceId: ui.pluginSpaceId,
              pluginId: plugin.id,
              enabled,
            })
          }
          onRemove={() =>
            controller.preview({
              kind: "plugin.remove",
              spaceId: ui.pluginSpaceId,
              packageName: plugin.packageName,
            })
          }
        />
      ))}
      <p className="dsh-wb-muted">{t(locale, "plugins.cleanupHint")}</p>
      <button
        type="button"
        className="dsh-wb-btn"
        disabled={!writable || busy || !ui.pluginSpaceId || managerSelected}
        onClick={() => controller.preview({ kind: "plugin.cleanup-manager", spaceId: ui.pluginSpaceId })}
      >
        {t(locale, "plugins.cleanup")}
      </button>
    </>
  );
}

function PluginRow({
  plugin,
  locale,
  spaceId,
  writable,
  onPick,
  onToggle,
  onRemove,
}: {
  plugin: WorkbenchPlugin;
  locale: WorkbenchLocale;
  spaceId: string;
  writable: boolean;
  onPick: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}): ReactElement {
  const installed = plugin.installedIn.includes(spaceId);
  return (
    <div className="dsh-wb-space-row">
      <span>
        <strong>{plugin.title}</strong> · <code>{plugin.id}</code>
        {plugin.version ? ` @ ${plugin.version}` : ""}
        {plugin.protected ? ` · ${t(locale, "plugins.protected")}` : ""}
        <br />
        <small>
          {plugin.description} · {t(locale, "plugins.installedIn")}: {plugin.installedIn.join(", ") || "—"}
        </small>
      </span>
      <button type="button" className="dsh-wb-btn" onClick={onPick}>
        {plugin.id}
      </button>
      <button
        type="button"
        className="dsh-wb-btn"
        disabled={!writable || plugin.protected}
        onClick={() => onToggle(!installed)}
      >
        {installed ? t(locale, "plugins.removeFromSpace") : t(locale, "plugins.installToSpace")}
      </button>
      {installed ? (
        <button type="button" className="dsh-wb-btn danger" disabled={!writable || plugin.protected} onClick={onRemove}>
          {t(locale, "plugins.removeFromSpace")}
        </button>
      ) : null}
    </div>
  );
}

function SnapshotsTab({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const writable = controller.canMutate();
  return (
    <>
      <p className="dsh-wb-muted">{t(locale, "snapshots.createHint")}</p>
      <button
        type="button"
        className="dsh-wb-btn primary"
        disabled={!writable}
        onClick={() => controller.preview({ kind: "snapshot.create" })}
      >
        {t(locale, "snapshots.create")}
      </button>
      {ui.snapshotsStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.snapshots ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {ui.snapshots.length === 0 && ui.snapshotsStatus === "ready" ? (
        <p className="dsh-wb-muted">{t(locale, "snapshots.empty")}</p>
      ) : null}
      {ui.snapshots.map((snapshot) => (
        <SnapshotRow key={snapshot.id} snapshot={snapshot} locale={locale} writable={writable} controller={controller} />
      ))}
    </>
  );
}

function SnapshotRow({
  snapshot,
  locale,
  writable,
  controller,
}: {
  snapshot: WorkbenchSnapshot;
  locale: WorkbenchLocale;
  writable: boolean;
  controller: WorkbenchController;
}): ReactElement {
  return (
    <div className="dsh-wb-space-row">
      <span>
        {snapshot.createdAt} · DSH {snapshot.runtimeVersion} · {(snapshot.bytes / 1048576).toFixed(1)} MB
        <br />
        <small>
          {t(locale, "snapshots.spaces")}: {snapshot.spaceIds.join(", ") || "—"}
          {snapshot.restorable ? "" : ` · ${t(locale, "snapshots.notRestorable")}`}
        </small>
      </span>
      <button
        type="button"
        className="dsh-wb-btn danger"
        disabled={!writable}
        onClick={() => controller.preview({ kind: "snapshot.delete", snapshotId: snapshot.id })}
      >
        {t(locale, "snapshots.delete")}
      </button>
    </div>
  );
}

function RuntimeTab({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const writable = controller.canMutate();
  const current = ui.runtimes.find((row) => row.current);
  return (
    <>
      <WorkbenchPackageSection ui={ui} controller={controller} />
      {ui.runtimesStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.runtimes ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      <p>
        {t(locale, "runtime.current")}: {current?.version ?? t(locale, "runtime.none")}
      </p>
      {ui.runtimes.map((runtime) => (
        <div key={runtime.version} className="dsh-wb-space-row">
          <span>
            {runtime.version}
            {runtime.installed ? ` · ${t(locale, "runtime.installed")}` : ""}
            {runtime.current ? ` · ${t(locale, "runtime.current")}` : ""}
            {runtime.compatible ? ` · ${t(locale, "runtime.compatible")}` : ` · ${t(locale, "runtime.incompatible")}`}
          </span>
          <button
            type="button"
            className="dsh-wb-btn"
            disabled={!writable}
            onClick={() => controller.preview({ kind: "runtime.install", version: runtime.version })}
          >
            {t(locale, "runtime.install")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn"
            disabled={!writable || runtime.current || !runtime.compatible}
            onClick={() => controller.preview({ kind: "runtime.upgrade", version: runtime.version })}
          >
            {t(locale, "runtime.upgrade")}
          </button>
        </div>
      ))}
    </>
  );
}

function WorkbenchPackageSection({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const pkg = ui.workbenchPackage;
  const writable = controller.canMutate();
  const busy = controller.isBusy();
  const contentUpdate = Boolean(
    pkg && pkg.updateAvailable && pkg.installedVersion !== null && pkg.version === pkg.installedVersion,
  );
  const canPrepare = Boolean(writable && !busy && ui.workbenchPackageStatus !== "loading");
  const canUpgrade = Boolean(writable && !busy && pkg?.updateAvailable);
  return (
    <section className="dsh-wb-package" data-workbench-package="true" aria-labelledby="dsh-wb-package-title">
      <h2 id="dsh-wb-package-title" className="dsh-wb-title">
        {t(locale, "workbenchPackage.title")}
      </h2>
      <p className="dsh-wb-muted">{t(locale, "workbenchPackage.hint")}</p>
      {ui.workbenchPackageStatus === "loading" ? (
        <p role="status">{t(locale, "app.loading")}</p>
      ) : null}
      {ui.commandError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.commandError}
        </p>
      ) : null}
      {ui.workbenchPackageStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.package ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {ui.workbenchPackageStatus === "ready" && !pkg ? (
        <p className="dsh-wb-muted" data-workbench-package-unavailable="true">
          {t(locale, "workbenchPackage.none")}
        </p>
      ) : null}
      <div className="dsh-wb-actions">
        <button
          type="button"
          className="dsh-wb-btn"
          data-workbench-prepare="true"
          disabled={!canPrepare}
          onClick={() => controller.prepareWorkbenchPackage()}
        >
          {t(locale, "workbenchPackage.prepare")}
        </button>
      </div>
      {pkg ? (
        <>
          <dl className="dsh-wb-dl">
            <dt>{t(locale, "workbenchPackage.installed")}</dt>
            <dd data-installed-version={pkg.installedVersion ?? ""}>
              {pkg.installedVersion ?? t(locale, "runtime.none")}
            </dd>
            <dt>{t(locale, "workbenchPackage.candidate")}</dt>
            <dd data-candidate-version={pkg.version}>{pkg.version}</dd>
            <dt>{t(locale, "workbenchPackage.digest")}</dt>
            <dd data-candidate-digest={pkg.digest}>{pkg.digest}</dd>
          </dl>
          {contentUpdate ? (
            <p className="dsh-wb-notice" data-content-update="true">
              {t(locale, "workbenchPackage.contentUpdate")}
            </p>
          ) : null}
          {!pkg.updateAvailable ? (
            <p className="dsh-wb-muted">{t(locale, "workbenchPackage.current")}</p>
          ) : (
            <p className="dsh-wb-muted">{t(locale, "workbenchPackage.consequences")}</p>
          )}
          <div className="dsh-wb-actions">
            <button
              type="button"
              className="dsh-wb-btn primary"
              data-workbench-upgrade="true"
              disabled={!canUpgrade}
              onClick={() =>
                controller.preview({
                  kind: "workbench.upgrade",
                  catalogId: "bundled-workbench",
                  version: pkg.version,
                })
              }
            >
              {t(locale, "workbenchPackage.preview")}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function WorkspaceFrames({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  return (
    <div className="dsh-wb-frames" data-frames="true">
      {ui.frames.map((item) =>
        item.src ? (
          <WorkspaceFrame
            key={`${item.spaceId}:${item.generation}`}
            frame={item}
            visible={controller.views.isVisible(item.spaceId)}
            title={controller.space(item.spaceId)?.displayName ?? t(locale, "iframe.title")}
            onWindow={(win) => controller.registerIframeWindow(item.spaceId, item.generation, win)}
          />
        ) : null,
      )}
    </div>
  );
}

function WorkspaceChrome({ ui, controller }: WorkbenchViewProps): ReactElement | null {
  const locale = ui.locale;
  const space = ui.selected === "home" ? undefined : controller.space(ui.selected);
  const pendingId = ui.pendingId;
  const pendingFrame = pendingId ? ui.frames.find((item) => item.spaceId === pendingId) : null;
  const showIdle = Boolean(space && space.status !== "running");
  if (!showIdle && !pendingFrame && !ui.viewError) return null;
  return (
    <>
      {showIdle && space && (
        <IdleCard locale={locale} space={space} writable={controller.canMutate()} controller={controller} />
      )}
      {pendingFrame?.status === "loading" && (
        <div className="dsh-wb-banner" role="status">
          {t(locale, "app.viewLoading")}
        </div>
      )}
      {pendingFrame?.status === "pending" && ui.visibleSpaceId !== pendingId && (
        <div className="dsh-wb-banner" role="status">
          {t(locale, "app.viewPending")}
        </div>
      )}
      {ui.viewError && (
        <div className="dsh-wb-banner" role="alert">
          <span>{t(locale, "app.viewFailed")}</span>
          <button type="button" className="dsh-wb-btn" onClick={() => controller.openDetail(ui.viewError!.spaceId)}>
            {t(locale, "app.errorDetails")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn"
            onClick={() => copyRedacted(ui.viewError?.message ?? t(locale, "app.viewFailed"))}
          >
            {t(locale, "app.copyLogs")}
          </button>
          <button type="button" className="dsh-wb-btn" onClick={() => controller.openIndependent(ui.viewError!.spaceId)}>
            {t(locale, "app.openIndependent")}
          </button>
        </div>
      )}
    </>
  );
}

function WorkspaceFrame({
  frame,
  visible,
  title,
  onWindow,
}: {
  frame: ViewFrameState;
  visible: boolean;
  title: string;
  onWindow: (win: unknown) => void;
}): ReactElement {
  const ref = useRef<HTMLIFrameElement>(null);
  const bind = (): void => {
    onWindow(ref.current?.contentWindow ?? null);
  };
  return (
    <iframe
      ref={(element) => {
        ref.current = element;
        onWindow(element?.contentWindow ?? null);
      }}
      className="dsh-wb-frame"
      title={title}
      src={frame.src ?? undefined}
      data-space-id={frame.spaceId}
      data-generation={String(frame.generation)}
      data-visible={visible ? "true" : "false"}
      hidden={!visible}
      referrerPolicy="no-referrer"
      onLoad={bind}
    />
  );
}

function IdleCard({
  locale,
  space,
  writable,
  controller,
}: {
  locale: WorkbenchLocale;
  space: WorkbenchSpace;
  writable: boolean;
  controller: WorkbenchController;
}): ReactElement {
  const titleKey =
    space.status === "starting"
      ? "app.startingTitle"
      : space.status === "crashed"
        ? "app.crashedTitle"
        : "app.idleTitle";
  const crashed = space.status === "crashed";
  return (
    <div className="dsh-wb-idle">
      <div className="dsh-wb-dialog">
        <h2 className="dsh-wb-title">{t(locale, titleKey, { name: space.displayName })}</h2>
        <p className="dsh-wb-muted">{crashed ? t(locale, "app.errorDetails") : t(locale, "app.idleBody")}</p>
        {!space.managed && <p className="dsh-wb-notice">{t(locale, "app.unmanaged")}</p>}
        <div className="dsh-wb-actions">
          {crashed ? (
            <>
              <button type="button" className="dsh-wb-btn primary" onClick={() => controller.openDetail(space.id)}>
                {t(locale, "app.errorDetails")}
              </button>
              <button
                type="button"
                className="dsh-wb-btn"
                onClick={() => copyRedacted(`${space.id} ${space.status}`)}
              >
                {t(locale, "app.copyLogs")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="dsh-wb-btn primary"
              disabled={!writable || !space.managed || space.status === "starting" || space.status === "stopping"}
              onClick={() => controller.startSpace(space.id)}
            >
              {t(locale, "app.start")}
            </button>
          )}
          <button type="button" className="dsh-wb-btn" onClick={() => controller.openRename(space.id)} disabled={!writable}>
            {t(locale, "app.rename")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn danger"
            disabled={!writable || controller.isManagerId(space.id)}
            onClick={() => controller.preview({ kind: "space.delete", spaceId: space.id, removeData: false })}
          >
            {t(locale, "app.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Overlays({ ui, controller }: WorkbenchViewProps): ReactElement | null {
  return (
    <>
      {ui.overlay?.type === "create" && <CreateDialog locale={ui.locale} controller={controller} />}
      {ui.overlay?.type === "rename" && (
        <RenameDialog locale={ui.locale} space={controller.space(ui.overlay.spaceId)} controller={controller} />
      )}
      {ui.overlay?.type === "icon" && (
        <IconDialog locale={ui.locale} space={controller.space(ui.overlay.spaceId)} controller={controller} />
      )}
      {ui.overlay?.type === "settings" && <SettingsDialog ui={ui} controller={controller} />}
      {ui.overlay?.type === "import" && ui.importPreview && (
        <ImportPreviewDialog
          locale={ui.locale}
          preview={ui.importPreview}
          importName={ui.importName}
          importDisplayName={ui.importDisplayName}
          busy={controller.isBusy()}
          onName={controller.setImportName}
          onDisplayName={controller.setImportDisplayName}
          onCancel={controller.closeImport}
          onConfirm={controller.confirmImport}
        />
      )}
      {ui.overlay?.type === "detail" && <DetailDialog ui={ui} controller={controller} spaceId={ui.overlay.spaceId} />}
      {ui.overlay?.type === "menu" && (
        <SpaceMenu ui={ui} controller={controller} spaceId={ui.overlay.spaceId} x={ui.overlay.x} y={ui.overlay.y} />
      )}
      {ui.pendingPlan && (
        <PlanDialog locale={ui.locale} plan={ui.pendingPlan.plan} onCancel={controller.closePlan} onConfirm={controller.confirmPlan} />
      )}

    </>
  );
}

function PlanDialog({
  locale,
  plan,
  onCancel,
  onConfirm,
}: {
  locale: WorkbenchLocale;
  plan: WorkbenchPlan;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const scopeKey =
    plan.scope === "home" ? "plan.scope.home" : plan.scope === "controller" ? "plan.scope.controller" : "plan.scope.space";
  return (
    <div className="dsh-wb-overlay">
      <div className="dsh-wb-dialog" role="dialog" aria-labelledby="dsh-wb-plan-title">
        <h2 id="dsh-wb-plan-title" className="dsh-wb-title">
          {t(locale, "plan.title")}
        </h2>
        <p>{plan.title}</p>
        <dl className="dsh-wb-dl">
          <dt>{t(locale, "plan.scope")}</dt>
          <dd>{t(locale, scopeKey)}</dd>
          <dt>{t(locale, "plan.targets")}</dt>
          <dd>{plan.affectedSpaceIds.join(", ") || t(locale, "plan.none")}</dd>
          <dt>{t(locale, "plan.running")}</dt>
          <dd>{plan.runningSpaceIds.join(", ") || t(locale, "plan.none")}</dd>
          <dt>{t(locale, "plan.expires")}</dt>
          <dd>{plan.expiresAt}</dd>
        </dl>
        <p>{t(locale, "plan.changes")}</p>
        <ul>
          {plan.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
        {plan.destructive && (
          <p className="dsh-wb-alert" role="alert">
            {t(locale, "plan.destructive")}
          </p>
        )}
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={onCancel}>
            {t(locale, "app.cancel")}
          </button>
          <button type="button" className="dsh-wb-btn primary" onClick={onConfirm} data-plan-id={plan.id}>
            {t(locale, "app.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateDialog({ locale, controller }: { locale: WorkbenchLocale; controller: WorkbenchController }): ReactElement {
  const nameRef = useRef<HTMLInputElement>(null);
  const displayRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<string>("");
  const sharedRef = useRef<HTMLInputElement>(null);
  const iconState = useRef<IconPickState>("idle");
  const [iconBlocked, setIconBlocked] = useState(false);
  const onIconState = (state: IconPickState): void => {
    iconState.current = state;
    setIconBlocked(state !== "idle");
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (iconState.current !== "idle") return;
    controller.createSpace({
      name: nameRef.current?.value ?? "",
      displayName: displayRef.current?.value,
      icon: iconRef.current,
      useSharedLlm: sharedRef.current?.checked !== false,
    });
  };
  return (
    <div className="dsh-wb-overlay">
      <form className="dsh-wb-dialog" onSubmit={submit} aria-label={t(locale, "create.title")}>
        <h2 className="dsh-wb-title">{t(locale, "create.title")}</h2>
        <p className="dsh-wb-muted">{t(locale, "create.hint")}</p>
        <label className="dsh-wb-field">
          {t(locale, "create.name")}
          <input ref={nameRef} name="name" required autoComplete="off" />
        </label>
        <label className="dsh-wb-field">
          {t(locale, "create.displayName")}
          <input ref={displayRef} name="displayName" autoComplete="off" />
        </label>
        <label className="dsh-wb-field">
          <input ref={sharedRef} type="checkbox" name="useSharedLlm" defaultChecked />
          {t(locale, "create.useSharedLlm")}
        </label>
        <p className="dsh-wb-muted">{t(locale, "create.useSharedLlmHint")}</p>
        <IconPicker locale={locale} onChange={(icon) => (iconRef.current = icon)} onState={onIconState} />
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={controller.closeOverlay}>
            {t(locale, "app.cancel")}
          </button>
          <button type="submit" className="dsh-wb-btn primary" disabled={controller.isBusy() || iconBlocked}>
            {t(locale, "app.create")}
          </button>
        </div>
      </form>
    </div>
  );
}

function RenameDialog({
  locale,
  space,
  controller,
}: {
  locale: WorkbenchLocale;
  space?: WorkbenchSpace;
  controller: WorkbenchController;
}): ReactElement | null {
  if (!space) return null;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("displayName");
    controller.updateSpace(space.id, { displayName: String(value ?? "").trim() || space.displayName });
  };
  return (
    <div className="dsh-wb-overlay">
      <form className="dsh-wb-dialog" onSubmit={submit}>
        <h2 className="dsh-wb-title">{t(locale, "rename.title")}</h2>
        <label className="dsh-wb-field">
          {t(locale, "create.displayName")}
          <input name="displayName" defaultValue={space.displayName} />
        </label>
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={controller.closeOverlay}>
            {t(locale, "app.cancel")}
          </button>
          <button type="submit" className="dsh-wb-btn primary">
            {t(locale, "app.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

function IconDialog({
  locale,
  space,
  controller,
}: {
  locale: WorkbenchLocale;
  space?: WorkbenchSpace;
  controller: WorkbenchController;
}): ReactElement | null {
  const iconRef = useRef(space?.icon ?? "");
  const iconState = useRef<IconPickState>("idle");
  const [iconBlocked, setIconBlocked] = useState(false);
  if (!space) return null;
  const onIconState = (state: IconPickState): void => {
    iconState.current = state;
    setIconBlocked(state !== "idle");
  };
  return (
    <div className="dsh-wb-overlay">
      <div className="dsh-wb-dialog">
        <h2 className="dsh-wb-title">{t(locale, "icon.title")}</h2>
        <IconPicker locale={locale} value={space.icon} onChange={(icon) => (iconRef.current = icon)} onState={onIconState} />
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={controller.closeOverlay}>
            {t(locale, "app.cancel")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn primary"
            disabled={iconBlocked}
            onClick={() => {
              if (iconState.current !== "idle") return;
              controller.updateSpace(space.id, { icon: iconRef.current });
            }}
          >
            {t(locale, "app.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

type IconPickState = "idle" | "pending" | "failed";

export function IconPicker({
  locale,
  value,
  onChange,
  onState,
}: {
  locale: WorkbenchLocale;
  value?: string;
  onChange: (icon: string) => void;
  onState?: (state: IconPickState) => void;
}): ReactElement {
  const [preview, setPreview] = useState(value ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  const publish = (icon: string): void => {
    request.current += 1;
    setPending(false);
    setError(null);
    setPreview(icon);
    onStateRef.current?.("idle");
    onChange(icon);
  };

  const acceptFile = (file: File): void => {
    const id = ++request.current;
    setPending(true);
    setError(null);
    onStateRef.current?.("pending");
    void readLocalIcon(file).then((result) => {
      if (id !== request.current) return;
      setPending(false);
      if (!result.ok) {
        setError(t(locale, result.reason === "too-large" ? "app.iconTooLarge" : "app.iconInvalid"));
        onStateRef.current?.("failed");
        return;
      }
      setPreview(result.icon);
      setError(null);
      onStateRef.current?.("idle");
      onChange(result.icon);
    }).catch(() => {
      if (id !== request.current) return;
      setPending(false);
      setError(t(locale, "app.iconInvalid"));
      onStateRef.current?.("failed");
    });
  };

  return (
    <div>
      <p>{t(locale, "create.glyph")}</p>
      <div className="dsh-wb-glyphs" role="group" aria-label={t(locale, "create.icon")}>
        {KNOWN_GLYPHS.map((glyph) => (
          <button
            key={glyph}
            type="button"
            className="dsh-wb-rail-btn"
            aria-pressed={!isDataImageIcon(preview) && (preview || "whale") === glyph}
            aria-label={t(locale, `icon.${glyph}` as const)}
            onClick={() => publish(glyph === "whale" ? "" : glyph)}
          >
            <SpaceGlyph icon={glyph} />
          </button>
        ))}
      </div>
      <label className="dsh-wb-field">
        {t(locale, "create.upload")}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          disabled={pending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (file) acceptFile(file);
          }}
        />
      </label>
      {pending ? <p role="status">{t(locale, "create.iconShrinking")}</p> : null}
      {error ? <p className="dsh-wb-alert" role="alert">{error}</p> : null}
      {isDataImageIcon(preview) ? (
        <span className="dsh-wb-icon-preview">
          <img className="dsh-wb-glyph-img" src={preview} alt="" draggable={false} />
        </span>
      ) : null}
      <button type="button" className="dsh-wb-btn" onClick={() => publish("")}>
        {t(locale, "icon.default")}
      </button>
    </div>
  );
}

function SettingsDialog({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const writable = controller.canMutate();
  const busy = controller.isBusy();
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>("[data-settings-close]")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const tabs: Array<[WorkbenchUiState["settingsTab"], Parameters<typeof t>[1]]> = [
    ["general", "settings.tabGeneral"], ["llm", "settings.tabLlm"],
    ["spaces", "home.spaces"], ["plugins", "home.plugins"], ["blueprints", "home.blueprints"],
    ["templates", "home.templates"], ["snapshots", "home.snapshots"],
    ["runtime", "home.runtime"], ["overview", "settings.tabStatus"], ["advanced", "settings.tabAdvanced"],
  ];
  return (
    <div className="dsh-wb-overlay" onClick={(event) => {
      if (event.target === event.currentTarget && !ui.pendingPlan) controller.closeOverlay();
    }}>
      <div ref={dialog} className="dsh-wb-dialog dsh-wb-settings" role="dialog" aria-modal="true" aria-labelledby="dsh-wb-settings-title" data-settings-dialog="true" onKeyDown={(event) => {
        if (ui.pendingPlan) return;
        if (event.key === "Escape") { event.preventDefault(); controller.closeOverlay(); }
        if (event.key === "Tab") {
          const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? []).filter((el) => el.getClientRects().length > 0);
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        <header className="dsh-wb-settings-header">
          <h2 id="dsh-wb-settings-title" className="dsh-wb-title">{t(locale, "settings.title")}</h2>
          <button type="button" className="dsh-wb-btn dsh-wb-settings-close" data-settings-close="true" onClick={controller.closeOverlay}>
            <span aria-hidden="true">×</span> {t(locale, "app.close")}
          </button>
        </header>
        <div className="dsh-wb-settings-body">
          <div className="dsh-wb-settings-nav" role="tablist" aria-label={t(locale, "settings.title")} aria-orientation="vertical">
            {tabs.map(([tab, label], index) => <button key={tab} type="button" role="tab" id={`settings-tab-${tab}`} aria-controls="settings-panel" aria-selected={ui.settingsTab === tab} tabIndex={ui.settingsTab === tab ? 0 : -1} className="dsh-wb-tab" onClick={() => controller.setSettingsTab(tab)} onKeyDown={(event) => {
              const next = event.key === "ArrowDown" ? (index + 1) % tabs.length : event.key === "ArrowUp" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              controller.setSettingsTab(tabs[next][0]);
              document.getElementById(`settings-tab-${tabs[next][0]}`)?.focus();
            }}>{t(locale, label)}</button>)}
          </div>
          <div key={ui.settingsTab} className="dsh-wb-settings-content" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${ui.settingsTab}`} tabIndex={0}>
            <StatusBanners ui={ui} />
            {ui.settingsTab === "general" && <>
              <h3 className="dsh-wb-title">{t(locale, "settings.clientPrefs")}</h3>
              <div className="dsh-wb-preference-row"><span>{t(locale, "settings.locale")}</span><LanguageSwitch locale={locale} onChange={controller.setLocale} /></div>
              <div className="dsh-wb-preference-row"><span>{t(locale, "settings.theme")}</span><ThemeSwitch locale={locale} theme={ui.theme} onChange={controller.setTheme} /></div>
            </>}
            {ui.settingsTab === "advanced" && <>
              <HomeSettingsFields ui={ui} controller={controller} />
              <section className="dsh-wb-settings-service">
                <h3 className="dsh-wb-title">{t(locale, "settings.shutdown")}</h3>
                <p className="dsh-wb-muted">{t(locale, "settings.shutdownHint")}</p>
                <p className="dsh-wb-muted">{t(locale, "settings.shutdownVsExit")}</p>
                <div><button type="button" className="dsh-wb-btn danger" disabled={!writable || busy} onClick={() => controller.preview({ kind: "service.shutdown" })}>{t(locale, "settings.exit")}</button></div>
              </section>
            </>}
            {ui.settingsTab === "llm" && <LlmModelCenter locale={locale} writable={writable} client={controller.llmClient()} spaces={controller.llmSpaces()} uuid={crypto.randomUUID.bind(crypto)} />}
            <ManagementContent ui={ui} controller={controller} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailDialog({ ui, controller, spaceId }: WorkbenchViewProps & { spaceId: string }): ReactElement {
  const locale = ui.locale;
  const space = controller.space(spaceId);
  const writable = controller.canMutate();
  const detail = ui.detail;
  return (
    <div className="dsh-wb-overlay">
      <div className="dsh-wb-dialog wide" role="dialog">
        <h2 className="dsh-wb-title">
          {t(locale, "detail.title")}
          {space ? ` — ${space.displayName}` : ""}
        </h2>
        {ui.detailStatus === "loading" && <p role="status">{t(locale, "app.loading")}</p>}
        {ui.readError.detail ? <p className="dsh-wb-alert" role="alert">{ui.readError.detail}</p> : null}
        {space && (
          <dl className="dsh-wb-dl">
            <dt>{t(locale, "detail.id")}</dt>
            <dd>
              <code>{space.id}</code>
            </dd>
            <dt>{t(locale, "detail.status")}</dt>
            <dd>{t(locale, statusKey(space.status))}</dd>
            <dt>{t(locale, "detail.generation")}</dt>
            <dd>{space.generation}</dd>
            <dt>{t(locale, "detail.managed")}</dt>
            <dd>{space.managed ? t(locale, "detail.yes") : t(locale, "detail.no")}</dd>
            <dt>{t(locale, "detail.isolation")}</dt>
            <dd>{space.isolation}</dd>
          </dl>
        )}
        {detail && (
          <>
            <h3>{t(locale, "detail.plugins")}</h3>
            {detail.plugins.length === 0 ? <p className="dsh-wb-muted">{t(locale, "detail.pluginsEmpty")}</p> : (
              <ul>
                {detail.plugins.map((plugin) => (
                  <li key={plugin.name}>
                    {plugin.name} {plugin.version ?? t(locale, "app.status.unknown")}
                  </li>
                ))}
              </ul>
            )}
            <h3>{t(locale, "detail.diagnostics")}</h3>
            <ul>
              {detail.diagnostics.map((item) => (
                <li key={item.code} data-level={item.level}>
                  <code>{item.code}</code> {item.message}
                </li>
              ))}
            </ul>
          </>
        )}
        <DiagnosticsSection
          ui={ui}
          locale={locale}
          onCopy={() => copyRedacted(controller.copyDiagnostics())}
        />
        <h3>{t(locale, "detail.backups")}</h3>
        {ui.backups.length === 0 ? <p className="dsh-wb-muted">{t(locale, "detail.backupsEmpty")}</p> : null}
        {ui.backups.map((backup) => (
          <div key={backup.id} className="dsh-wb-space-row">
            <span>
              {backup.createdAt} · {backup.reason}
            </span>
          </div>
        ))}
        <div className="dsh-wb-actions">
          {space && !space.isHost && (
            <button type="button" className="dsh-wb-btn" disabled={!writable} onClick={() => controller.verifySpace(spaceId)}>
              {t(locale, "detail.verify")}
            </button>
          )}
          <button type="button" className="dsh-wb-btn" onClick={controller.closeOverlay}>
            {t(locale, "app.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function SpaceMenu({
  ui,
  controller,
  spaceId,
  x,
  y,
}: WorkbenchViewProps & { spaceId: string; x: number; y: number }): ReactElement {
  const locale = ui.locale;
  const space = controller.space(spaceId);
  const writable = controller.canMutate();
  const managed = Boolean(space?.managed);
  const running = space?.status === "running";
  const starting = space?.status === "starting";
  const crashed = space?.status === "crashed";
  const manager = controller.isManagerId(spaceId);
  return (
    <div className="dsh-wb-overlay" onClick={controller.closeOverlay}>
      <div
        className="dsh-wb-menu"
        role="menu"
        aria-label={t(locale, "app.menu")}
        style={{ left: x, top: y }}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          disabled={!writable || !managed || running || starting}
          onClick={() => {
            controller.closeOverlay();
            controller.startSpace(spaceId);
          }}
        >
          {running || starting ? t(locale, "app.alreadyRunning") : t(locale, "app.start")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!writable || !managed || (!running && !crashed)}
          onClick={() => {
            controller.closeOverlay();
            controller.preview({ kind: "space.restart", spaceId });
          }}
        >
          {t(locale, "app.restart")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!writable || !managed || (!running && !starting)}
          onClick={() => {
            controller.closeOverlay();
            controller.preview({ kind: "space.stop", spaceId });
          }}
        >
          {t(locale, "app.stop")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!writable}
          onClick={() => controller.openRename(spaceId)}
        >
          {t(locale, "app.rename")}
        </button>
        <button type="button" role="menuitem" disabled={!writable} onClick={() => controller.openIcon(spaceId)}>
          {t(locale, "app.changeIcon")}
        </button>
        <button type="button" role="menuitem" onClick={() => controller.openDetail(spaceId)}>
          {t(locale, "app.diagnose")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={manager || spaceId === "web"}
          onClick={() => {
            controller.closeOverlay();
            controller.openBlueprintGenerate(spaceId);
          }}
        >
          {t(locale, "blueprints.generate")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!writable || manager}
          onClick={() => {
            controller.closeOverlay();
            controller.preview({ kind: "space.delete", spaceId, removeData: false });
          }}
        >
          {t(locale, "app.delete")}
        </button>
      </div>
    </div>
  );
}

export function JobsList({
  locale,
  jobs,
  onCancel,
}: {
  locale: WorkbenchLocale;
  jobs: WorkbenchJob[];
  onCancel: (id: string) => void;
}): ReactElement {
  return (
    <section aria-label={t(locale, "jobs.progress")}>
      <h2 className="dsh-wb-title">{t(locale, "home.jobs")}</h2>
      {jobs.length === 0 ? <p className="dsh-wb-muted">{t(locale, "home.noJobs")}</p> : null}
      {jobs.map((job) => (
        <div
          key={job.id}
          className="dsh-wb-job"
          data-status={job.status}
          data-job-id={job.id}
          data-phase={job.phase}
        >
          <strong>{job.kind}</strong> · {job.status}
          <div>
            {t(locale, "jobs.phase")}: {job.phase} — {job.message}
          </div>
          {job.status === "succeeded" && job.phase === "handoff-pending" ? (
            <p className="dsh-wb-notice" role="status" data-handoff-pending="true">
              {t(locale, "jobs.handoffPending")}
            </p>
          ) : null}
          {job.status === "failed" && job.error && (
            <p className="dsh-wb-alert" role="alert">
              {t(locale, "jobs.failed")}: {job.message || job.error.message}
              {job.error.packageName
                ? ` · ${job.error.packageName}`
                : job.error.pluginAttribution === "unknown"
                  ? ` · ${t(locale, "app.status.unknown")}`
                  : ""}
            </p>
          )}
          {job.result?.product && (job.result.product.kind === "space.import" || job.result.product.kind === "template.create") ? (
            <ImportResultCard locale={locale} result={job.result.product.import} />
          ) : null}
          <BlueprintJobResult locale={locale} job={job} />
          {job.canCancel ? (
            <button type="button" className="dsh-wb-btn" onClick={() => onCancel(job.id)}>
              {t(locale, "jobs.cancel")}
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}

export function LanguageSwitch({
  locale,
  onChange,
}: {
  locale: WorkbenchLocale;
  onChange: (locale: WorkbenchLocale) => void;
}): ReactElement {
  return (
    <div className="dsh-wb-lang" role="group" aria-label={t(locale, "app.language")}>
      <button type="button" aria-pressed={locale === "zh"} onClick={() => onChange("zh")}>
        中文
      </button>
      <button type="button" aria-pressed={locale === "en"} onClick={() => onChange("en")}>
        English
      </button>
    </div>
  );
}

function statusKey(status: WorkbenchSpace["status"]): "app.status.running" | "app.status.starting" | "app.status.stopping" | "app.status.stopped" | "app.status.crashed" | "app.status.unknown" {
  if (status === "running") return "app.status.running";
  if (status === "starting") return "app.status.starting";
  if (status === "stopping") return "app.status.stopping";
  if (status === "stopped") return "app.status.stopped";
  if (status === "crashed") return "app.status.crashed";
  return "app.status.unknown";
}

export function RecoveryView({
  locale,
  state,
  error,
  commandError,
  onLocale,
  onCancelJob,
  onRefresh,
}: {
  locale: WorkbenchLocale;
  state: WorkbenchState | null;
  error: string | null;
  commandError: string | null;
  onLocale: (locale: WorkbenchLocale) => void;
  onCancelJob: (id: string) => void;
  onRefresh: () => void;
}): ReactElement {
  const logText = [
    ...(state?.reasons ?? []),
    ...(state?.jobs ?? []).map((job) =>
      [job.kind, job.status, job.phase, job.message, job.error?.message].filter(Boolean).join(" · "),
    ),
    error,
    commandError,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="dsh-workbench" lang={locale === "zh" ? "zh-CN" : "en"} data-locale={locale}>
      <style>{WORKBENCH_CSS}</style>
      <div className="dsh-wb-recovery">
        <div className="dsh-wb-row">
          <h1 className="dsh-wb-title">{t(locale, "recovery.title")}</h1>
          <LanguageSwitch locale={locale} onChange={onLocale} />
        </div>
        <p className="dsh-wb-muted">{t(locale, "recovery.body")}</p>
        {error && (
          <p className="dsh-wb-alert" role="alert">
            {error}
          </p>
        )}
        {commandError && (
          <p className="dsh-wb-alert" role="alert">
            {commandError}
          </p>
        )}
        <section>
          <h2>{t(locale, "app.errorDetails")}</h2>
          {state?.reasons.length ? (
            <ul>
              {state.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p className="dsh-wb-muted">{t(locale, "home.noReasons")}</p>
          )}
        </section>
        <section>
          <h2>{t(locale, "recovery.owner")}</h2>
          <p>{state?.owner ? `${state.owner.kind} · ${state.owner.since}` : t(locale, "recovery.noOwner")}</p>
        </section>
        <JobsList locale={locale} jobs={state?.jobs ?? []} onCancel={onCancelJob} />
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={() => copyRedacted(logText)}>
            {t(locale, "app.copyLogs")}
          </button>
          <button type="button" className="dsh-wb-btn" onClick={onRefresh}>
            {t(locale, "app.retry")}
          </button>
        </div>
      </div>
    </div>
  );
}
