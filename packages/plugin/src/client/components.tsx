import React, { type ReactElement } from "react";
import { FadeIn } from "../../../../src/shared/ui/motion";
import {
  t,
  type SpacesLocale,
  localizeSafeText,
} from "./i18n";
import type { SpacesPanelSnapshot } from "./state";
import { SPACES_PANEL_CSS } from "./styles";
import { DetailPane } from "./ui/spaces-detail";
import { SpaceList } from "./ui/spaces-list";
import { Capabilities, CreateForm } from "./ui/spaces-form";
import { PressButton } from "./ui/press-button";

/** Presentational views for the Spaces panel. Pure props in, markup out — DOM-free, SSR-safe. */

export interface SpacesPanelViewProps {
  snapshot: SpacesPanelSnapshot;
  locale?: SpacesLocale;
  onLocaleChange?: (locale: SpacesLocale) => void;
  onRefresh: () => void;
  onSelect: (id: string | null) => void;
  onCreate: (input: { name: string; displayName?: string }) => void;
}

/**
 * The Spaces panel.
 *
 * The list enters as a staggered list with a sliding selection pill, the
 * detail pane crossfades when the selection changes, and a failure is always
 * rendered in its visible end state.
 */
export function SpacesPanelView(props: SpacesPanelViewProps): ReactElement {
  const { snapshot, onRefresh, locale = "en", onLocaleChange } = props;
  const { overview } = snapshot;
  const busy = overview.status === "loading" || overview.refreshing;
  return (
    <div className="dsh-spaces dsh-ui" lang={locale === "zh" ? "zh-CN" : "en"} data-locale={locale}>
      <style>{SPACES_PANEL_CSS}</style>
      <header className="dsh-spaces-header">
        <h2 className="dsh-spaces-title">{t(locale, "panel.title")}</h2>
        <LanguageSwitch locale={locale} onLocaleChange={onLocaleChange} />
        <PressButton
          type="button"
          className="dsh-spaces-refresh"
          onClick={onRefresh}
          disabled={busy}
          aria-busy={overview.refreshing || undefined}
        >
          {overview.refreshing ? t(locale, "panel.refreshing") : t(locale, "panel.refresh")}
        </PressButton>
      </header>
      {overview.status === "loading" && (
        <div className="dsh-spaces-center" role="status">
          {t(locale, "panel.loading")}
        </div>
      )}
      {overview.status === "error" && (
        <div className="dsh-spaces-center">
          <FadeIn appear={false} as="p" className="dsh-spaces-alert" role="alert">
            {localizeSafeText(locale, overview.error)}
          </FadeIn>
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
}: SpacesPanelViewProps): ReactElement {
  const { overview, selectedId, detail } = snapshot;
  return (
    <div className="dsh-spaces-body">
      <div className="dsh-spaces-sidebar">
        {overview.capabilities && (
          <Capabilities locale={locale} capabilities={overview.capabilities} />
        )}
        {overview.error && (
          <FadeIn appear={false} as="p" className="dsh-spaces-alert" role="alert">
            {localizeSafeText(locale, overview.error)}
          </FadeIn>
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
          <SpaceList
            locale={locale}
            spaces={overview.spaces}
            selectedId={selectedId}
            transitionalId={detail?.status === "loading" ? detail.id : null}
            refreshing={overview.refreshing}
            onSelect={onSelect}
          />
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
        />
      </section>
    </div>
  );
}
