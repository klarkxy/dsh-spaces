import React, { type ReactElement } from "react";
import { motion } from "motion/react";
import type { SpaceDetail } from "../../../../../src/shared/spaces-control";
import { FadeIn, fade } from "../../../../../src/shared/ui/motion";
import { localizeDiagnostic, localizeSafeText, t, type SpacesLocale } from "../i18n";
import type { SpacesPanelSnapshot } from "../state";
import { statusLabel } from "./labels";

/**
 * The detail pane of the Spaces panel.
 *
 * The pane slides up when the selection changes with its opacity pinned at 1
 * (it can carry error diagnostics), the loading state shows a shimmer
 * skeleton, and a failure is rendered in its visible end state: an entrance
 * primitive must never delay a real error.
 */

/** Props of the detail pane. */
export interface DetailPaneProps {
  locale: SpacesLocale;
  detail: SpacesPanelSnapshot["detail"];
}

export function DetailPane({ locale, detail }: DetailPaneProps): ReactElement {
  if (!detail) {
    return <p className="dsh-spaces-muted">{t(locale, "detail.placeholder")}</p>;
  }
  if (detail.status === "loading") {
    return <DetailSkeleton />;
  }
  if (detail.status === "error" || !detail.detail) {
    return (
      <FadeIn appear={false} className="dsh-spaces-alert" role="alert">
        {detail.error ? localizeSafeText(locale, detail.error) : t(locale, "detail.failed")}
      </FadeIn>
    );
  }
  return (
    <motion.div
      key={detail.detail.space.id}
      className="dsh-spaces-detail-body"
      initial={{ opacity: 1, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={fade}
    >
      <DetailContent locale={locale} detail={detail.detail} />
    </motion.div>
  );
}

/** Shimmer placeholder for a detail that is still loading. */
function DetailSkeleton(): ReactElement {
  return (
    <div className="dsh-spaces-skeleton" role="status" aria-live="polite">
      <span className="dsh-spaces-skeleton-line" style={{ width: "42%" }} />
      <span className="dsh-spaces-skeleton-line" style={{ width: "68%" }} />
      <span className="dsh-spaces-skeleton-line" style={{ width: "54%" }} />
      <span className="dsh-spaces-skeleton-line" style={{ width: "76%" }} />
    </div>
  );
}

/** The resolved detail of one space. */
function DetailContent({
  locale,
  detail,
}: {
  locale: SpacesLocale;
  detail: SpaceDetail;
}): ReactElement {
  const { space, plugins, snapshots, diagnostics } = detail;
  return (
    <>
      <div className="dsh-spaces-detail-head">
        <h3 className="dsh-spaces-detail-title">{space.displayName}</h3>
        {space.isHost && (
          <span className="dsh-spaces-badge" data-tone="host">
            {t(locale, "list.host")}
          </span>
        )}
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
    </>
  );
}
