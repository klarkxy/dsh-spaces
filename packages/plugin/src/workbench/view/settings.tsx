/**
 * The settings surface.
 *
 * It renders either as a dialog on top of the stage or as the native settings
 * page. The navigation keeps four flat destinations: spaces, templates,
 * general and maintenance. The selected tab carries a shared-layout indicator
 * that slides down the navigation, and the tab panel slides in (opacity pinned
 * at 1, so a failure reason in it is readable from the first frame).
 */

import React, { useEffect, useRef, useState, type ReactElement } from "react";
import { LayoutIndicator, VisibleScale, VisibleSlide } from "../../../../../src/shared/ui/motion";
import { HomeSettingsFields, ThemeSwitch } from "../product-ui";
import { t } from "../i18n";
import { CreatedNotice, type WorkbenchViewProps } from "./shared";
import { ManagementContent, StatusBanners } from "./management";
import { LanguageSwitch } from "./jobs";

type SettingsTab = WorkbenchViewProps["ui"]["settingsTab"];

/** The four top-level settings destinations. */
const SETTINGS_TABS: Array<[SettingsTab, Parameters<typeof t>[1]]> = [
  ["spaces", "settings.nav.spaces"],
  ["templates", "settings.nav.templates"],
  ["general", "settings.nav.general"],
  ["overview", "settings.nav.maintenance"],
];

function canonicalNavTab(tab: SettingsTab): SettingsTab {
  if (tab === "plugins") return "spaces";
  if (tab === "blueprints") return "templates";
  if (tab === "snapshots" || tab === "runtime" || tab === "advanced") return "overview";
  return tab;
}

export function SettingsDialog({ ui, controller, systemPage, requestServiceStop }: WorkbenchViewProps): ReactElement {
  const asPage = systemPage === "settings";
  const locale = ui.locale;
  const dialog = useRef<HTMLDivElement>(null);
  const focusTab = useRef<SettingsTab | null>(null);
  const activeTab = canonicalNavTab(ui.settingsTab);
  const hasChildOverlay = Boolean(ui.overlay && ui.overlay.type !== "settings") || Boolean(ui.pendingPlan);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const hasSettingsAlert =
    ui.settingsStatus === "error" ||
    (ui.requestOrigin === "general:settings" && Boolean(ui.commandError || ui.planError));
  useEffect(() => {
    if (hasSettingsAlert) setAdvancedOpen(true);
  }, [hasSettingsAlert]);
  useEffect(() => {
    const tab = focusTab.current;
    if (!tab) return;
    focusTab.current = null;
    document.getElementById(`settings-tab-${tab}`)?.focus();
  }, [activeTab]);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>(asPage ? '[role="tab"][aria-selected="true"]' : "[data-settings-close]")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (asPage) return;
    if (hasChildOverlay) return;
    if (event.key === "Escape") { event.preventDefault(); controller.closeOverlay(); }
    if (event.key === "Tab") {
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]') ?? []).filter((el) => el.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const onBackdrop = (event: React.MouseEvent<HTMLElement>): void => {
    if (!asPage && event.target === event.currentTarget && !hasChildOverlay) controller.closeOverlay();
  };
  const tabButton = ([tab, label]: [SettingsTab, Parameters<typeof t>[1]]): ReactElement => (
    <button
      key={tab}
      type="button"
      role="tab"
      id={`settings-tab-${tab}`}
      aria-controls="settings-panel"
      aria-selected={activeTab === tab}
      tabIndex={activeTab === tab ? 0 : -1}
      className="dsh-wb-tab"
      onClick={() => controller.setSettingsTab(tab)}
      onKeyDown={(event) => {
        const index = SETTINGS_TABS.findIndex(([candidate]) => candidate === tab);
        const next = event.key === "ArrowDown" ? (index + 1) % SETTINGS_TABS.length : event.key === "ArrowUp" ? (index + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length : event.key === "Home" ? 0 : event.key === "End" ? SETTINGS_TABS.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        const target = SETTINGS_TABS[next][0];
        if (target === activeTab) { document.getElementById(`settings-tab-${target}`)?.focus(); return; }
        focusTab.current = target;
        controller.setSettingsTab(target);
      }}
    >
      {activeTab === tab ? <LayoutIndicator as="span" layoutId="dsh-wb-settings-tab" className="dsh-wb-settings-tab-indicator" /> : null}
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
            {SETTINGS_TABS.map(tabButton)}
          </div>
        </div>
        <VisibleSlide
          key={activeTab}
          from={8}
          className="dsh-wb-settings-content"
          role="tabpanel"
          id="settings-panel"
          aria-labelledby={`settings-tab-${activeTab}`}
          tabIndex={0}
        >
          <StatusBanners ui={ui} />
          {asPage && <CreatedNotice ui={ui} controller={controller} inline />}
          {ui.settingsTab === "general" && <>
            <h3 className="dsh-wb-title">{t(locale, "settings.clientPrefs")}</h3>
            <div className="dsh-wb-preference-row"><span>{t(locale, "settings.locale")}</span><LanguageSwitch locale={locale} onChange={controller.setLocale} /></div>
            <div className="dsh-wb-preference-row"><span>{t(locale, "settings.theme")}</span><ThemeSwitch locale={locale} theme={ui.theme} onChange={controller.setTheme} /></div>
            <details
              className="dsh-wb-create-advanced"
              data-settings-advanced="true"
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary>{t(locale, "settings.advancedTitle")}</summary>
              <div className="dsh-wb-create-advanced-body">
                <HomeSettingsFields ui={ui} controller={controller} section="all" />
              </div>
            </details>
          </>}
          <ManagementContent ui={ui} controller={controller} requestServiceStop={requestServiceStop} />
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
      <VisibleScale
        ref={dialog}
        className="dsh-wb-dialog dsh-wb-settings"
        role="dialog"
        aria-modal={true}
        aria-labelledby="dsh-wb-settings-title"
        data-settings-dialog="true"
        onKeyDown={onKeyDown}
      >
        {panel}
      </VisibleScale>
    </div>
  );
}
