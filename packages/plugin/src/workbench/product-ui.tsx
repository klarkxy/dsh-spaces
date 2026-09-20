import React, { type ChangeEvent, type ReactElement } from "react";
import type { PluginCatalogEntry, ThemePreference } from "../../../../src/shared/types";
import type { SpaceImportResult, SpaceSharePreview } from "../../../../src/shared/space-share";
import type { WorkbenchProductOutcome } from "../../../../src/shared/workbench-product";
import { t, type WorkbenchLocale } from "./i18n";
import type { ImportPreviewState, WorkbenchController, WorkbenchUiState } from "./store";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result;
      if (!(buffer instanceof ArrayBuffer)) {
        reject(new Error("workbench/invalid-input"));
        return;
      }
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      resolve(btoa(binary));
    };
    reader.onerror = () => reject(reader.error ?? new Error("workbench/failed"));
    reader.readAsArrayBuffer(file);
  });
}

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
      {ui.settingsStatus === "loading" ? <p role="status">{t(locale, "app.loading")}</p> : null}
      {ui.settingsStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.commandError ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {draft ? (
        <form
          className="dsh-wb-form"
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
            <button type="submit" className="dsh-wb-btn primary" disabled={!writable || busy}>
              {t(locale, "settings.saveHome")}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

export function PluginsCatalogLibrary({
  ui,
  controller,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
}): ReactElement {
  const locale = ui.locale;
  const writable = controller.canMutate();
  const busy = controller.isBusy();
  const source = ui.catalog?.source;
  return (
    <>
      <section data-catalog="true">
        <h3 className="dsh-wb-title">{t(locale, "plugins.catalog")}</h3>
        {source ? (
          <p className="dsh-wb-muted">
            {t(locale, "plugins.catalogSource")}:{" "}
            {t(
              locale,
              source === "remote"
                ? "plugins.catalogSource.remote"
                : source === "seed"
                  ? "plugins.catalogSource.seed"
                  : "plugins.catalogSource.cache",
            )}
          </p>
        ) : null}
        {ui.catalogStatus === "error" ? (
          <p className="dsh-wb-alert" role="alert">
            {ui.commandError ?? t(locale, "app.genericError")}
          </p>
        ) : null}
        <div className="dsh-wb-actions">
          <button
            type="button"
            className="dsh-wb-btn"
            disabled={busy}
            onClick={() => void controller.loadCatalog(ui.pluginQuery)}
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
        {(ui.catalog?.entries ?? []).map((entry) => (
          <CatalogRow
            key={entry.id}
            entry={entry}
            locale={locale}
            onPick={() => controller.setPluginCatalog(entry.id, ui.pluginVersion)}
          />
        ))}
      </section>
      <section data-library="true">
        <h3 className="dsh-wb-title">{t(locale, "plugins.library")}</h3>
        <p className="dsh-wb-muted">{t(locale, "plugins.notInstalled")}</p>
        {ui.libraryStatus === "error" ? (
          <p className="dsh-wb-alert" role="alert">
            {ui.commandError ?? t(locale, "app.genericError")}
          </p>
        ) : null}
        <label className="dsh-wb-field">
          {t(locale, "plugins.spec")}
          <input
            value={ui.pluginSpec}
            onChange={(event) => controller.setPluginSpec(event.target.value)}
            aria-label={t(locale, "plugins.spec")}
          />
        </label>
        <div className="dsh-wb-actions">
          <button
            type="button"
            className="dsh-wb-btn primary"
            disabled={!writable || busy}
            onClick={controller.downloadPlugin}
          >
            {t(locale, "plugins.download")}
          </button>
        </div>
        {ui.library.map((item) => (
          <div key={item.id} className="dsh-wb-space-row">
            <span>
              <strong>{item.title}</strong> · <code>{item.packageName}</code>
              {` @ ${item.version ?? t(locale, "plugins.unknownVersion")}`}
              <br />
              <small>
                {t(locale, "plugins.downloaded")} · {item.source} · {item.downloadedAt}
                {item.installedIn.length > 0
                  ? ` · ${t(locale, "plugins.installedIn")}: ${item.installedIn.join(", ")}`
                  : ""}
              </small>
            </span>
            <button
              type="button"
              className="dsh-wb-btn"
              onClick={() => controller.setPluginCatalog(item.packageName, item.version ?? "")}
            >
              {item.id}
            </button>
            <button
              type="button"
              className="dsh-wb-btn danger"
              disabled={!writable || busy || item.installedIn.length > 0}
              onClick={() => controller.removeLibraryItem(item.id)}
            >
              {t(locale, "plugins.removeLibrary")}
            </button>
          </div>
        ))}
      </section>
    </>
  );
}

function CatalogRow({
  entry,
  locale,
  onPick,
}: {
  entry: PluginCatalogEntry;
  locale: WorkbenchLocale;
  onPick: () => void;
}): ReactElement {
  return (
    <div className="dsh-wb-space-row">
      <span>
        <strong>{entry.id}</strong>
        {entry.packageName ? ` · ${entry.packageName}` : ""}
        <br />
        <small>{entry.description || entry.summary || entry.tier}</small>
      </span>
      <button type="button" className="dsh-wb-btn" onClick={onPick}>
        {t(locale, "plugins.catalogId")}
      </button>
    </div>
  );
}

export function TemplatesShareTab({
  ui,
  controller,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
}): ReactElement {
  const locale = ui.locale;
  const writable = controller.canMutate();
  const busy = controller.isBusy();
  const spaces = controller.workspaceSpaces();
  return (
    <div data-templates="true">
      <h2 className="dsh-wb-title">{t(locale, "templates.title")}</h2>
      {ui.templatesStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.commandError ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {ui.templates.length === 0 && ui.templatesStatus === "ready" ? (
        <p className="dsh-wb-muted">{t(locale, "templates.empty")}</p>
      ) : null}
      <label className="dsh-wb-field">
        {t(locale, "templates.saveFrom")}
        <select
          value={ui.templateSpaceId}
          onChange={(event) => controller.setTemplateSpaceId(event.target.value)}
          aria-label={t(locale, "templates.saveFrom")}
        >
          {spaces.map((space) => (
            <option key={space.id} value={space.id}>
              {space.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="dsh-wb-field">
        {t(locale, "templates.name")}
        <input
          value={ui.templateName}
          onChange={(event) => controller.setTemplateName(event.target.value)}
          autoComplete="off"
        />
      </label>
      <label className="dsh-wb-field">
        {t(locale, "create.displayName")}
        <input
          value={ui.templateDisplayName}
          onChange={(event) => controller.setTemplateDisplayName(event.target.value)}
          autoComplete="off"
        />
      </label>
      <label className="dsh-wb-field">
        <input
          type="checkbox"
          checked={ui.templateIncludeConfig}
          onChange={(event) => controller.setTemplateIncludeConfig(event.target.checked)}
        />
        {t(locale, "templates.includeConfig")}
      </label>
      <div className="dsh-wb-actions">
        <button
          type="button"
          className="dsh-wb-btn"
          disabled={!writable || busy}
          onClick={controller.saveTemplate}
        >
          {t(locale, "templates.save")}
        </button>
      </div>
      <label className="dsh-wb-field">
        {t(locale, "templates.create")}
        <select
          value={ui.templateId}
          onChange={(event) => controller.setTemplateId(event.target.value)}
          aria-label={t(locale, "templates.create")}
          disabled={ui.templates.length === 0}
        >
          {ui.templates.length === 0 ? (
            <option value="">{t(locale, "templates.empty")}</option>
          ) : (
            ui.templates.map((row) => (
              <option key={row.id} value={row.id}>
                {row.displayName || row.name}
              </option>
            ))
          )}
        </select>
      </label>
      <div className="dsh-wb-actions">
        <button
          type="button"
          className="dsh-wb-btn primary"
          disabled={!writable || busy || !ui.templateId}
          onClick={controller.createFromTemplate}
        >
          {t(locale, "templates.create")}
        </button>
      </div>
      <label className="dsh-wb-field">
        {t(locale, "share.export")}
        <select
          value={ui.shareSpaceId}
          onChange={(event) => controller.setShareSpaceId(event.target.value)}
          aria-label={t(locale, "share.export")}
        >
          {spaces.map((space) => (
            <option key={space.id} value={space.id}>
              {space.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="dsh-wb-field">
        <input
          type="checkbox"
          checked={ui.shareIncludeConfig}
          onChange={(event) => controller.setShareIncludeConfig(event.target.checked)}
        />
        {t(locale, "share.includeConfig")}
      </label>
      <div className="dsh-wb-actions">
        <button
          type="button"
          className="dsh-wb-btn"
          disabled={!writable || busy || !ui.shareSpaceId}
          onClick={controller.exportShare}
        >
          {t(locale, "share.export")}
        </button>
      </div>
      <label className="dsh-wb-field">
        {t(locale, "share.file")}
        <input
          type="file"
          accept=".dshspace,application/zip"
          onChange={(event) => {
            void onImportFile(event, controller);
          }}
        />
      </label>
      <ProductOutcomeCard locale={locale} outcome={ui.lastProductOutcome} />
    </div>
  );
}

async function onImportFile(
  event: ChangeEvent<HTMLInputElement>,
  controller: WorkbenchController,
): Promise<void> {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const base64 = await fileToBase64(file);
    controller.previewImportArchive(base64, file.name);
  } catch (error) {
    controller.reportFailure(error);
  }
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
  return (
    <div className="dsh-wb-overlay">
      <div className="dsh-wb-dialog wide" role="dialog" data-import-preview="true">
        <h2 className="dsh-wb-title">{t(locale, "share.preview")}</h2>
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
          <button type="button" className="dsh-wb-btn" onClick={onCancel}>
            {t(locale, "app.cancel")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn primary"
            disabled={busy}
            onClick={onConfirm}
            data-import-confirm="true"
          >
            {t(locale, "share.confirmImport")}
          </button>
        </div>
      </div>
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
      {preview.llmMappingRequired ? (
        <p className="dsh-wb-notice">
          {t(locale, "share.llmMapping")}. {t(locale, "share.llmMappingHint")}
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
    <dl className="dsh-wb-dl" data-import-result="true">
      <dt>{t(locale, "templates.result.definition")}</dt>
      <dd>{result.definition}</dd>
      <dt>{t(locale, "templates.result.plugins")}</dt>
      <dd>{result.plugins}</dd>
      <dt>{t(locale, "templates.result.start")}</dt>
      <dd>{result.start}</dd>
      <dt>{t(locale, "templates.result.llm")}</dt>
      <dd>
        {result.llm?.mappingRequired ? t(locale, "share.llmMapping") : result.llm ? String(result.llm.mapped) : "—"}
      </dd>
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
    </dl>
  );
}

export function DiagnosticsSection({
  ui,
  locale,
  onCopy,
}: {
  ui: WorkbenchUiState;
  locale: WorkbenchLocale;
  onCopy: () => void;
}): ReactElement {
  const diag = ui.diagnostics;
  return (
    <section data-diagnostics="true">
      <h3>{t(locale, "detail.diagnostics")}</h3>
      <p className="dsh-wb-muted">{t(locale, "detail.noRecovery")}</p>
      {ui.diagnosticsStatus === "loading" ? <p role="status">{t(locale, "app.loading")}</p> : null}
      {ui.diagnosticsStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.commandError ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {diag?.lastError ? (
        <p className="dsh-wb-alert" role="alert">
          {t(locale, "detail.lastError")}: {diag.lastError}
        </p>
      ) : null}
      <h4>{t(locale, "detail.logs")}</h4>
      {!diag || diag.logs.length === 0 ? <p className="dsh-wb-muted">{t(locale, "detail.logsEmpty")}</p> : null}
      {diag?.logs.map((entry, index) => (
        <pre key={`${entry.at}-${index}`} className="dsh-wb-log">
          {entry.at} {entry.channel} {entry.text}
        </pre>
      ))}
      {diag?.logError ? <p className="dsh-wb-alert">{diag.logError}</p> : null}
      <div className="dsh-wb-actions">
        <button type="button" className="dsh-wb-btn" onClick={onCopy}>
          {t(locale, "app.copyLogs")}
        </button>
      </div>
    </section>
  );
}
