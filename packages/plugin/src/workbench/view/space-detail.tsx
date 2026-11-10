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
import { SPACES_BLUEPRINT_SEALED } from "../../../../../src/shared/blueprint-sealed";
import { t, type WorkbenchLocale } from "../i18n";
import type { WorkbenchController, WorkbenchUiState } from "../store";
import { CopyButton, statusKey } from "./shared";
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
  const busy = controller.isBusy();
  const [tab, setTab] = useState<DetailTab>("general");
  useEffect(() => { setTab("general"); }, [spaceId]);
  if (!space) {
    return (
      <div className="dsh-wb-space-detail" data-space-detail="true" data-space-id={spaceId}>
        <button type="button" className="dsh-wb-btn" onClick={controller.closeDetail}>
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
  return (
    <div className="dsh-wb-space-detail" data-space-detail="true" data-space-id={space.id}>
      <header className="dsh-wb-space-detail-header">
        <button type="button" className="dsh-wb-btn" data-space-detail-back="true" onClick={controller.closeDetail}>
          {t(locale, "detail.back")}
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
            <code className="dsh-wb-muted">{space.id}</code>
            <CopyButton locale={locale} className="dsh-wb-btn" text={space.id} label={t(locale, "app.copyId")} />
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
        <ExportSection locale={locale} space={space} controller={controller} />
      </div>
      <div id="space-panel-plugins" role="tabpanel" aria-labelledby="space-tab-plugins" data-space-tab="plugins" hidden={tab !== "plugins"}>
        {tab === "plugins" ? <InlineErrors ui={ui} origin={`detail:${space.id}:plugins`} /> : null}
        <PluginsSection locale={locale} space={space} controller={controller} writable={writable} busy={busy} ui={ui} />
      </div>
      <div id="space-panel-advanced" role="tabpanel" aria-labelledby="space-tab-advanced" data-space-tab="advanced" hidden={tab !== "advanced"}>
        {tab === "advanced" ? <InlineErrors ui={ui} origin={`detail:${space.id}:dsh`} /> : null}
        <section className="dsh-wb-space-detail-card" data-space-section="dsh">
          {space.base === 'browser' ? <><h3 className="dsh-wb-title">Browser {space.baseVersion}</h3><p className="dsh-wb-muted">{t(locale, 'create.browserBaseHint')}</p></> : space.managed && !controller.isManagerId(space.id) ? (
            <DshVersionSection key={`${space.id}:${space.dshVersion ?? ""}`} ui={ui} controller={controller} space={space} />
          ) : (
            <p className="dsh-wb-muted">{t(locale, "detail.dshNotPinned")}</p>
          )}
        </section>
        {manageable && space.managed && space.base !== 'browser' && !controller.isManagerId(space.id) ? (
          <section className="dsh-wb-space-detail-card" data-space-section="models">
            <h3 className="dsh-wb-title">{t(locale, "detail.models.title")}</h3>
            <p className="dsh-wb-muted">{t(locale, "detail.models.hint")}</p>
            {!startable ? <p className="dsh-wb-muted">{t(locale, "detail.models.stoppedHint")}</p> : null}
            <div className="dsh-wb-actions">
              <button
                type="button"
                className="dsh-wb-btn"
                data-space-models-sync="true"
                disabled={!writable || busy || !startable}
                onClick={() => controller.preview({ kind: "space.models.sync", spaceId: space.id })}
              >
                {t(locale, "detail.models.sync")}
              </button>
            </div>
          </section>
        ) : null}
        <section className="dsh-wb-space-detail-card" data-space-section="diagnostics">
          <DiagnosticsSection ui={ui} locale={locale} text={() => controller.copyDiagnostics()} />
        </section>
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
        <section className="dsh-wb-space-detail-card dsh-wb-danger-zone" data-space-section="danger">
          <h3 className="dsh-wb-title">{t(locale, "detail.danger")}</h3>
          <p className="dsh-wb-muted">{t(locale, "detail.deleteHint")}</p>
          {manageable ? (
            <div className="dsh-wb-actions">
              <button
                type="button"
                className="dsh-wb-btn danger"
                disabled={!writable || busy}
                onClick={() => controller.preview({ kind: "space.delete", spaceId: space.id, removeData: false })}
              >
                {t(locale, "app.delete")}
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
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
function ExportSection({
  locale,
  space,
  controller,
}: {
  locale: WorkbenchLocale;
  space: WorkbenchSpace;
  controller: WorkbenchController;
}): ReactElement {
  return (
    <section className="dsh-wb-space-detail-card" data-space-section="export">
      <h3 className="dsh-wb-title">{t(locale, "detail.export")}</h3>
      <p className="dsh-wb-muted">{t(locale, "detail.exportHint")}</p>
      <div className="dsh-wb-actions">
        {!SPACES_BLUEPRINT_SEALED ? (
          <button
            type="button"
            className="dsh-wb-btn"
            disabled={controller.isManagerId(space.id) || space.id === "web"}
            onClick={() => controller.openBlueprintGenerate(space.id)}
          >
            {t(locale, "detail.exportTemplate")}
          </button>
        ) : null}
        <button
          type="button"
          className="dsh-wb-btn"
          onClick={() => {
            controller.setShareSpaceId(space.id);
            controller.setTemplateSpaceId(space.id);
            controller.setSettingsTab("templates");
          }}
        >
          {t(locale, "detail.exportShare")}
        </button>
      </div>
    </section>
  );
}
