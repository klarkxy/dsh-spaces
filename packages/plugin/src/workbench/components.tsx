/**
 * The workbench root.
 *
 * The root owns the surface frame: the token layer, the rail, the stage and
 * the overlays. The individual views live under `view/`; this file stays the
 * stable entry point that every other module and test imports.
 */

import React, { useEffect, type ReactElement } from "react";
import { MotionRoot } from "../../../../src/shared/ui";
import { installBrowserRelay } from "./browser-relay";
import { t } from "./i18n";
import { WORKBENCH_CSS } from "./styles";
import { CreatedNotice, type WorkbenchViewProps } from "./view/shared";
import { Rail } from "./view/rail";
import { StatusBanners } from "./view/management";
import { WorkspaceChrome, WorkspaceFrames } from "./view/frames";
import { Overlays } from "./view/dialogs";
import { LanguageSwitch } from "./view/jobs";

export { SpaceGlyph } from "./space-glyph";
export { IconPicker } from "./view/dialogs";
export { JobsList, LanguageSwitch } from "./view/jobs";
export { CreatedNotice, type WorkbenchViewProps } from "./view/shared";
export { Rail } from "./view/rail";
export { ManagementContent, StatusBanners } from "./view/management";
export { WorkspaceChrome, WorkspaceFrames } from "./view/frames";
export { Overlays } from "./view/dialogs";
export { SettingsDialog } from "./view/settings";
export { SpaceMenu } from "./view/menu";

export function WorkbenchView({ ui, controller, homeUrl, homeContent, chatActive = false, contained = false, nativeSurface = false, systemPage }: WorkbenchViewProps): ReactElement {
  useEffect(() => installBrowserRelay(controller), [controller]);
  const locale = ui.locale;
  const visibleSystemPage = ui.selected === "home" ? systemPage : null;
  return (
    <MotionRoot>
      <div className="dsh-workbench dsh-ui" lang={locale === "zh" ? "zh-CN" : "en"} data-locale={locale} data-theme={ui.theme} data-contained={contained ? "true" : undefined} data-native-surface={nativeSurface ? "true" : undefined}>
        <style>{WORKBENCH_CSS}</style>
        {nativeSurface ? null : contained ? <nav className="dsh-wb-contained-tools" aria-label={t(locale, "app.title")}>
          <button type="button" className="dsh-wb-btn" onClick={controller.selectHome}>{t(locale, "app.home")}</button>
          <button type="button" className="dsh-wb-btn" onClick={controller.openCreate} disabled={!controller.canMutate()}>{t(locale, "app.newSpace")}</button>
          <button type="button" className="dsh-wb-btn" onClick={controller.openSettings}>{t(locale, "app.settings")}</button>
        </nav> : <Rail ui={ui} controller={controller} />}
        <div className="dsh-wb-main" inert={ui.overlay?.type === "settings" || undefined}>
          {homeUrl && <iframe className="dsh-wb-frame dsh-wb-home-frame" title="DSH" src={homeUrl} data-home-view="true" allow="clipboard-write" hidden={ui.selected !== "home" || (homeContent != null && !chatActive)} style={homeContent != null ? { top: 52, height: "calc(100% - 52px)" } : undefined} referrerPolicy="no-referrer" />}
          {homeContent != null && <div className="dsh-wb-home-surface" hidden={ui.selected !== "home"}>{homeContent}</div>}
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
            </div>
          )}

          {visibleSystemPage !== "settings" && <CreatedNotice ui={ui} controller={controller} />}
          <WorkspaceChrome ui={ui} controller={controller} />
          {ui.overlay?.type !== "settings" && visibleSystemPage !== "settings" && <div className="dsh-wb-global-status"><StatusBanners ui={ui} /></div>}
        </div>
        <Overlays ui={ui} controller={controller} systemPage={visibleSystemPage} />
      </div>
    </MotionRoot>
  );
}
