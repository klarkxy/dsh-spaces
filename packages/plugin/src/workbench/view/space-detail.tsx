/**
 * The space detail page.
 *
 * It replaces the old detail dialog: every action that belongs to one space
 * has exactly one authoritative place. The page is rendered inside the spaces
 * tab of the settings surface. A compact header carries identity and the
 * lifecycle actions; everything else lives under three tabs — 常规 / 插件 /
 * 高级 — so a short space never scrolls past unrelated sections.
 *
 * Failures are never part of an entrance animation: a read error or a failed
 * write is readable from the first frame, and an error that arrives after the
 * user switched tabs also surfaces under the header.
 */

import React, { useEffect, useState, type ReactElement } from "react";
import type { WorkbenchSpace } from "../../../../../src/shared/workbench";
import type { SpaceDetail } from "../../../../../src/shared/spaces-control";
import { isFullSpacesManagerSpec } from "../../../../../src/shared/plugin-spec";
import { t, type WorkbenchLocale } from "../i18n";
import type { WorkbenchController, WorkbenchUiState } from "../store";
import { CopyButton, statusKey } from "./shared";
import { jobKindLabel, jobPhaseLabel } from "./jobs";
import { DshVersionSection } from "./dsh-version";
import { SpaceGlyph } from "../space-glyph";
import { InlineErrors } from "../inline-error";
import { PluginsSection } from "./plugin-section";
import { DiagnosticsSection } from "../product-ui";

type DetailTab = "general" | "plugins" | "advanced";

export function SpaceDetailPage({
  ui,
  controller,
  spaceId,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  spaceId: string;
}): ReactElement {
  const locale = ui.locale;
  const space = controller.space(spaceId);
  // The manager space and unmanaged spaces are shown, never operated.
  const manageable = Boolean(space?.managed) && !controller.isManagerId(spaceId);
  const writable = controller.canMutate() && manageable;
  const busy = controller.isSpaceBusy(spaceId);
  const activeJob = controller.activeJobForSpace(spaceId);
  const [tab, setTab] = useState<DetailTab>("general");
  const [removeData, setRemoveData] = useState(false);
  useEffect(() => {
    setTab("general");
    setRemoveData(false);
  }, [spaceId]);
  if (!space) {
    return (
      <div className="dsh-wb-space-detail" data-space-detail="true" data-space-id={spaceId}>
        <button type="button" className="dsh-wb-btn dsh-wb-detail-missing-back" onClick={controller.closeDetail}>
          {t(locale, "detail.back")}
        </button>
        <p className="dsh-wb-notice">{t(locale, "detail.spaceMissing")}</p>
      </div>
    );
  }
  const tabs: [DetailTab, Parameters<typeof t>[1]][] = [
    ["general", "detail.tabGeneral"],
    ["plugins", "detail.tabPlugins"],
    ["advanced", "detail.tabAdvanced"],
  ];
  const startable = space.status === "stopped" || space.status === "crashed";
  const active = space.status === "running" || space.status === "starting";
  const hasMisinstalledSpaces =
    (ui.detail?.space.id === space.id && ui.detail.plugins.some((item) => isFullSpacesManagerSpec(item.name))) ||
    ui.plugins.some((plugin) => isFullSpacesManagerSpec(plugin.packageName) && plugin.installedIn.includes(space.id));
  return (
    <div className="dsh-wb-space-detail" data-space-detail="true" data-space-id={space.id}>
      <header className="dsh-wb-space-detail-header">
        <button
          type="button"
          className="dsh-wb-detail-back"
          data-space-detail-back="true"
          aria-label={t(locale, "detail.back")}
          title={t(locale, "detail.back")}
          onClick={controller.closeDetail}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14.25 9H3.75M8.25 4.5L3.75 9l4.5 4.5" />
          </svg>
        </button>
        <span className="dsh-wb-detail-icon" aria-hidden="true"><SpaceGlyph spaceId={space.id} icon={space.icon} /></span>
        <div className="dsh-wb-detail-id">
          <h3 className="dsh-wb-title">{space.displayName}</h3>
          <span>
            <span className="dsh-wb-muted">
              {t(locale, statusKey(space.status))}
              {space.isHost ? ` · ${t(locale, "detail.host")}` : ""}
              {!space.managed ? ` · ${t(locale, "app.unmanaged")}` : ""}
            </span>
          </span>
        </div>
        {manageable ? (
          <div className="dsh-wb-actions">
            <button type="button" className="dsh-wb-btn primary" disabled={!writable || busy} onClick={() => controller.selectSpace(space.id)}>
              {t(locale, "detail.enter")}
            </button>
            {startable ? (
              <button type="button" className="dsh-wb-btn" disabled={!writable || busy} onClick={() => controller.startSpace(space.id)}>
                {t(locale, "app.start")}
              </button>
            ) : null}
            {active ? (
              <>
                <button type="button" className="dsh-wb-btn" disabled={!writable || busy} onClick={() => controller.preview({ kind: "space.stop", spaceId: space.id })}>
                  {t(locale, "app.stop")}
                </button>
                <button type="button" className="dsh-wb-btn" disabled={!writable || busy} onClick={() => controller.preview({ kind: "space.restart", spaceId: space.id })}>
                  {t(locale, "app.restart")}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </header>
      {ui.readError.detail ? <p className="dsh-wb-alert" role="alert">{ui.readError.detail}</p> : null}
      {activeJob ? (
        <p className="dsh-wb-notice" role="status" data-space-job-status={activeJob.status}>
          {activeJob.status === "queued"
            ? t(locale, "detail.spaceQueued", { job: jobKindLabel(locale, activeJob.kind) })
            : t(locale, "detail.spaceRunningJob", { job: jobKindLabel(locale, activeJob.kind), phase: jobPhaseLabel(locale, activeJob.phase) })}
        </p>
      ) : null}
      {ui.pluginOutcomeNotice?.spaceIds.includes(space.id) ? (
        <div className="dsh-wb-notice" role="status" data-plugin-outcome={ui.pluginOutcomeNotice.application}>
          <p>
            {t(
              locale,
              ui.pluginOutcomeNotice.application === "restart-required"
                ? "plugins.outcome.restartRequired"
                : "plugins.outcome.applied",
            )}
          </p>
          <div className="dsh-wb-actions">
            {ui.pluginOutcomeNotice.application === "restart-required" ? (
              <>
                <button
                  type="button"
                  className="dsh-wb-btn primary"
                  data-plugin-restart-now="true"
                  disabled={!writable || busy}
                  onClick={() => controller.restartFromPluginOutcome(space.id)}
                >
                  {t(locale, "plugins.outcome.restartNow")}
                </button>
                <button
                  type="button"
                  className="dsh-wb-btn"
                  data-plugin-restart-later="true"
                  onClick={() => controller.dismissPluginOutcome(space.id)}
                >
                  {t(locale, "plugins.outcome.restartLater")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="dsh-wb-btn"
                data-plugin-outcome-dismiss="true"
                onClick={() => controller.dismissPluginOutcome(space.id)}
              >
                {t(locale, "plugins.outcome.dismiss")}
              </button>
            )}
          </div>
        </div>
      ) : null}
      <InlineErrors ui={ui} origin={`detail:${space.id}`} />
      {tab !== "plugins" ? <InlineErrors ui={ui} origin={`detail:${space.id}:plugins`} /> : null}
      {tab !== "advanced" ? <InlineErrors ui={ui} origin={`detail:${space.id}:dsh`} /> : null}
      <div className="dsh-wb-detail-tabs" role="tablist" aria-label={space.displayName} aria-orientation="horizontal" data-space-tablist="true">
        {tabs.map(([candidate, label], index) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            id={`space-tab-${candidate}`}
            aria-controls={`space-panel-${candidate}`}
            aria-selected={tab === candidate}
            tabIndex={tab === candidate ? 0 : -1}
            className="dsh-wb-tab"
            onClick={() => setTab(candidate)}
            onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
                : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                : event.key === "Home" ? 0
                : event.key === "End" ? tabs.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              document.getElementById(`space-tab-${tabs[next][0]}`)?.focus();
              setTab(tabs[next][0]);
            }}
          >
            {t(locale, label)}
          </button>
        ))}
      </div>
      <div id="space-panel-general" role="tabpanel" aria-labelledby="space-tab-general" data-space-tab="general" hidden={tab !== "general"}>
        <AppearanceSection locale={locale} space={space} controller={controller} writable={writable} manageable={manageable} />
        {manageable ? (
          <StartupSection locale={locale} space={space} controller={controller} writable={writable} />
        ) : null}
        {manageable && space.managed && space.base !== 'browser' && !controller.isManagerId(space.id) ? (
          <ModelsSection locale={locale} space={space} controller={controller} writable={writable} busy={busy} detail={ui.detail} />
        ) : null}
      </div>
      <div id="space-panel-plugins" role="tabpanel" aria-labelledby="space-tab-plugins" data-space-tab="plugins" hidden={tab !== "plugins"}>
        {tab === "plugins" ? <InlineErrors ui={ui} origin={`detail:${space.id}:plugins`} /> : null}
        <PluginsSection locale={locale} space={space} controller={controller} writable={writable} busy={busy} ui={ui} />
      </div>
      <div id="space-panel-advanced" role="tabpanel" aria-labelledby="space-tab-advanced" data-space-tab="advanced" hidden={tab !== "advanced"}>
        {tab === "advanced" ? <InlineErrors ui={ui} origin={`detail:${space.id}:dsh`} /> : null}
        <section className="dsh-wb-space-detail-card" data-space-section="identity">
          <div className="dsh-wb-preference-row">
            <span>
              {t(locale, "detail.id")}: <code>{space.id}</code>
            </span>
            <CopyButton locale={locale} className="dsh-wb-btn" text={space.id} label={t(locale, "app.copyId")} />
          </div>
        </section>
        <section className="dsh-wb-space-detail-card" data-space-section="dsh">
          {space.base === 'browser' ? <h3 className="dsh-wb-title">Browser {space.baseVersion}</h3> : space.managed && !controller.isManagerId(space.id) ? (
            <DshVersionSection key={`${space.id}:${space.dshVersion ?? ""}`} ui={ui} controller={controller} space={space} />
          ) : (
            <p className="dsh-wb-muted">{t(locale, "detail.dshNotPinned")}</p>
          )}
        </section>
        <section className="dsh-wb-space-detail-card" data-space-section="diagnostics">
          <DiagnosticsSection
            ui={ui}
            locale={locale}
            text={() => controller.copyDiagnostics()}
            onRefresh={() => controller.refreshSpaceDetail(space.id)}
          />
        </section>
        {hasMisinstalledSpaces ? (
          <section className="dsh-wb-space-detail-card" data-space-section="cleanup">
            <p className="dsh-wb-muted">{t(locale, "plugins.cleanupHint")}</p>
            <div className="dsh-wb-actions">
              <button
                type="button"
                className="dsh-wb-btn"
                disabled={!writable || busy}
                onClick={() => controller.preview({ kind: "plugin.cleanup-manager", spaceId: space.id })}
              >
                {t(locale, "plugins.cleanup")}
              </button>
            </div>
          </section>
        ) : null}
        <section className="dsh-wb-space-detail-card dsh-wb-danger-zone" data-space-section="danger">
          <h3 className="dsh-wb-title">{t(locale, "detail.danger")}</h3>
          <p className="dsh-wb-muted">{t(locale, removeData ? "detail.deleteHintWithData" : "detail.deleteHint")}</p>
          {manageable ? (
            <>
              <label className="dsh-wb-check">
                <input
                  type="checkbox"
                  checked={removeData}
                  disabled={!writable || busy}
                  data-space-delete-remove-data="true"
                  onChange={(event) => setRemoveData(event.target.checked)}
                />
                {t(locale, "detail.deleteRemoveData")}
              </label>
              <div className="dsh-wb-actions">
                <button
                  type="button"
                  className="dsh-wb-btn danger"
                  disabled={!writable || busy}
                  onClick={() => controller.preview({ kind: "space.delete", spaceId: space.id, removeData })}
                >
                  {t(locale, "app.delete")}
                </button>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function ModelsSection({
  locale,
  space,
  controller,
  writable,
  busy,
  detail,
}: {
  locale: WorkbenchLocale;
  space: WorkbenchSpace;
  controller: WorkbenchController;
  writable: boolean;
  busy: boolean;
  detail: SpaceDetail | null;
}): ReactElement {
  const models = detail?.space.id === space.id ? detail.models : undefined;
  const transitioning = space.status === "starting" || space.status === "stopping";
  const status = models?.status;
  return (
    <section className="dsh-wb-space-detail-card" data-space-section="models">
      <h3 className="dsh-wb-title">{t(locale, "detail.models.title")}</h3>
      <p data-space-models-state={status ?? "loading"}>
        {!models ? t(locale, "detail.models.reading") : null}
        {status === "configured" && models ? t(locale, "detail.models.configured", { model: models.defaultModel ?? "", routes: String(models.routeNames.length) }) : null}
        {status === "incomplete" ? t(locale, "detail.models.incomplete") : null}
        {status === "unconfigured" ? t(locale, "detail.models.unconfigured") : null}
      </p>
      {status === "incomplete" && models ? (
        <p className="dsh-wb-muted" data-space-models-incomplete="true">
          {[
            models.defaultModel ? "" : t(locale, "detail.models.missingDefault"),
            models.missingCredentials.length ? t(locale, "detail.models.missingKeys", { keys: models.missingCredentials.join(", ") }) : "",
          ].filter(Boolean).join(" ")}
        </p>
      ) : null}
      {transitioning ? <p className="dsh-wb-muted">{t(locale, "detail.models.transitionHint")}</p> : null}
      <div className="dsh-wb-actions">
        <button
          type="button"
          className={`dsh-wb-btn${status === "unconfigured" ? " primary" : ""}`}
          data-space-models-sync="true"
          disabled={!writable || busy || transitioning}
          onClick={() => controller.preview({ kind: "space.models.sync", spaceId: space.id })}
        >
          {t(locale, "detail.models.sync")}
        </button>
      </div>
    </section>
  );
}

function StartupSection({
  locale,
  space,
  controller,
  writable,
}: {
  locale: WorkbenchLocale;
  space: WorkbenchSpace;
  controller: WorkbenchController;
  writable: boolean;
}): ReactElement {
  return (
    <section className="dsh-wb-space-detail-card" data-space-section="startup">
      <h3 className="dsh-wb-title">{t(locale, "detail.startup")}</h3>
      <label className="dsh-wb-preference-row">
        <span>
          {t(locale, "detail.startWithDesktop")}
          <small className="dsh-wb-muted">{t(locale, "detail.startWithDesktopHint")}</small>
        </span>
        <input
          type="checkbox"
          checked={space.startWithDesktop}
          data-space-start-with-desktop="true"
          disabled={!writable}
          onChange={(event) => controller.updateSpace(space.id, { startWithDesktop: event.target.checked })}
        />
      </label>
    </section>
  );
}

function AppearanceSection({
  locale,
  space,
  controller,
  writable,
  manageable,
}: {
  locale: WorkbenchLocale;
  space: WorkbenchSpace;
  controller: WorkbenchController;
  writable: boolean;
  manageable: boolean;
}): ReactElement {
  const [name, setName] = useState(space.displayName);
  useEffect(() => { setName(space.displayName); }, [space.displayName]);
  const dirty = name.trim() !== space.displayName;
  return (
    <section className="dsh-wb-space-detail-card" data-space-section="appearance">
      <h3 className="dsh-wb-title">{t(locale, "detail.appearance")}</h3>
      <label className="dsh-wb-field">
        {t(locale, "detail.displayName")}
        <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" data-space-display-name="true" disabled={!manageable} />
      </label>
      {manageable ? (
        <div className="dsh-wb-actions">
          <span className="dsh-wb-detail-icon" aria-hidden="true"><SpaceGlyph spaceId={space.id} icon={space.icon} /></span>
          <button type="button" className="dsh-wb-btn" onClick={() => controller.openIcon(space.id)}>
            {t(locale, "detail.changeIcon")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn primary"
            disabled={!writable || !dirty}
            onClick={() => controller.updateSpace(space.id, { displayName: name.trim() || space.displayName })}
          >
            {t(locale, "app.save")}
          </button>
          {dirty ? <span className="dsh-wb-muted">{t(locale, "detail.unsaved")}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
