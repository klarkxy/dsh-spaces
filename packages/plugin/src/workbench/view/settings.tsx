/**
 * The settings surface.
 *
 * It renders either as a dialog on top of the stage or as the native settings
 * page. The navigation follows the task the user has in mind: four everyday
 * groups first, the operational ones inside a maintenance group that stays
 * visible but collapsed. The selected tab carries a shared-layout indicator
 * that slides down the navigation, and the tab panel slides in (opacity pinned
 * at 1, so a failure reason in it is readable from the first frame).
 */

import React, { useEffect, useRef, type ReactElement } from "react";
import { LayoutIndicator, VisibleSlide } from "../../../../../src/shared/ui";
import { PanelScale } from "./motion";
import { LlmModelCenter } from "../llm/center";
import { LegacyConnectionSettings } from "../llm/legacy-settings";
import { HomeSettingsFields, ThemeSwitch } from "../product-ui";
import { InlineErrors } from "../inline-error";
import { t } from "../i18n";
import { CreatedNotice, type WorkbenchViewProps } from "./shared";
import { ManagementContent, StatusBanners } from "./management";
import { LanguageSwitch } from "./jobs";

type SettingsTab = WorkbenchViewProps["ui"]["settingsTab"];

/** The everyday destinations, in the order the plan gives them. */
const MAIN_TABS: Array<[SettingsTab, Parameters<typeof t>[1]]> = [
  ["spaces", "settings.nav.spaces"],
  ["templates", "settings.nav.templates"],
  ["llm", "settings.nav.models"],
  ["general", "settings.nav.general"],
];

/** The operational destinations. They live in the collapsible maintenance group. */
const MAINTENANCE_TABS: Array<[SettingsTab, Parameters<typeof t>[1]]> = [
  ["overview", "settings.nav.overview"],
  ["snapshots", "settings.nav.backups"],
  ["runtime", "settings.nav.runtime"],
  ["advanced", "settings.nav.service"],
];

export function SettingsDialog({ ui, controller, systemPage, requestServiceStop }: WorkbenchViewProps): ReactElement {
  const asPage = systemPage === "settings";
  const locale = ui.locale;
  const writable = controller.canMutate();
  const busy = controller.isBusy();
  const dialog = useRef<HTMLDivElement>(null);
  // Keyboard navigation can land on a tab that is only rendered after this
  // update (crossing into a collapsed maintenance group), so focus follows the
  // render instead of running synchronously in the key handler.
  const focusTab = useRef<SettingsTab | null>(null);
  useEffect(() => {
    const tab = focusTab.current;
    if (!tab) return;
    focusTab.current = null;
    document.getElementById(`settings-tab-${tab}`)?.focus();
  }, [ui.settingsTab]);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>(asPage ? '[role="tab"][aria-selected="true"]' : "[data-settings-close]")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  // The maintenance group is expanded while one of its tabs is open, so the
  // active tab is never hidden behind a collapsed group.
  const maintenanceOpen = ui.maintenanceExpanded || MAINTENANCE_TABS.some(([tab]) => tab === ui.settingsTab);
  const visibleTabs = [...MAIN_TABS, ...(maintenanceOpen ? MAINTENANCE_TABS : [])];
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (asPage) return;
    if (ui.pendingPlan) return;
    if (event.key === "Escape") { event.preventDefault(); controller.closeOverlay(); }
    if (event.key === "Tab") {
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]') ?? []).filter((el) => el.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const onBackdrop = (event: React.MouseEvent<HTMLElement>): void => {
    if (!asPage && event.target === event.currentTarget && !ui.pendingPlan) controller.closeOverlay();
  };
  const tabButton = ([tab, label]: [SettingsTab, Parameters<typeof t>[1]]): ReactElement => (
    <button
      key={tab}
      type="button"
      role="tab"
      id={`settings-tab-${tab}`}
      aria-controls="settings-panel"
      aria-selected={ui.settingsTab === tab}
      tabIndex={ui.settingsTab === tab ? 0 : -1}
      className="dsh-wb-tab"
      onClick={() => controller.setSettingsTab(tab)}
      onKeyDown={(event) => {
        const index = visibleTabs.findIndex(([candidate]) => candidate === tab);
        const next = event.key === "ArrowDown" ? (index + 1) % visibleTabs.length : event.key === "ArrowUp" ? (index + visibleTabs.length - 1) % visibleTabs.length : event.key === "Home" ? 0 : event.key === "End" ? visibleTabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        const target = visibleTabs[next][0];
        if (target === ui.settingsTab) { document.getElementById(`settings-tab-${target}`)?.focus(); return; }
        focusTab.current = target;
        controller.setSettingsTab(target);
      }}
    >
      {ui.settingsTab === tab ? <LayoutIndicator as="span" layoutId="dsh-wb-settings-tab" className="dsh-wb-settings-tab-indicator" /> : null}
      {t(locale, label)}
    </button>
  );
  const panel = (
    <>
      <header className="dsh-wb-settings-header">
        <h2 id="dsh-wb-settings-title" className="dsh-wb-title">{t(locale, "settings.title")}</h2>
        {!asPage && <button type="button" className="dsh-wb-btn dsh-wb-settings-close" data-settings-close="true" onClick={controller.closeOverlay}>
          <span aria-hidden="true">×</span> {t(locale, "app.close")}
        </button>}
      </header>
      <div className="dsh-wb-settings-body">
        <div className="dsh-wb-settings-nav">
          <div className="dsh-wb-settings-tablist" role="tablist" aria-label={t(locale, "settings.title")} aria-orientation="vertical">
            {MAIN_TABS.map(tabButton)}
          </div>
          <button
            type="button"
            className="dsh-wb-settings-group-toggle"
            aria-expanded={maintenanceOpen}
            aria-controls="dsh-wb-settings-maintenance"
            data-settings-maintenance="true"
            onClick={controller.toggleMaintenance}
          >
            <span className="dsh-wb-settings-group-caret" aria-hidden="true">{maintenanceOpen ? "▾" : "▸"}</span>
            {t(locale, "settings.nav.maintenance")}
          </button>
          <div
            className="dsh-wb-settings-tablist"
            id="dsh-wb-settings-maintenance"
            role="tablist"
            aria-label={t(locale, "settings.nav.maintenance")}
            aria-orientation="vertical"
            hidden={!maintenanceOpen}
          >
            {MAINTENANCE_TABS.map(tabButton)}
          </div>
        </div>
        <VisibleSlide
          key={ui.settingsTab}
          from={8}
          className="dsh-wb-settings-content"
          role="tabpanel"
          id="settings-panel"
          aria-labelledby={`settings-tab-${ui.settingsTab}`}
          tabIndex={0}
        >
          <StatusBanners ui={ui} />
          {asPage && <CreatedNotice ui={ui} controller={controller} inline />}
          {ui.settingsTab === "general" && <>
            <h3 className="dsh-wb-title">{t(locale, "settings.clientPrefs")}</h3>
            <div className="dsh-wb-preference-row"><span>{t(locale, "settings.locale")}</span><LanguageSwitch locale={locale} onChange={controller.setLocale} /></div>
            <div className="dsh-wb-preference-row"><span>{t(locale, "settings.theme")}</span><ThemeSwitch locale={locale} theme={ui.theme} onChange={controller.setTheme} /></div>
          </>}
          {ui.settingsTab === "advanced" && <>
            <HomeSettingsFields ui={ui} controller={controller} />
            <section className="dsh-wb-settings-service dsh-wb-danger-zone" data-settings-service="true">
              <h3 className="dsh-wb-title">{t(locale, "settings.service.danger")}</h3>
              <h4 className="dsh-wb-title">{t(locale, "settings.service.stopTitle")}</h4>
              <p className="dsh-wb-muted">{t(locale, "settings.service.stopHint")}</p>
              <p className="dsh-wb-muted">{t(locale, "settings.shutdownVsExit")}</p>
              <InlineErrors ui={ui} origin="service" />
              <div><button type="button" className="dsh-wb-btn danger" disabled={!writable || busy} onClick={requestServiceStop ?? (() => controller.preview({ kind: "service.shutdown" }))}>{t(locale, "settings.service.stop")}</button></div>
            </section>
          </>}
          {ui.settingsTab === "llm" && <>
            <h3 className="dsh-wb-title">{t(locale, "settings.models")}</h3>
            <p className="dsh-wb-muted">{t(locale, "llm.modelSettingsHint")}</p>
            <LegacyConnectionSettings locale={locale}>
              <LlmModelCenter locale={locale} writable={writable} client={controller.llmClient()} spaces={controller.llmSpaces()} uuid={crypto.randomUUID.bind(crypto)} />
            </LegacyConnectionSettings>
          </>}
          <ManagementContent ui={ui} controller={controller} />
        </VisibleSlide>
      </div>
    </>
  );
  if (asPage) {
    return (
      <div className="dsh-wb-settings-page" onClick={onBackdrop}>
        <div
          ref={dialog}
          className="dsh-wb-dialog dsh-wb-settings"
          role="region"
          aria-labelledby="dsh-wb-settings-title"
          data-settings-dialog="true"
          onKeyDown={onKeyDown}
        >
          {panel}
        </div>
      </div>
    );
  }
  return (
    <div className="dsh-wb-overlay" onClick={onBackdrop}>
      <PanelScale
        ref={dialog}
        className="dsh-wb-dialog dsh-wb-settings"
        role="dialog"
        aria-modal={true}
        aria-labelledby="dsh-wb-settings-title"
        data-settings-dialog="true"
        onKeyDown={onKeyDown}
      >
        {panel}
      </PanelScale>
    </div>
  );
}
