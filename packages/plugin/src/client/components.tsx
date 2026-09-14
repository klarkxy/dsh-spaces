import React, { useState, type FormEvent, type ReactElement } from "react";
import type {
  SpaceDetail,
  SpaceSummary,
  SpacesCapabilities,
  SpacesMode,
} from "../../../../src/shared/spaces-control";
import {
  t,
  type SpacesLocale,
  type SpacesMessageKey,
  localizeDiagnostic,
  localizeSafeText,
} from "./i18n";
import type { SpacesPanelSnapshot } from "./state";
import { SPACES_PANEL_CSS } from "./styles";

/** Presentational views for the Spaces panel. Pure props in, markup out — DOM-free, SSR-safe. */

export interface SpacesPanelViewProps {
  snapshot: SpacesPanelSnapshot;
  locale?: SpacesLocale;
  onLocaleChange?: (locale: SpacesLocale) => void;
  onRefresh: () => void;
  onSelect: (id: string | null) => void;
  onCreate: (input: { name: string; displayName?: string }) => void;
  onVerify: () => void;
}

const MODE_KEY: Record<SpacesMode, SpacesMessageKey> = {
  "verified-full": "mode.verified-full",
  "verified-limited": "mode.verified-limited",
  "unknown-readonly": "mode.unknown-readonly",
  "recovery-only": "mode.recovery-only",
};

const STATUS_KEY: Record<SpaceSummary["status"], SpacesMessageKey> = {
  running: "status.running",
  stopped: "status.stopped",
  unknown: "status.unknown",
};

function modeLabel(locale: SpacesLocale, mode: SpacesMode): string {
  return t(locale, MODE_KEY[mode]);
}

function statusLabel(locale: SpacesLocale, status: SpaceSummary["status"]): string {
  return t(locale, STATUS_KEY[status]);
}

function isolationLabel(locale: SpacesLocale, isolation: SpaceSummary["isolation"]): string {
  if (isolation === "verified") return t(locale, "isolation.verified");
  if (isolation === "unverified") return t(locale, "isolation.unverified");
  if (isolation === "invalid") return t(locale, "isolation.invalid");
  return t(locale, "isolation.default");
}

function isolationTone(isolation: SpaceSummary["isolation"]): string {
  if (isolation === "verified") return "verified";
  if (isolation === "invalid") return "invalid";
  return "neutral";
}

export function SpacesPanelView(props: SpacesPanelViewProps): ReactElement {
  const { snapshot, onRefresh, locale = "en", onLocaleChange } = props;
  const { overview } = snapshot;
  const busy = overview.status === "loading" || overview.refreshing;
  return (
    <div className="dsh-spaces" lang={locale === "zh" ? "zh-CN" : "en"} data-locale={locale}>
      <style>{SPACES_PANEL_CSS}</style>
      <header className="dsh-spaces-header">
        <h2 className="dsh-spaces-title">{t(locale, "panel.title")}</h2>
        <LanguageSwitch locale={locale} onLocaleChange={onLocaleChange} />
        <button
          type="button"
          className="dsh-spaces-refresh"
          onClick={onRefresh}
          disabled={busy}
          aria-busy={overview.refreshing || undefined}
        >
          {overview.refreshing ? t(locale, "panel.refreshing") : t(locale, "panel.refresh")}
        </button>
      </header>
      {overview.status === "loading" && (
        <div className="dsh-spaces-center" role="status">
          {t(locale, "panel.loading")}
        </div>
      )}
      {overview.status === "error" && (
        <div className="dsh-spaces-center">
          <p className="dsh-spaces-alert" role="alert">
            {localizeSafeText(locale, overview.error)}
          </p>
        </div>
      )}
      {overview.status === "ready" && <ReadyBody {...props} locale={locale} />}
    </div>
  );
}

function LanguageSwitch({
  locale,
  onLocaleChange,
}: {
  locale: SpacesLocale;
  onLocaleChange?: (locale: SpacesLocale) => void;
}): ReactElement {
  return (
    <div className="dsh-spaces-lang" role="group" aria-label={t(locale, "panel.language")}>
      <button
        type="button"
        className="dsh-spaces-lang-btn"
        aria-pressed={locale === "zh"}
        onClick={() => onLocaleChange?.("zh")}
      >
        中文
      </button>
      <button
        type="button"
        className="dsh-spaces-lang-btn"
        aria-pressed={locale === "en"}
        onClick={() => onLocaleChange?.("en")}
      >
        English
      </button>
    </div>
  );
}

function ReadyBody({
  snapshot,
  locale = "en",
  onSelect,
  onCreate,
  onVerify,
}: SpacesPanelViewProps): ReactElement {
  const { overview, selectedId, detail } = snapshot;
  return (
    <div className="dsh-spaces-body">
      <div className="dsh-spaces-sidebar">
        {overview.capabilities && (
          <Capabilities locale={locale} capabilities={overview.capabilities} />
        )}
        {overview.error && (
          <p className="dsh-spaces-alert" role="alert">
            {localizeSafeText(locale, overview.error)}
          </p>
        )}
        <CreateForm
          locale={locale}
          capabilities={overview.capabilities}
          pending={snapshot.create.pending}
          error={snapshot.create.error}
          onCreate={onCreate}
        />
        {overview.spaces.length === 0 ? (
          <p className="dsh-spaces-muted">{t(locale, "list.empty")}</p>
        ) : (
          <ul className="dsh-spaces-list" aria-label={t(locale, "list.label")}>
            {overview.spaces.map((space) => (
              <li key={space.id}>
                <button
                  type="button"
                  className="dsh-spaces-item"
                  aria-current={space.id === selectedId ? "true" : undefined}
                  onClick={() => onSelect(space.id)}
                >
                  <span
                    className="dsh-spaces-status"
                    data-status={space.status}
                    aria-hidden="true"
                  />
                  <span className="dsh-spaces-item-name">{space.displayName}</span>
                  {space.isHost && (
                    <span className="dsh-spaces-badge" data-tone="host">
                      {t(locale, "list.host")}
                    </span>
                  )}
                  <span className="dsh-spaces-sr-only">{statusLabel(locale, space.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <section
        className="dsh-spaces-detail"
        aria-label={t(locale, "detail.label")}
        aria-busy={detail?.status === "loading" || undefined}
      >
        <DetailPane
          locale={locale}
          detail={detail}
          capabilities={overview.capabilities}
          onVerify={onVerify}
        />
      </section>
    </div>
  );
}

function Capabilities({
  locale,
  capabilities,
}: {
  locale: SpacesLocale;
  capabilities: SpacesCapabilities;
}): ReactElement {
  return (
    <div className="dsh-spaces-capabilities" aria-label={t(locale, "capabilities.label")}>
      <div className="dsh-spaces-mode">
        <strong>{modeLabel(locale, capabilities.mode)}</strong>
        {capabilities.dshVersion && (
          <span className="dsh-spaces-version">DSH {capabilities.dshVersion}</span>
        )}
      </div>
      {capabilities.reasons.length > 0 && (
        <ul className="dsh-spaces-reasons" aria-label={t(locale, "capabilities.reasons")}>
          {capabilities.reasons.map((reason) => (
            <li key={reason}>{localizeSafeText(locale, reason)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateForm({
  locale,
  capabilities,
  pending,
  error,
  onCreate,
}: {
  locale: SpacesLocale;
  capabilities: SpacesCapabilities | null;
  pending: boolean;
  error: string | null;
  onCreate: SpacesPanelViewProps["onCreate"];
}): ReactElement {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const allowed = capabilities?.canCreate === true;
  const canSubmit = allowed && !pending && name.trim().length > 0;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const trimmedDisplay = displayName.trim();
    onCreate({ name: name.trim(), ...(trimmedDisplay ? { displayName: trimmedDisplay } : {}) });
    setName("");
    setDisplayName("");
  };
  return (
    <form className="dsh-spaces-form" aria-label={t(locale, "create.form")} onSubmit={submit}>
      <h3 className="dsh-spaces-section-title">{t(locale, "create.title")}</h3>
      <label className="dsh-spaces-field">
        {t(locale, "create.name")}
        <input
          type="text"
          name="dsh-spaces-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={!allowed || pending}
          required
          autoComplete="off"
        />
      </label>
      <label className="dsh-spaces-field">
        {t(locale, "create.displayName")}
        <input
          type="text"
          name="dsh-spaces-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={!allowed || pending}
          autoComplete="off"
        />
      </label>
      {!allowed && <p className="dsh-spaces-muted">{t(locale, "create.denied")}</p>}
      {error && (
        <p className="dsh-spaces-alert" role="alert">
          {localizeSafeText(locale, error)}
        </p>
      )}
      <button type="submit" className="dsh-spaces-submit" disabled={!canSubmit} aria-busy={pending || undefined}>
        {pending ? t(locale, "create.pending") : t(locale, "create.submit")}
      </button>
    </form>
  );
}

function DetailPane({
  locale,
  detail,
  capabilities,
  onVerify,
}: {
  locale: SpacesLocale;
  detail: SpacesPanelSnapshot["detail"];
  capabilities: SpacesCapabilities | null;
  onVerify: () => void;
}): ReactElement {
  if (!detail) {
    return <p className="dsh-spaces-muted">{t(locale, "detail.placeholder")}</p>;
  }
  if (detail.status === "loading") {
    return (
      <div className="dsh-spaces-center" role="status">
        {t(locale, "detail.loading")}
      </div>
    );
  }
  if (detail.status === "error" || !detail.detail) {
    return (
      <p className="dsh-spaces-alert" role="alert">
        {detail.error ? localizeSafeText(locale, detail.error) : t(locale, "detail.failed")}
      </p>
    );
  }
  return (
    <DetailContent
      locale={locale}
      detail={detail.detail}
      state={detail}
      capabilities={capabilities}
      onVerify={onVerify}
    />
  );
}

function DetailContent({
  locale,
  detail,
  state,
  capabilities,
  onVerify,
}: {
  locale: SpacesLocale;
  detail: SpaceDetail;
  state: NonNullable<SpacesPanelSnapshot["detail"]>;
  capabilities: SpacesCapabilities | null;
  onVerify: () => void;
}): ReactElement {
  const { space, plugins, snapshots, diagnostics } = detail;
  const canVerify = !space.isHost && capabilities?.canVerify === true;
  const isolationAfterCheck = state.verifyResult
    ? state.verifyResult.valid
      ? "verified"
      : "invalid"
    : space.isolation;
  return (
    <>
      <div className="dsh-spaces-detail-head">
        <h3 className="dsh-spaces-detail-title">{space.displayName}</h3>
        {space.isHost && (
          <span className="dsh-spaces-badge" data-tone="host">
            {t(locale, "list.host")}
          </span>
        )}
        <span className="dsh-spaces-badge" data-tone={isolationTone(isolationAfterCheck)}>
          {state.verifyResult
            ? state.verifyResult.valid
              ? t(locale, "isolation.lastPassed")
              : t(locale, "isolation.lastFailed")
            : isolationLabel(locale, space.isolation)}
        </span>
      </div>
      <dl className="dsh-spaces-meta">
        <dt>{t(locale, "detail.id")}</dt>
        <dd>
          <code>{space.id}</code>
        </dd>
        <dt>{t(locale, "detail.status")}</dt>
        <dd>{statusLabel(locale, space.status)}</dd>
        <dt>{t(locale, "detail.webApp")}</dt>
        <dd>{space.hasWebApp ? t(locale, "detail.webAppInstalled") : t(locale, "detail.webAppNone")}</dd>
      </dl>
      <div>
        <h4 className="dsh-spaces-section-title">{t(locale, "detail.plugins")}</h4>
        {plugins.length === 0 ? (
          <p className="dsh-spaces-muted">{t(locale, "detail.pluginsEmpty")}</p>
        ) : (
          <table className="dsh-spaces-table">
            <thead>
              <tr>
                <th scope="col">{t(locale, "detail.pluginName")}</th>
                <th scope="col">{t(locale, "detail.pluginVersion")}</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((plugin) => (
                <tr key={plugin.name}>
                  <td>{plugin.name}</td>
                  <td>{plugin.version ?? t(locale, "detail.unknown")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <h4 className="dsh-spaces-section-title">{t(locale, "detail.snapshots")}</h4>
        {snapshots.length === 0 ? (
          <p className="dsh-spaces-muted">{t(locale, "detail.snapshotsEmpty")}</p>
        ) : (
          <table className="dsh-spaces-table">
            <thead>
              <tr>
                <th scope="col">{t(locale, "detail.snapshotId")}</th>
                <th scope="col">{t(locale, "detail.snapshotCreated")}</th>
                <th scope="col">{t(locale, "detail.snapshotRuntime")}</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snapshot) => (
                <tr key={snapshot.id}>
                  <td>
                    <code>{snapshot.id}</code>
                  </td>
                  <td>{snapshot.createdAt}</td>
                  <td>{snapshot.runtimeVersion ?? t(locale, "detail.unknown")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {diagnostics.length > 0 && (
        <div>
          <h4 className="dsh-spaces-section-title">{t(locale, "detail.diagnostics")}</h4>
          <ul className="dsh-spaces-diagnostics">
            {diagnostics.map((diagnostic, index) => (
              <li
                key={`${diagnostic.code}-${index}`}
                className="dsh-spaces-diagnostic"
                data-level={diagnostic.level}
                role={diagnostic.level === "error" ? "alert" : undefined}
              >
                <span className="dsh-spaces-diagnostic-code">{diagnostic.code}</span>
                {localizeDiagnostic(locale, diagnostic.code, diagnostic.message)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        {space.isHost ? (
          <p className="dsh-spaces-muted">{t(locale, "detail.hostLocked")}</p>
        ) : capabilities && !capabilities.canVerify ? (
          <p className="dsh-spaces-muted">{t(locale, "detail.verifyDenied")}</p>
        ) : (
          <button
            type="button"
            className="dsh-spaces-action"
            onClick={onVerify}
            disabled={!canVerify || state.verifying}
            aria-busy={state.verifying || undefined}
          >
            {state.verifying ? t(locale, "detail.verifying") : t(locale, "detail.verify")}
          </button>
        )}
        {state.verifyResult && (
          <p className="dsh-spaces-notice" data-tone={state.verifyResult.valid ? "ok" : undefined} role="status">
            {localizeSafeText(locale, state.verifyResult.message)}
          </p>
        )}
        {state.verifyError && (
          <p className="dsh-spaces-alert" role="alert">
            {localizeSafeText(locale, state.verifyError)}
          </p>
        )}
      </div>
    </>
  );
}
