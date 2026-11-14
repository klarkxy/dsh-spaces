/**
 * The workbench overlays: plan, create, rename and icon dialogs.
 *
 * Every dialog sits on a glass backdrop that fades in and a panel that
 * scales in with a spring. The dialogs themselves are never removed with an
 * exit animation, so a closed dialog disappears in the same frame it was
 * dismissed.
 *
 * The space detail is not a dialog any more: it is a page inside the settings
 * surface (see `space-detail.tsx`).
 */

import React, { useRef, useState, type FormEvent, type ReactElement } from "react";
import { motion } from "motion/react";
import type { WorkbenchPlan, WorkbenchPlanRequest, WorkbenchSpace } from "../../../../../src/shared/workbench";
import { springSoft, VisibleScale } from "../../../../../src/shared/ui/motion";
import { ImportPreviewDialog } from "../product-ui";
import { formatDateTime, t, type WorkbenchLocale } from "../i18n";
import { isSettingsOverlay, type WorkbenchController } from "../store";
import type { WorkbenchViewProps } from "./shared";
import { SpaceMenu } from "./menu";
import { SettingsDialog } from "./settings";
import { IconPicker, type IconPickState } from "./icon-picker";
import { CreateDialog, ExportShareDialog, SaveTemplateDialog } from "./create-dialog";
import { useModalDialog } from "./use-modal-dialog";

export { IconPicker } from "./icon-picker";
export type { IconPickState } from "./icon-picker";

/** The form variant of the spring entrance; the shared primitive only knows HTML attributes. */
const MotionForm = motion.form;

export function Overlays({ ui, controller, systemPage, requestServiceStop }: WorkbenchViewProps): ReactElement | null {
  return (
    <>
      {(systemPage === "settings" || isSettingsOverlay(ui.overlay)) && (
        <SettingsDialog ui={ui} controller={controller} systemPage={systemPage} requestServiceStop={requestServiceStop} />
      )}
      {ui.overlay?.type === "create" && (
        <CreateDialog
          ui={ui}
          controller={controller}
          initialMode={ui.overlay.mode}
          initialTemplateId={ui.overlay.templateId}
          error={ui.requestOrigin === "create" ? ui.commandError : null}
        />
      )}
      {ui.overlay?.type === "rename" && (
        <RenameDialog
          locale={ui.locale}
          space={controller.space(ui.overlay.spaceId)}
          controller={controller}
          error={ui.requestOrigin === "rename" ? ui.commandError : null}
        />
      )}
      {ui.overlay?.type === "icon" && (
        <IconDialog
          locale={ui.locale}
          space={controller.space(ui.overlay.spaceId)}
          controller={controller}
          error={ui.requestOrigin === "icon" ? ui.commandError : null}
        />
      )}
      {ui.overlay?.type === "save-template" && (
        <SaveTemplateDialog
          ui={ui}
          controller={controller}
          spaceId={ui.overlay.spaceId}
          error={ui.requestOrigin === "save-template" ? ui.commandError : null}
        />
      )}
      {ui.overlay?.type === "export-share" && (
        <ExportShareDialog
          ui={ui}
          controller={controller}
          spaceId={ui.overlay.spaceId}
          error={ui.requestOrigin === "export-share" ? ui.commandError : null}
        />
      )}
      {ui.overlay?.type === "import" && ui.importPreview && (
        <ImportPreviewDialog
          locale={ui.locale}
          preview={ui.importPreview}
          importName={ui.importName}
          importDisplayName={ui.importDisplayName}
          busy={controller.isGlobalBusy() || ui.commandPending}
          error={ui.requestOrigin === "import" ? ui.commandError : null}
          onName={controller.setImportName}
          onDisplayName={controller.setImportDisplayName}
          onCancel={controller.closeImport}
          onConfirm={controller.confirmImport}
        />
      )}
      {ui.overlay?.type === "menu" && (
        <SpaceMenu ui={ui} controller={controller} spaceId={ui.overlay.spaceId} x={ui.overlay.x} y={ui.overlay.y} />
      )}
      {ui.overlay?.type === "creation-failed" && (
        <CreationFailedDialog locale={ui.locale} controller={controller} jobId={ui.overlay.jobId} />
      )}
      {ui.pendingPlan && (
        <PlanDialog locale={ui.locale} plan={ui.pendingPlan.plan} request={ui.pendingPlan.request} spaces={ui.state?.spaces ?? []} onCancel={controller.closePlan} onConfirm={controller.confirmPlan} />
      )}

    </>
  );
}

function CreationFailedDialog({ locale, controller, jobId }: { locale: WorkbenchLocale; controller: WorkbenchController; jobId: string }): ReactElement | null {
  const panel = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const modal = useModalDialog(panel, { onCancel: controller.closeOverlay, initialFocus: cancelRef });
  const creation = controller.visibleCreations().find((row) => row.jobId === jobId);
  if (!creation) return null;
  const title = t(locale, "create.failedTitle").replace("{name}", creation.displayName);
  return (
    <div className="dsh-wb-overlay">
      <VisibleScale ref={panel} className="dsh-wb-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={modal.onKeyDown}>
        <h2 className="dsh-wb-title">{title}</h2>
        <p className="dsh-wb-muted" data-creation-error="true">{creation.error}</p>
        <div className="dsh-wb-actions">
          <button ref={cancelRef} type="button" className="dsh-wb-btn" onClick={() => { controller.closeOverlay(); controller.selectHome(); controller.setHomeTab("overview"); }}>
            {t(locale, "create.viewTask")}
          </button>
          <button type="button" className="dsh-wb-btn" onClick={() => controller.dismissCreation(jobId)}>
            {t(locale, "create.dismiss")}
          </button>
        </div>
      </VisibleScale>
    </div>
  );
}

/** The plan kinds whose confirm button is destructive even when the server did not flag the plan. */
const PLAN_DANGER_KINDS = new Set<string>(["space.delete", "plugin.remove", "snapshot.delete", "runtime.remove"]);

function PlanDialog({
  locale,
  plan,
  request,
  spaces,
  onCancel,
  onConfirm,
}: {
  locale: WorkbenchLocale;
  plan: WorkbenchPlan;
  request: WorkbenchPlanRequest;
  spaces: ReadonlyArray<{ id: string; displayName?: string }>;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const panel = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const modal = useModalDialog(panel, { onCancel, initialFocus: cancelRef });
  // Show display names; the id stays visible when it differs (ids are what the plan acts on).
  const named = (ids: string[]): string => ids.map((id) => {
    const name = spaces.find((space) => space.id === id)?.displayName;
    return name && name !== id ? `${name} (${id})` : id;
  }).join(", ");
  const scopeKey =
    plan.scope === "home" ? "plan.scope.home" : plan.scope === "controller" ? "plan.scope.controller" : "plan.scope.space";
  const kind = request.kind;
  const lifecycle = kind === "service.shutdown" || kind === "space.stop" || kind === "space.restart";
  const action = t(
    locale,
    kind === "service.shutdown" ? "plan.action.stopService" : kind === "space.stop" ? "plan.action.stopSpace" : "plan.action.restartSpace",
  );
  let title: string;
  let body: string;
  let confirmLabel: string;
  if (lifecycle) {
    title = `${action}？`;
    body = t(locale, "plan.lifecycleBody");
    confirmLabel = action;
  } else if (kind === "space.delete") {
    title = t(locale, "plan.title.spaceDelete", { name: named([request.spaceId]) });
    body = t(locale, request.removeData === true ? "plan.body.spaceDeleteData" : "plan.body.spaceDelete");
    confirmLabel = t(locale, "plan.confirm.deleteSpace");
  } else if (kind === "plugin.install") {
    title = t(locale, "plan.title.pluginInstall", { pkg: request.catalogId, version: request.version });
    body = t(locale, "plan.body.pluginInstall", { spaces: named(request.spaceIds) });
    confirmLabel = t(locale, "plan.confirm.install");
  } else if (kind === "plugin.remove") {
    title = t(locale, "plan.title.pluginRemove", { space: named([request.spaceId]), pkg: request.packageName });
    body = t(locale, "plan.body.pluginRemove");
    confirmLabel = t(locale, "plan.confirm.removePlugin");
  } else if (kind === "plugin.toggle" && request.enabled === false) {
    title = t(locale, "plan.title.pluginDisable", { space: named([request.spaceId]), pluginId: request.pluginId });
    body = t(locale, "plan.body.pluginDisable");
    confirmLabel = t(locale, "plan.confirm.remove");
  } else if (kind === "plugin.toggle") {
    title = t(locale, "plan.title.pluginEnable", { space: named([request.spaceId]), pluginId: request.pluginId });
    body = t(locale, "plan.body.pluginEnable");
    confirmLabel = t(locale, "plan.confirm.enable");
  } else if (kind === "space.models.sync") {
    title = t(locale, "plan.title.modelsSync", { space: named([request.spaceId]) });
    body = t(locale, "detail.models.hint");
    confirmLabel = t(locale, "plan.confirm.syncModels");
  } else if (kind === "plugin.cleanup-manager") {
    title = t(locale, "plan.title.pluginCleanup", { space: named([request.spaceId]) });
    body = t(locale, "plugins.cleanupHint");
    confirmLabel = t(locale, "plan.confirm.cleanup");
  } else if (kind === "snapshot.create") {
    title = t(locale, "plan.title.snapshotCreate");
    body = t(locale, "snapshots.createHint");
    confirmLabel = t(locale, "plan.confirm.backup");
  } else if (kind === "snapshot.delete") {
    title = t(locale, "plan.title.snapshotDelete");
    body = t(locale, "plan.body.snapshotDelete");
    confirmLabel = t(locale, "plan.confirm.deleteBackup");
  } else if (kind === "runtime.remove") {
    title = t(locale, "plan.title.runtimeRemove", { version: request.version });
    body = t(locale, "runtime.hint");
    confirmLabel = t(locale, "plan.confirm.removeRuntime");
  } else {
    title = t(locale, "plan.title");
    body = plan.title;
    confirmLabel = t(locale, "app.confirm");
  }
  const livePluginPlan =
    kind === "plugin.install" ||
    kind === "plugin.install.spec" ||
    kind === "plugin.remove" ||
    kind === "plugin.toggle";
  const stopsAndRestores =
    plan.runningSpaceIds.length > 0 &&
    !lifecycle &&
    !livePluginPlan &&
    kind !== "space.delete" &&
    kind !== "snapshot.create" &&
    kind !== "space.models.sync";
  if (stopsAndRestores) {
    const key = kind === "plugin.cleanup-manager" ? "plan.confirm.stopAndCleanup"
      : kind === "space.runtime.set" ? "plan.confirm.stopAndRuntime"
      : "plan.confirm.stopAndApply";
    confirmLabel = t(locale, key);
  }
  const danger = plan.destructive || PLAN_DANGER_KINDS.has(kind);
  return (
    <div className="dsh-wb-overlay">
      <VisibleScale ref={panel} className="dsh-wb-dialog" role="dialog" aria-modal="true" aria-labelledby="dsh-wb-plan-title" onKeyDown={modal.onKeyDown}>
        <h2 id="dsh-wb-plan-title" className="dsh-wb-title">
          {title}
        </h2>
        <p>{body}</p>
        {plan.modelsSync ? (
          <dl className="dsh-wb-dl" data-plan-models-summary="true">
            <dt>{t(locale, "plan.models.summary")}</dt>
            <dd>{plan.modelsSync.mainProfile}</dd>
            <dt>{t(locale, "plan.models.default")}</dt>
            <dd>{plan.modelsSync.defaultModel ?? (plan.modelsSync.defaultModelSkipped ? t(locale, "plan.models.skippedDefault") : t(locale, "plan.none"))}</dd>
            <dt>{t(locale, "plan.models.routes")}</dt>
            <dd>{plan.modelsSync.routes.length} · {plan.modelsSync.routes.join(", ") || t(locale, "plan.none")}</dd>
            <dt>{t(locale, "plan.models.keys")}</dt>
            <dd>{plan.modelsSync.credentials.length} · {plan.modelsSync.credentials.join(", ") || t(locale, "plan.none")}</dd>
            <dt>{t(locale, "plan.models.skipped")}</dt>
            <dd>{plan.modelsSync.skipped.map((skip) => `${skip.route} (${t(locale, `plan.models.skip.${skip.reason}`)})`).join(", ") || t(locale, "plan.none")}</dd>
            <dt>{t(locale, "plan.models.missing")}</dt>
            <dd>{plan.modelsSync.missingCredentials.join(", ") || t(locale, "plan.none")}</dd>
          </dl>
        ) : null}
        {kind === "space.models.sync" && plan.runningSpaceIds.includes(request.spaceId) ? <p data-plan-models-live="true">{t(locale, "plan.models.liveBody")}</p> : null}
        {livePluginPlan && plan.runningSpaceIds.length > 0 ? <p data-plan-plugins-live="true">{t(locale, "plan.plugins.liveBody")}</p> : null}
        {stopsAndRestores ? <p data-plan-stop-impact="true">{t(locale, "plan.stopAndRestore", { spaces: named(plan.runningSpaceIds) })}</p> : null}
        {plan.taskActivity === "unknown" && <p>{t(locale, "plan.taskUnknown")}</p>}
        <dl className="dsh-wb-dl">
          <dt>{t(locale, "plan.targets")}</dt>
          <dd>{named(plan.affectedSpaceIds) || t(locale, "plan.none")}</dd>
          <dt>{t(locale, "plan.running")}</dt>
          <dd>{named(plan.runningSpaceIds) || t(locale, "plan.none")}</dd>
        </dl>
        <details><summary>{t(locale, "plan.details")}</summary>
        <p>{plan.title}</p>
        <p>{t(locale, "plan.scope")}: {t(locale, scopeKey)}</p>
        <p>{t(locale, "plan.expires")}: {formatDateTime(locale, plan.expiresAt)}</p>
        <p>{t(locale, "plan.changes")}</p>
        <ul>
          {plan.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
        </details>
        {plan.destructive && plan.kind !== "service.shutdown" && (
          <p className="dsh-wb-alert" role="alert">
            {t(locale, "plan.destructive")}
          </p>
        )}
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" ref={cancelRef} onClick={onCancel}>
            {t(locale, "app.cancel")}
          </button>
          <button type="button" className={`dsh-wb-btn ${danger ? "danger" : "primary"}`} onClick={onConfirm} data-plan-id={plan.id}>
            {confirmLabel}
          </button>
        </div>
      </VisibleScale>
    </div>
  );
}

function RenameDialog({
  locale,
  space,
  controller,
  error,
}: {
  locale: WorkbenchLocale;
  space?: WorkbenchSpace;
  controller: WorkbenchController;
  error: string | null;
}): ReactElement | null {
  const panel = useRef<HTMLFormElement>(null);
  const modal = useModalDialog(panel, { onCancel: controller.closeOverlay });
  if (!space) return null;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("displayName");
    controller.updateSpace(space.id, { displayName: String(value ?? "").trim() || space.displayName });
  };
  return (
    <div className="dsh-wb-overlay">
      <MotionForm
        ref={panel}
        className="dsh-wb-dialog"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-wb-rename-title"
        onKeyDown={modal.onKeyDown}
        initial={{ opacity: 1, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={springSoft}
      >
        <h2 id="dsh-wb-rename-title" className="dsh-wb-title">{t(locale, "rename.title")}</h2>
        {error ? <p className="dsh-wb-alert" role="alert" data-rename-error="true">{error}</p> : null}
        <label className="dsh-wb-field">
          {t(locale, "create.displayName")}
          <input name="displayName" defaultValue={space.displayName} required data-autofocus="true" />
        </label>
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={controller.closeOverlay}>
            {t(locale, "app.cancel")}
          </button>
          <button type="submit" className="dsh-wb-btn primary">
            {t(locale, "app.save")}
          </button>
        </div>
      </MotionForm>
    </div>
  );
}

function IconDialog({
  locale,
  space,
  controller,
  error,
}: {
  locale: WorkbenchLocale;
  space?: WorkbenchSpace;
  controller: WorkbenchController;
  error: string | null;
}): ReactElement | null {
  const iconRef = useRef(space?.icon ?? "");
  const iconState = useRef<IconPickState>("idle");
  const [iconBlocked, setIconBlocked] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const modal = useModalDialog(panel, { onCancel: controller.closeOverlay });
  if (!space) return null;
  const onIconState = (state: IconPickState): void => {
    iconState.current = state;
    setIconBlocked(state !== "idle");
  };
  return (
    <div className="dsh-wb-overlay">
      <VisibleScale ref={panel} className="dsh-wb-dialog" role="dialog" aria-modal="true" aria-labelledby="dsh-wb-icon-title" onKeyDown={modal.onKeyDown}>
        <h2 id="dsh-wb-icon-title" className="dsh-wb-title">{t(locale, "icon.title")}</h2>
        {error ? <p className="dsh-wb-alert" role="alert" data-icon-error="true">{error}</p> : null}
        <IconPicker locale={locale} value={space.icon} spaceId={space.id} onChange={(icon) => (iconRef.current = icon)} onState={onIconState} />
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={controller.closeOverlay}>
            {t(locale, "app.cancel")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn primary"
            disabled={iconBlocked}
            onClick={() => {
              if (iconState.current !== "idle") return;
              controller.updateSpace(space.id, { icon: iconRef.current });
            }}
          >
            {t(locale, "app.save")}
          </button>
        </div>
      </VisibleScale>
    </div>
  );
}

