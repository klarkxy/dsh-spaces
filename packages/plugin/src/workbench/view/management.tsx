/**
 * The management surface: overview, spaces, backups and runtime.
 *
 * The lists stagger in. Failure reasons never do: an alert or a notice is
 * rendered in its visible end state, and only decorative rows are delayed.
 *
 * The space detail page and the space template page are rendered here as
 * well: they are the destinations of the spaces and the templates tabs.
 */

import React, { type ReactElement } from "react";
import type { WorkbenchSnapshot } from "../../../../../src/shared/workbench";
import { StaggerItem, springSoft } from "../../../../../src/shared/ui";
import { SpaceTemplatesPage } from "../templates/page";
import { SpaceGlyph } from "../space-glyph";
import { EmptyState } from "../empty-state";
import { InlineErrors } from "../inline-error";
import { t, type WorkbenchLocale } from "../i18n";
import { requestOriginMounted, type WorkbenchController } from "../store";
import { copyRedacted, statusKey, type WorkbenchViewProps } from "./shared";
import { JobsList } from "./jobs";
import { SpaceDetailPage } from "./space-detail";

export function ManagementContent({ ui, controller }: WorkbenchViewProps): ReactElement {
  return (
    <>
      {ui.settingsTab === "overview" && <OverviewTab ui={ui} controller={controller} />}
      {ui.settingsTab === "spaces" && (ui.detailSpaceId
        ? <SpaceDetailPage ui={ui} controller={controller} spaceId={ui.detailSpaceId} />
        : <SpacesTab ui={ui} controller={controller} />)}
      {ui.settingsTab === "plugins" && (ui.detailSpaceId
        ? <SpaceDetailPage ui={ui} controller={controller} spaceId={ui.detailSpaceId} />
        : <SpacesTab ui={ui} controller={controller} />)}
      {ui.settingsTab === "snapshots" && <SnapshotsTab ui={ui} controller={controller} />}
      {ui.settingsTab === "runtime" && <RuntimeTab ui={ui} controller={controller} />}
      {ui.settingsTab === "templates" || ui.settingsTab === "blueprints" ? (
        <SpaceTemplatesPage ui={ui} controller={controller} />
      ) : null}
    </>
  );
}

/**
 * Global status lines.
 *
 * Alerts, notices and read errors are rendered without an entrance: a
 * failure has to be readable the moment it appears.
 *
 * A failure that belongs to a control is shown next to that control, not
 * here. Only the global state and a failure without a known origin stay in
 * this banner.
 */
export function StatusBanners({ ui }: { ui: WorkbenchViewProps["ui"] }): ReactElement | null {
  const locale = ui.locale;
  const state = ui.state;
  return (
    <>
      {state && !state.writable && (
        <p className="dsh-wb-notice" role="status">
          {t(locale, "app.readonly")}
        </p>
      )}
      {state?.maintenance && <p className="dsh-wb-notice">{t(locale, "app.maintenance")}</p>}
      {state?.availability === "unavailable" && (
        <p className="dsh-wb-alert" role="alert">
          {t(locale, "home.availability.unavailable")}
        </p>
      )}
      {ui.error && ui.boot !== "error" && (
        <p className="dsh-wb-alert" role="alert">
          {ui.error}
        </p>
      )}
      {ui.commandError && !requestOriginMounted(ui) && (
        <p className="dsh-wb-alert" role="alert">
          {ui.commandError}
        </p>
      )}
      {ui.planError && !requestOriginMounted(ui) && (
        <p className="dsh-wb-alert" role="alert">
          {ui.planError}
        </p>
      )}
    </>
  );
}

function OverviewTab({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const state = ui.state;
  if (!state) return <p className="dsh-wb-muted">{t(locale, "app.loading")}</p>;
  return (
    <>
      <dl className="dsh-wb-dl">
        <dt>{t(locale, "home.availability")}</dt>
        <dd>
          {t(
            locale,
            state.availability === "limited"
              ? "home.availability.limited"
              : state.availability === "unavailable"
                ? "home.availability.unavailable"
                : "home.availability.ready",
          )}
        </dd>
        <dt>{t(locale, "home.dshVersion")}</dt>
        <dd>{state.dshVersion ?? "—"}</dd>
        <dt>{state.writable ? t(locale, "home.writable") : t(locale, "home.readonlyFlag")}</dt>
        <dd>{roleLabel(locale, state.role)}</dd>
      </dl>
      <details className="dsh-wb-job-details" data-service-details="true">
        <summary>{t(locale, "jobs.details")}</summary>
        <dl className="dsh-wb-dl">
          <dt>{t(locale, "home.mode")}</dt>
          <dd><code>{state.mode}</code></dd>
          <dt>{t(locale, "home.protocol")}</dt>
          <dd><code>{state.protocolVersion}</code></dd>
          <dt>{t(locale, "home.owner")}</dt>
          <dd>
            {state.owner ? `${state.owner.kind} · ${state.owner.since}` : t(locale, "home.ownerNone")}
          </dd>
          <dt>{t(locale, "home.role")}</dt>
          <dd><code>{state.role}</code></dd>
        </dl>
      </details>
      <section>
        <h2 className="dsh-wb-title">{t(locale, "home.reasons")}</h2>
        {state.reasons.length === 0 ? (
          <p className="dsh-wb-muted">{t(locale, "home.noReasons")}</p>
        ) : (
          <ul>
            {state.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </section>
      <JobsList locale={locale} jobs={state.jobs} onCancel={controller.cancelJob} />
      <WorkbenchLogSection ui={ui} controller={controller} />
    </>
  );
}

/** The role of this client in plain language. An unknown role keeps its raw value. */
function roleLabel(locale: WorkbenchLocale, role: string): string {
  if (role === "manager") return t(locale, "home.role.manager");
  if (role === "workspace") return t(locale, "home.role.workspace");
  if (role === "uninitialized") return t(locale, "home.role.uninitialized");
  return role;
}

function WorkbenchLogSection({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const text = controller.copyWorkbenchLog();
  return (
    <section data-workbench-log="true">
      <h2 className="dsh-wb-title">{t(locale, "logs.title")}</h2>
      {ui.logsStatus === "loading" ? <p role="status">{t(locale, "app.loading")}</p> : null}
      {ui.logsStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.logs ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {ui.logsError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.logsError}
        </p>
      ) : null}
      {ui.logsStatus === "ready" && ui.logs.length === 0 ? <p className="dsh-wb-muted">{t(locale, "logs.empty")}</p> : null}
      {ui.logs.map((entry, index) => (
        <pre key={`${entry.at}-${index}`} className="dsh-wb-log">
          {entry.at} {t(locale, entry.level === "info" ? "logs.level.info" : entry.level === "warn" ? "logs.level.warn" : "logs.level.error")} {entry.area} {entry.event}
          {entry.code ? ` ${entry.code}` : ""}
          {"\n"}
          {entry.message}
        </pre>
      ))}
      <div className="dsh-wb-actions">
        <button
          type="button"
          className="dsh-wb-btn"
          disabled={!text}
          onClick={() => copyRedacted(text)}
        >
          {t(locale, "app.copyLogs")}
        </button>
      </div>
    </section>
  );
}

function SpacesTab({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const spaces = controller.workspaceSpaces();
  const writable = controller.canMutate();
  return (
    <>
      <div className="dsh-wb-actions">
        <button type="button" className="dsh-wb-btn primary" disabled={!writable} onClick={controller.openCreate}>
          {t(locale, "app.newSpace")}
        </button>
        <button type="button" className="dsh-wb-btn" disabled={!writable} onClick={controller.openBlueprintUse}>
          {t(locale, "blueprints.createFrom")}
        </button>
      </div>
      <InlineErrors ui={ui} origin="spaces" />
      {spaces.length === 0 ? (
        <EmptyState
          testId="spaces"
          title={t(locale, "home.spacesEmpty")}
          action={
            <button type="button" className="dsh-wb-btn primary" disabled={!writable} onClick={controller.openCreate}>
              {t(locale, "app.newSpace")}
            </button>
          }
        />
      ) : null}
      {spaces.map((space, index) => (
        <StaggerItem key={space.id} transition={{ ...springSoft, delay: index * 0.035 }}>
          <div className="dsh-wb-space-row" data-space-id={space.id}>
            <SpaceGlyph icon={space.icon} spaceId={space.id} />
            <span>
              {space.displayName}{" "}
              <small>
                {t(locale, statusKey(space.status))}
                {space.isHost ? ` · ${t(locale, "detail.host")}` : ""}
                {!space.managed ? ` · ${t(locale, "app.unmanaged")}` : ""}
              </small>
            </span>
            <button type="button" className="dsh-wb-btn" onClick={() => controller.selectSpace(space.id)}>
              {space.status === "running" ? space.displayName : t(locale, "app.start")}
            </button>
            <button type="button" className="dsh-wb-btn" disabled={!writable || index === 0} onClick={() => controller.moveSpace(space.id, -1)}>
              {t(locale, "app.moveUp")}
            </button>
            <button
              type="button"
              className="dsh-wb-btn"
              disabled={!writable || index === spaces.length - 1}
              onClick={() => controller.moveSpace(space.id, 1)}
            >
              {t(locale, "app.moveDown")}
            </button>
            <button type="button" className="dsh-wb-btn" onClick={() => controller.openDetail(space.id)}>
              {t(locale, "detail.manage")}
            </button>
          </div>
        </StaggerItem>
      ))}
    </>
  );
}

function SnapshotsTab({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const writable = controller.canMutate();
  return (
    <>
      <p className="dsh-wb-muted">{t(locale, "snapshots.createHint")}</p>
      <button
        type="button"
        className="dsh-wb-btn primary"
        disabled={!writable}
        onClick={() => controller.preview({ kind: "snapshot.create" })}
      >
        {t(locale, "snapshots.create")}
      </button>
      {ui.snapshotsStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.snapshots ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {ui.snapshots.length === 0 && ui.snapshotsStatus === "ready" ? (
        <EmptyState
          testId="backups"
          title={t(locale, "snapshots.empty")}
          action={
            <button
              type="button"
              className="dsh-wb-btn primary"
              disabled={!writable}
              onClick={() => controller.preview({ kind: "snapshot.create" })}
            >
              {t(locale, "snapshots.create")}
            </button>
          }
        />
      ) : null}
      {ui.snapshots.map((snapshot, index) => (
        <StaggerItem key={snapshot.id} transition={{ ...springSoft, delay: index * 0.035 }}>
          <SnapshotRow snapshot={snapshot} locale={locale} writable={writable} controller={controller} />
        </StaggerItem>
      ))}
    </>
  );
}

function SnapshotRow({
  snapshot,
  locale,
  writable,
  controller,
}: {
  snapshot: WorkbenchSnapshot;
  locale: WorkbenchLocale;
  writable: boolean;
  controller: WorkbenchController;
}): ReactElement {
  return (
    <div className="dsh-wb-space-row">
      <span>
        {snapshot.createdAt} · DSH {snapshot.runtimeVersion} · {(snapshot.bytes / 1048576).toFixed(1)} MB
        <br />
        <small>
          {t(locale, "snapshots.spaces")}: {snapshot.spaceIds.map((id) => controller.space(id)?.displayName ?? id).join(", ") || "—"}
          {snapshot.restorable ? "" : ` · ${t(locale, "snapshots.notRestorable")}`}
        </small>
      </span>
      <button
        type="button"
        className="dsh-wb-btn danger"
        disabled={!writable}
        onClick={() => controller.preview({ kind: "snapshot.delete", snapshotId: snapshot.id })}
      >
        {t(locale, "snapshots.delete")}
      </button>
    </div>
  );
}

function RuntimeTab({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const writable = controller.canMutate();
  const host = ui.runtimes.find((row) => row.host);
  return (
    <>
      {ui.runtimesStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.runtimes ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      <InlineErrors ui={ui} origin="dshVersions" />
      <p>
        {t(locale, "runtime.host")}: {host?.version ?? t(locale, "runtime.none")}
      </p>
      <p className="dsh-wb-muted">{t(locale, "runtime.hint")}</p>
      {ui.runtimes.length === 0 && ui.runtimesStatus === "ready" ? (
        <EmptyState testId="dshVersions" title={t(locale, "runtime.empty")} />
      ) : null}
      {ui.runtimes.map((runtime) => (
        <div key={runtime.version} className="dsh-wb-space-row">
          <span>
            {runtime.version}
            {runtime.installed ? ` · ${t(locale, "runtime.installed")}` : ""}
            {runtime.host ? ` · ${t(locale, "runtime.host")}` : ""}
            {runtime.compatible ? ` · ${t(locale, "runtime.compatible")}` : ` · ${t(locale, "runtime.incompatible")}`}
            {runtime.pinnedBy.length
              ? ` · ${t(locale, "runtime.pinnedBy", { names: runtime.pinnedBy.map((id) => controller.space(id)?.displayName ?? id).join(locale === "zh" ? "、" : ", ") })}`
              : ""}
          </span>
          {runtime.removable ? (
            <button
              type="button"
              className="dsh-wb-btn"
              disabled={!writable}
              onClick={() => controller.preview({ kind: "runtime.remove", version: runtime.version })}
            >
              {t(locale, "runtime.remove")}
            </button>
          ) : null}
        </div>
      ))}
    </>
  );
}
