/**
 * The product surfaces of the workbench: the settings of the Home, the plugin
 * catalogue, the templates and the share and import flow.
 *
 * The product flow is a sequence of steps. Every step slides into place, the
 * preview of an import scales in and the outcome of a finished step moves into
 * place as well. Failures are never part of an entrance animation: an alert
 * that reports a read, a write or an import that did not work stays readable
 * from the first frame.
 */
import React, { useRef, type ReactElement } from "react";
import type { ThemePreference } from "../../../../src/shared/types";
import type { SpaceImportResult, SpaceSharePreview } from "../../../../src/shared/space-share";
import type { WorkbenchProductOutcome } from "../../../../src/shared/workbench-product";
import { formatDateTime, t, type WorkbenchLocale } from "./i18n";
import { BlueprintApplyResult } from "./blueprint/apply";
import { InlineErrors } from "./inline-error";
import { isBlueprintApplyOutcome } from "./blueprint-session";
import type { ImportPreviewState, WorkbenchController, WorkbenchUiState } from "./store";
import { CopyButton } from "./view/shared";
import { useModalDialog } from "./view/use-modal-dialog";
import { LayoutIndicator, springSoft, StaggerItem, StaggerList } from "../../../../src/shared/ui/motion";
import { PressableButton, VisibleScale, VisibleSlide } from "./feature-motion";

export function ThemeSwitch({
  locale,
  theme,
  onChange,
}: {
  locale: WorkbenchLocale;
  theme: ThemePreference;
  onChange: (theme: ThemePreference) => void;
}): ReactElement {
  const options: ThemePreference[] = ["system", "light", "dark"];
  return (
    <div className="dsh-wb-lang" role="group" aria-label={t(locale, "settings.theme")}>
      {options.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={theme === value}
          onClick={() => onChange(value)}
        >
          {t(
            locale,
            value === "light" ? "settings.theme.light" : value === "dark" ? "settings.theme.dark" : "settings.theme.system",
          )}
          <LayoutIndicator
            as="span"
            layoutId="dsh-wb-theme"
            active={theme === value}
            className="dsh-wb-lang-indicator"
          />
        </button>
      ))}
    </div>
  );
}

export function HomeSettingsFields({
  ui,
  controller,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
}): ReactElement {
  const locale = ui.locale;
  const writable = controller.canMutate();
  const busy = controller.isBusy();
  const draft = ui.settingsDraft;
  return (
    <section data-settings-home="true">
      <h3 className="dsh-wb-title">{t(locale, "settings.homeSettings")}</h3>
      {ui.settingsStatus === "loading" ? (
        <p role="status" className="dsh-wb-status-line">
          <span className="dsh-wb-spin" aria-hidden="true" />
          {t(locale, "app.loading")}
        </p>
      ) : null}
      {ui.settingsStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.settings ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      <InlineErrors ui={ui} origin="service:settings" />
      {draft ? (
        <VisibleSlide
          as="form"
          className="dsh-wb-form"
          from={10}
          onSubmit={(event) => {
            event.preventDefault();
            controller.saveHomeSettings();
          }}
        >
          <label className="dsh-wb-field">
            {t(locale, "settings.portStart")}
            <input
              type="number"
              min={1024}
              max={65535}
              value={draft.settings.portStart}
              disabled={!writable}
              onChange={(event) =>
                controller.setHomeSettings({ portStart: Number(event.target.value) })
              }
            />
          </label>
          <label className="dsh-wb-field">
            {t(locale, "settings.portEnd")}
            <input
              type="number"
              min={1024}
              max={65535}
              value={draft.settings.portEnd}
              disabled={!writable}
              onChange={(event) =>
                controller.setHomeSettings({ portEnd: Number(event.target.value) })
              }
            />
          </label>
          <label className="dsh-wb-field">
            {t(locale, "settings.packageSource")}
            <select
              value={draft.settings.packageSource}
              disabled={!writable}
              onChange={(event) =>
                controller.setHomeSettings({
                  packageSource: event.target.value === "china" ? "china" : "official",
                })
              }
            >
              <option value="official">{t(locale, "settings.packageSource.official")}</option>
              <option value="china">{t(locale, "settings.packageSource.china")}</option>
            </select>
          </label>
          <label className="dsh-wb-field">
            {t(locale, "settings.catalogUrl")}
            <input
              value={draft.settings.catalogUrl}
              disabled={!writable}
              onChange={(event) => controller.setHomeSettings({ catalogUrl: event.target.value })}
            />
          </label>
          <p className="dsh-wb-muted">{t(locale, "settings.catalogUrlHint")}</p>
          <div className="dsh-wb-actions">
            <PressableButton type="submit" className="dsh-wb-btn primary" disabled={!writable || busy}>
              {t(locale, "settings.saveHome")}
            </PressableButton>
          </div>
        </VisibleSlide>
      ) : null}
    </section>
  );
}

export function ImportPreviewDialog({
  locale,
  preview,
  importName,
  importDisplayName,
  busy,
  onName,
  onDisplayName,
  onCancel,
  onConfirm,
}: {
  locale: WorkbenchLocale;
  preview: ImportPreviewState;
  importName: string;
  importDisplayName: string;
  busy: boolean;
  onName: (value: string) => void;
  onDisplayName: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const panel = useRef<HTMLElement>(null);
  const modal = useModalDialog(panel, { onCancel });
  return (
    <div className="dsh-wb-overlay">
      <VisibleScale
        as="div"
        ref={panel}
        className="dsh-wb-dialog wide dsh-wb-glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-wb-import-title"
        onKeyDown={modal.onKeyDown}
        data-import-preview="true"
      >
        <h2 id="dsh-wb-import-title" className="dsh-wb-title">{t(locale, "share.preview")}</h2>
        <SharePreviewBody locale={locale} preview={preview.preview} fileName={preview.fileName} />
        <label className="dsh-wb-field">
          {t(locale, "create.name")}
          <input value={importName} onChange={(event) => onName(event.target.value)} autoComplete="off" />
        </label>
        <label className="dsh-wb-field">
          {t(locale, "create.displayName")}
          <input
            value={importDisplayName}
            onChange={(event) => onDisplayName(event.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="dsh-wb-actions">
          <PressableButton type="button" className="dsh-wb-btn" onClick={onCancel}>
            {t(locale, "app.cancel")}
          </PressableButton>
          <PressableButton
            
            type="button"
            className="dsh-wb-btn primary"
            disabled={busy}
            onClick={onConfirm}
            data-import-confirm="true"
          >
            {t(locale, "share.confirmImport")}
          </PressableButton>
        </div>
      </VisibleScale>
    </div>
  );
}

function SharePreviewBody({
  locale,
  preview,
  fileName,
}: {
  locale: WorkbenchLocale;
  preview: SpaceSharePreview;
  fileName?: string;
}): ReactElement {
  return (
    <>
      {fileName ? <p>{fileName}</p> : null}
      <p>
        {preview.manifest.space.displayName}
        {preview.hasConfig ? ` · ${t(locale, "share.hasConfig")}` : ""}
      </p>
      <ul>
        {preview.plugins.map((plugin) => (
          <li key={`${plugin.packageName}:${plugin.resolvedVersion ?? "unknown"}`}>
            {plugin.packageName} @ {plugin.resolvedVersion ?? t(locale, "plugins.unknownVersion")} · {plugin.source}
          </li>
        ))}
      </ul>
      {preview.unknownSources.length > 0 ? (
        <p className="dsh-wb-alert" role="alert">
          {t(locale, "share.unknownSources")}: {preview.unknownSources.join(", ")}
        </p>
      ) : null}
    </>
  );
}

export function ProductOutcomeCard({
  locale,
  outcome,
}: {
  locale: WorkbenchLocale;
  outcome: WorkbenchProductOutcome | null;
}): ReactElement | null {
  if (!outcome) return null;
  if (isBlueprintApplyOutcome(outcome)) {
    return <BlueprintApplyResult locale={locale} outcome={outcome} />;
  }
  if (outcome.kind !== "template.create" && outcome.kind !== "space.import") {
    return (
      <p className="dsh-wb-notice" data-product-outcome={outcome.kind}>
        {outcome.kind}
      </p>
    );
  }
  return <ImportResultCard locale={locale} result={outcome.import} />;
}

export function ImportResultCard({
  locale,
  result,
}: {
  locale: WorkbenchLocale;
  result: SpaceImportResult;
}): ReactElement {
  return (
    <VisibleSlide as="dl" className="dsh-wb-dl" data-import-result="true" from={12}>
      <dt>{t(locale, "templates.result.definition")}</dt>
      <dd>{result.definition}</dd>
      <dt>{t(locale, "templates.result.plugins")}</dt>
      <dd>{result.plugins}</dd>
      <dt>{t(locale, "templates.result.start")}</dt>
      <dd>{result.start}</dd>
      {result.errors.length > 0 ? (
        <>
          <dt>{t(locale, "jobs.failed")}</dt>
          <dd>
            {result.errors.map((error) => (
              <div key={error}>{error}</div>
            ))}
          </dd>
        </>
      ) : null}
    </VisibleSlide>
  );
}

export function DiagnosticsSection({
  ui,
  locale,
  text,
}: {
  ui: WorkbenchUiState;
  locale: WorkbenchLocale;
  /** The redacted diagnostics text, read at click time. */
  text: () => string;
}): ReactElement {
  const diag = ui.diagnostics;
  return (
    <section data-diagnostics="true">
      <h3>{t(locale, "detail.diagnostics")}</h3>
      <p className="dsh-wb-muted">{t(locale, "detail.noRecovery")}</p>
      {ui.diagnosticsStatus === "loading" ? (
        <p role="status" className="dsh-wb-status-line">
          <span className="dsh-wb-spin" aria-hidden="true" />
          {t(locale, "app.loading")}
        </p>
      ) : null}
      {ui.diagnosticsStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.diagnostics ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {diag?.lastError ? (
        <p className="dsh-wb-alert" role="alert">
          {t(locale, "detail.lastError")}: {diag.lastError}
        </p>
      ) : null}
      <h4>{t(locale, "detail.logs")}</h4>
      {!diag || diag.logs.length === 0 ? <p className="dsh-wb-muted">{t(locale, "detail.logsEmpty")}</p> : null}
      <StaggerList as="div" className="dsh-wb-product-list" step={0}>
        {(diag?.logs ?? []).map((entry, index) => (
          <StaggerItem
            key={`${entry.at}-${index}`}
            as="div"
            transition={{ ...springSoft, delay: Math.min(index, 10) * 0.03 }}
          >
            <pre className="dsh-wb-log">
              {formatDateTime(locale, entry.at)} {entry.channel} {entry.text}
            </pre>
          </StaggerItem>
        ))}
      </StaggerList>
      {diag?.logError ? <p className="dsh-wb-alert">{diag.logError}</p> : null}
      <div className="dsh-wb-actions">
        <CopyButton locale={locale} className="dsh-wb-btn" text={text} label={t(locale, "app.copyLogs")} />
      </div>
    </section>
  );
}
