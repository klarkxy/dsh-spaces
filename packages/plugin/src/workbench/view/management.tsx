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
import type { WorkbenchSnapshot, WorkbenchSpace } from "../../../../../src/shared/workbench";
import { StaggerItem, springSoft } from "../../../../../src/shared/ui/motion";
import { SPACES_BLUEPRINT_SEALED } from "../../../../../src/shared/blueprint-sealed";
import { SpaceTemplatesPage } from "../templates/page";
import { SpaceGlyph } from "../space-glyph";
import { EmptyState } from "../empty-state";
import { InlineErrors } from "../inline-error";
import { formatDateTime, formatMegabytes, t, type WorkbenchLocale } from "../i18n";
import { requestOriginMounted, type WorkbenchController } from "../store";
import { CopyButton, statusKey, type WorkbenchViewProps } from "./shared";
import { JobsList, jobKindLabel, jobMessageLabel, jobPhaseLabel, jobStatusLabel } from "./jobs";
import { ACTIVE_JOB } from "../store/constants";
import { SpaceDetailPage } from "./space-detail";

export function ManagementContent({ ui, controller, requestServiceStop }: WorkbenchViewProps): ReactElement {
  return (
    <>
      {(ui.settingsTab === "overview" ||
        ui.settingsTab === "snapshots" ||
        ui.settingsTab === "runtime" ||
        ui.settingsTab === "advanced") && (
        <OverviewTab ui={ui} controller={controller} requestServiceStop={requestServiceStop} />
      )}
      {ui.settingsTab === "spaces" && (ui.detailSpaceId
        ? <SpaceDetailPage ui={ui} controller={controller} spaceId={ui.detailSpaceId} />
        : <SpacesTab ui={ui} controller={controller} />)}
      {ui.settingsTab === "plugins" && (ui.detailSpaceId
        ? <SpaceDetailPage ui={ui} controller={controller} spaceId={ui.detailSpaceId} />
        : <SpacesTab ui={ui} controller={controller} />)}
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
      {state?.jobs.filter((job) => ACTIVE_JOB.has(job.status)).map((job) => (
        <p className="dsh-wb-notice" role="status" data-active-job={job.id} data-job-status={job.status} key={job.id}>
          {jobKindLabel(locale, job.kind)} · {job.status === "queued" ? jobStatusLabel(locale, "queued") : jobPhaseLabel(locale, job.phase)}{job.message ? ` — ${jobMessageLabel(locale, job.message)}` : ""}
        </p>
      ))}
    </>
  );
}

type MaintenanceSubTab = "overview" | "snapshots" | "runtime" | "advanced";

const MAINTENANCE_TABS: Array<[MaintenanceSubTab, Parameters<typeof t>[1]]> = [
  ["overview", "settings.nav.overview"],
  ["snapshots", "settings.nav.backups"],
  ["runtime", "settings.nav.runtime"],
  ["advanced", "settings.nav.service"],
];

function OverviewTab({ ui, controller, requestServiceStop }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const state = ui.state;
  const writable = controller.canMutate();
  const busy = controller.isBusy();
  const subTab: MaintenanceSubTab =
    ui.settingsTab === "snapshots" || ui.settingsTab === "runtime" || ui.settingsTab === "advanced"
      ? ui.settingsTab
      : "overview";
  if (!state) return <p className="dsh-wb-muted">{t(locale, "app.loading")}</p>;
  return (
    <div className="dsh-wb-maintenance" data-maintenance="true">
      {subTab !== "runtime" ? <InlineErrors ui={ui} origin="dshVersions" /> : null}
      {subTab !== "advanced" ? <InlineErrors ui={ui} origin="service" /> : null}
      <div
        className="dsh-wb-detail-tabs"
        role="tablist"
        aria-label={t(locale, "settings.nav.maintenance")}
        aria-orientation="horizontal"
        data-maintenance-tablist="true"
      >
        {MAINTENANCE_TABS.map(([candidate, label], index) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            id={`maintenance-tab-${candidate}`}
            aria-controls={`maintenance-panel-${candidate}`}
            aria-selected={subTab === candidate}
            tabIndex={subTab === candidate ? 0 : -1}
            className="dsh-wb-tab"
            onClick={() => controller.setSettingsTab(candidate)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % MAINTENANCE_TABS.length
                  : event.key === "ArrowLeft"
                    ? (index + MAINTENANCE_TABS.length - 1) % MAINTENANCE_TABS.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? MAINTENANCE_TABS.length - 1
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              const target = MAINTENANCE_TABS[next][0];
              document.getElementById(`maintenance-tab-${target}`)?.focus();
              controller.setSettingsTab(target);
            }}
          >
            {t(locale, label)}
          </button>
        ))}
      </div>
      <div
        id="maintenance-panel-overview"
        role="tabpanel"
        aria-labelledby="maintenance-tab-overview"
        className="dsh-wb-maintenance-panel"
        data-maintenance-tab="overview"
        hidden={subTab !== "overview"}
      >
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
              {state.owner ? `${state.owner.kind} · ${formatDateTime(locale, state.owner.since)}` : t(locale, "home.ownerNone")}
            </dd>
            <dt>{t(locale, "home.role")}</dt>
            <dd><code>{state.role}</code></dd>
            {state.reasons.length === 0 ? (
              <>
                <dt>{t(locale, "home.reasons")}</dt>
                <dd>{t(locale, "home.noReasons")}</dd>
              </>
            ) : null}
          </dl>
        </details>
        {state.reasons.length > 0 ? (
          <section data-restriction-reasons="true">
            <h3 className="dsh-wb-title">{t(locale, "home.reasons")}</h3>
            <ul>
              {state.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </section>
        ) : null}
        <JobsList locale={locale} jobs={state.jobs} onCancel={controller.cancelJob} />
      </div>
      <div
        id="maintenance-panel-snapshots"
        role="tabpanel"
        aria-labelledby="maintenance-tab-snapshots"
        className="dsh-wb-maintenance-panel"
        data-maintenance-tab="snapshots"
        hidden={subTab !== "snapshots"}
      >
        <section className="dsh-wb-maintenance-section" data-maintenance-section="backups">
          <SnapshotsTab ui={ui} controller={controller} />
        </section>
      </div>
      <div
        id="maintenance-panel-runtime"
        role="tabpanel"
        aria-labelledby="maintenance-tab-runtime"
        className="dsh-wb-maintenance-panel"
        data-maintenance-tab="runtime"
        hidden={subTab !== "runtime"}
      >
        <section className="dsh-wb-maintenance-section" data-maintenance-section="runtime">
          <RuntimeTab ui={ui} controller={controller} showInlineErrors={subTab === "runtime"} />
        </section>
      </div>
      <div
        id="maintenance-panel-advanced"
        role="tabpanel"
        aria-labelledby="maintenance-tab-advanced"
        className="dsh-wb-maintenance-panel"
        data-maintenance-tab="advanced"
        hidden={subTab !== "advanced"}
      >
        <WorkbenchLogSection ui={ui} controller={controller} />
        <section className="dsh-wb-settings-service dsh-wb-danger-zone" data-settings-service="true">
          <h3 className="dsh-wb-title">{t(locale, "settings.service.danger")}</h3>
          <p className="dsh-wb-muted">{t(locale, "settings.service.stopHint")}</p>
          {subTab === "advanced" ? <InlineErrors ui={ui} origin="service" /> : null}
          <div className="dsh-wb-actions">
            <button
              type="button"
              className="dsh-wb-btn danger"
              disabled={!writable || busy}
              onClick={requestServiceStop ?? (() => controller.preview({ kind: "service.shutdown" }))}
            >
              {t(locale, "settings.service.stop")}
            </button>
          </div>
        </section>
      </div>
    </div>
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
    <section className="dsh-wb-maintenance-section" data-workbench-log="true">
      <h3 className="dsh-wb-title">{t(locale, "logs.title")}</h3>
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
      {ui.logs.length > 0 ? (
        <div className="dsh-wb-log-list" data-workbench-log-list="true">
          {ui.logs.map((entry, index) => (
            <pre key={`${entry.at}-${index}`} className="dsh-wb-log">
              {formatDateTime(locale, entry.at)} {t(locale, entry.level === "info" ? "logs.level.info" : entry.level === "warn" ? "logs.level.warn" : "logs.level.error")} {entry.area} {entry.event}
              {entry.code ? ` ${entry.code}` : ""}
              {"\n"}
              {entry.message}
            </pre>
          ))}
        </div>
      ) : null}
      <div className="dsh-wb-actions">
        <CopyButton locale={locale} className="dsh-wb-btn" disabled={!text} text={text} label={t(locale, "app.copyLogs")} />
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
        {!SPACES_BLUEPRINT_SEALED ? (
          <button type="button" className="dsh-wb-btn" disabled={!writable} onClick={controller.openBlueprintUse}>
            {t(locale, "blueprints.createFrom")}
          </button>
        ) : null}
      </div>
      <InlineErrors ui={ui} origin="spaces" />
      {spaces.length === 0 ? (
        <EmptyState testId="spaces" title={t(locale, "home.spacesEmpty")} />
      ) : null}
      {spaces.map((space, index) => (
        <StaggerItem key={space.id} transition={{ ...springSoft, delay: index * 0.035 }}>
          <SpaceListRow
            space={space}
            locale={locale}
            menuOpen={ui.overlay?.type === "menu" && ui.overlay.spaceId === space.id}
            controller={controller}
          />
        </StaggerItem>
      ))}
    </>
  );
}

function SpaceListRow({
  space,
  locale,
  menuOpen,
  controller,
}: {
  space: WorkbenchSpace;
  locale: WorkbenchLocale;
  menuOpen: boolean;
  controller: WorkbenchController;
}): ReactElement {
  return (
    <div
      className="dsh-wb-space-row"
      data-space-id={space.id}
      onContextMenu={(event) => {
        event.preventDefault();
        controller.openMenu(space.id, event.clientX, event.clientY);
      }}
    >
      <button
        type="button"
        className="dsh-wb-space-row-main"
        data-space-open-detail={space.id}
        onClick={() => controller.openDetail(space.id)}
      >
        <SpaceGlyph icon={space.icon} spaceId={space.id} />
        <span>
          {space.displayName}{" "}
          <small>
            {t(locale, statusKey(space.status))}
            {controller.activeJobForSpace(space.id)?.status === "queued" ? ` · ${jobStatusLabel(locale, "queued")}` : ""}
            {space.isHost ? ` · ${t(locale, "detail.host")}` : ""}
            {!space.managed ? ` · ${t(locale, "app.unmanaged")}` : ""}
          </small>
        </span>
      </button>
      <button
        type="button"
        className="dsh-wb-btn"
        aria-haspopup="menu"
        aria-expanded={menuOpen ? true : undefined}
        aria-label={t(locale, "app.menu")}
        data-space-row-actions={space.id}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          controller.openMenu(space.id, rect.left, rect.bottom + 4);
        }}
      >
        ⋯
      </button>
    </div>
  );
}

function SnapshotsTab({ ui, controller }: WorkbenchViewProps): ReactElement {
  const locale = ui.locale;
  const writable = controller.canMutate();
  return (
    <>
      <p className="dsh-wb-muted" data-snapshots-offline-hint="true">{t(locale, "snapshots.offlineHint")}</p>
      <div className="dsh-wb-actions">
        <button
          type="button"
          className="dsh-wb-btn primary"
          disabled={!writable}
          onClick={() => controller.preview({ kind: "snapshot.create" })}
        >
          {t(locale, "snapshots.create")}
        </button>
      </div>
      {ui.snapshotsStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.snapshots ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {ui.snapshots.length === 0 && ui.snapshotsStatus === "ready" ? (
        <EmptyState testId="backups" title={t(locale, "snapshots.empty")} />
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
        {formatDateTime(locale, snapshot.createdAt)} · DSH {snapshot.runtimeVersion} · {formatMegabytes(locale, snapshot.bytes)}
        {" · "}
        <code>{snapshot.id}</code>
        <br />
        <small>
          {t(locale, "snapshots.spaces")}: {snapshot.spaceIds.map((id) => controller.space(id)?.displayName ?? id).join(", ") || "—"}
          {snapshot.restorable ? "" : ` · ${t(locale, "snapshots.notRestorable")}`}
        </small>
      </span>
      <div className="dsh-wb-actions">
        <CopyButton locale={locale} className="dsh-wb-btn" text={snapshot.id} label={t(locale, "snapshots.copyId")} />
        <button
          type="button"
          className="dsh-wb-btn danger"
          disabled={!writable}
          onClick={() => controller.preview({ kind: "snapshot.delete", snapshotId: snapshot.id })}
        >
          {t(locale, "snapshots.delete")}
        </button>
      </div>
    </div>
  );
}

function RuntimeTab({
  ui,
  controller,
  showInlineErrors = true,
}: WorkbenchViewProps & { showInlineErrors?: boolean }): ReactElement {
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
      {showInlineErrors ? <InlineErrors ui={ui} origin="dshVersions" /> : null}
      <p className="dsh-wb-muted">
        {t(locale, "runtime.host")}: {host?.version ?? t(locale, "runtime.none")}
      </p>
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
