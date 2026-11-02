/**
 * The space detail page.
 *
 * It replaces the old detail dialog: every action that belongs to one space
 * has exactly one authoritative place. The page is rendered inside the spaces
 * tab of the settings surface and lists the space as cards: overview,
 * appearance, plugins, models, DSH version, diagnostics, export and the
 * destructive actions.
 *
 * Failures are never part of an entrance animation: a read error or a failed
 * write is readable from the first frame.
 */

import React, { useEffect, useState, type ReactElement } from "react";
import type { LlmDescribeResult } from "../../../../../src/shared/llm-api";
import type { WorkbenchSpace } from "../../../../../src/shared/workbench";
import { SPACES_BLUEPRINT_SEALED } from "../../../../../src/shared/blueprint-sealed";
import { t, type WorkbenchLocale } from "../i18n";
import type { WorkbenchController, WorkbenchUiState } from "../store";
import { statusKey } from "./shared";
import { DshVersionSection } from "./dsh-version";
import { IconPicker } from "./icon-picker";
import { InlineErrors } from "../inline-error";
import { PluginsSection } from "./plugin-section";
import { SpaceBindingPanel } from "../llm/space-binding";
import { LegacyConnectionSettings } from "../llm/legacy-settings";
import { DiagnosticsSection } from "../product-ui";

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
  return (
    <div className="dsh-wb-space-detail" data-space-detail="true" data-space-id={space.id}>
      <header className="dsh-wb-space-detail-header">
        <button type="button" className="dsh-wb-btn" data-space-detail-back="true" onClick={controller.closeDetail}>
          {t(locale, "detail.back")}
        </button>
        <h3 className="dsh-wb-title">{space.displayName}</h3>
        <span className="dsh-wb-muted">
          {t(locale, statusKey(space.status))}
          {space.isHost ? ` · ${t(locale, "detail.host")}` : ""}
          {!space.managed ? ` · ${t(locale, "app.unmanaged")}` : ""}
        </span>
      </header>
      {ui.readError.detail ? <p className="dsh-wb-alert" role="alert">{ui.readError.detail}</p> : null}
      <InlineErrors ui={ui} origin={`detail:${space.id}`} />
      <OverviewSection locale={locale} space={space} controller={controller} writable={writable} busy={busy} />
      <AppearanceSection locale={locale} space={space} controller={controller} writable={writable} manageable={manageable} />
      <PluginsSection locale={locale} space={space} controller={controller} writable={writable} busy={busy} ui={ui} />
      {space.base !== 'browser' ? <ModelsSection locale={locale} space={space} controller={controller} writable={writable} /> : null}
      <section className="dsh-wb-space-detail-card" data-space-section="dsh">
        {space.base === 'browser' ? <><h3 className="dsh-wb-title">Browser {space.baseVersion}</h3><p className="dsh-wb-muted">{t(locale, 'create.browserBaseHint')}</p></> : space.managed && !controller.isManagerId(space.id) ? (
          <DshVersionSection key={`${space.id}:${space.dshVersion ?? ""}`} ui={ui} controller={controller} space={space} />
        ) : (
          <p className="dsh-wb-muted">{t(locale, "detail.dshNotPinned")}</p>
        )}
      </section>
      <section className="dsh-wb-space-detail-card" data-space-section="diagnostics">
        <DiagnosticsSection ui={ui} locale={locale} text={() => controller.copyDiagnostics()} />
      </section>
      <ExportSection locale={locale} space={space} controller={controller} />
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
  );
}

function OverviewSection({
  locale,
  space,
  controller,
  writable,
  busy,
}: {
  locale: WorkbenchLocale;
  space: WorkbenchSpace;
  controller: WorkbenchController;
  writable: boolean;
  busy: boolean;
}): ReactElement {
  const startable = space.status === "stopped" || space.status === "crashed";
  const active = space.status === "running" || space.status === "starting";
  // The manager space and unmanaged spaces are shown, never operated.
  const manageable = space.managed && !controller.isManagerId(space.id);
  return (
    <section className="dsh-wb-space-detail-card" data-space-section="overview">
      <h3 className="dsh-wb-title">{t(locale, "detail.overview")}</h3>
      <dl className="dsh-wb-dl">
        <dt>{t(locale, "detail.id")}</dt>
        <dd><code>{space.id}</code></dd>
        <dt>{t(locale, "detail.status")}</dt>
        <dd>{t(locale, statusKey(space.status))}</dd>
      </dl>
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
  const [icon, setIcon] = useState(space.icon ?? "");
  useEffect(() => { setName(space.displayName); setIcon(space.icon ?? ""); }, [space.displayName, space.icon]);
  const dirty = name.trim() !== space.displayName || icon !== (space.icon ?? "");
  return (
    <section className="dsh-wb-space-detail-card" data-space-section="appearance">
      <h3 className="dsh-wb-title">{t(locale, "detail.appearance")}</h3>
      <p className="dsh-wb-muted">{t(locale, "detail.appearanceHint")}</p>
      <label className="dsh-wb-field">
        {t(locale, "detail.displayName")}
        <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" data-space-display-name="true" disabled={!manageable} />
      </label>
      {manageable ? <IconPicker locale={locale} value={icon} spaceId={space.id} onChange={setIcon} /> : null}
      {manageable ? (
        <div className="dsh-wb-actions">
          <button
            type="button"
            className="dsh-wb-btn primary"
            disabled={!writable || !dirty}
            onClick={() => controller.updateSpace(space.id, { displayName: name.trim() || space.displayName, icon })}
          >
            {t(locale, "app.save")}
          </button>
          {dirty ? <span className="dsh-wb-muted">{t(locale, "detail.unsaved")}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function ModelsSection(props: {
  locale: WorkbenchLocale;
  space: WorkbenchSpace;
  controller: WorkbenchController;
  writable: boolean;
}): ReactElement {
  return (
    <section className="dsh-wb-space-detail-card" data-space-section="models">
      <h3 className="dsh-wb-title">{t(props.locale, "detail.models")}</h3>
      <p className="dsh-wb-muted">{t(props.locale, "llm.modelSettingsHint")}</p>
      <LegacyConnectionSettings key={props.space.id} locale={props.locale}>
        <LegacySpaceModels {...props} />
      </LegacyConnectionSettings>
    </section>
  );
}

function LegacySpaceModels({
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
  const [describe, setDescribe] = useState<LlmDescribeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = controller.llmClient();
  useEffect(() => {
    let active = true;
    setError(null);
    void client.describe().then(
      (result) => { if (active) setDescribe(result); },
      (caught) => {
        if (!active) return;
        setDescribe(null);
        setError(caught instanceof Error ? caught.message : String(caught ?? ""));
      },
    );
    return () => { active = false; };
  }, [client]);
  const llmSpaces = controller.llmSpaces().filter((row) => row.spaceId === space.id);
  return (
    <>
      {error ? <p className="dsh-wb-alert" role="alert">{error}</p> : null}
      {describe ? (
        <SpaceBindingPanel
          locale={locale}
          writable={writable}
          client={client}
          spaces={llmSpaces}
          selectedSpaceId={space.id}
          describe={describe}
          onChanged={() => void client.describe().then((result) => setDescribe(result), () => undefined)}
        />
      ) : null}
      <div className="dsh-wb-actions">
        <button type="button" className="dsh-wb-btn" onClick={() => controller.setSettingsTab("llm")}>
          {t(locale, "detail.modelOpen")}
        </button>
      </div>
    </>
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
