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

import React, { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { motion } from "motion/react";
import type { WorkbenchPlan, WorkbenchPlanRequest, WorkbenchSpace } from "../../../../../src/shared/workbench";
import { springSoft, VisibleScale } from "../../../../../src/shared/ui/motion";
import { SPACE_AVATARS } from "../../../../../src/shared/space-avatars";
import { SPACE_NAME_RE } from "../../../../../src/shared/types";
import { SPACES_BLUEPRINT_SEALED } from "../../../../../src/shared/blueprint-sealed";
import { SPACES_BROWSER_SEALED } from "../../../../../src/shared/browser-sealed";
import { ImportPreviewDialog } from "../product-ui";
import { formatDateTime, t, type WorkbenchLocale } from "../i18n";
import type { WorkbenchController } from "../store";
import type { WorkbenchViewProps } from "./shared";
import { SpaceMenu } from "./menu";
import { SettingsDialog } from "./settings";
import { IconPicker, type IconPickState } from "./icon-picker";
import { useModalDialog } from "./use-modal-dialog";

export { IconPicker } from "./icon-picker";
export type { IconPickState } from "./icon-picker";

/** The form variant of the spring entrance; the shared primitive only knows HTML attributes. */
const MotionForm = motion.form;

export function Overlays({ ui, controller, systemPage, requestServiceStop }: WorkbenchViewProps): ReactElement | null {
  return (
    <>
      {ui.overlay?.type === "create" && (
        <CreateDialog
          locale={ui.locale}
          controller={controller}
          hostVersion={ui.state?.dshVersion ?? null}
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
      {(systemPage === "settings" || ui.overlay?.type === "settings") && <SettingsDialog ui={ui} controller={controller} systemPage={systemPage} requestServiceStop={requestServiceStop} />}
      {ui.overlay?.type === "import" && ui.importPreview && (
        <ImportPreviewDialog
          locale={ui.locale}
          preview={ui.importPreview}
          importName={ui.importName}
          importDisplayName={ui.importDisplayName}
          busy={controller.isBusy()}
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
  const danger = plan.destructive || PLAN_DANGER_KINDS.has(kind);
  return (
    <div className="dsh-wb-overlay">
      <VisibleScale ref={panel} className="dsh-wb-dialog" role="dialog" aria-modal="true" aria-labelledby="dsh-wb-plan-title" onKeyDown={modal.onKeyDown}>
        <h2 id="dsh-wb-plan-title" className="dsh-wb-title">
          {title}
        </h2>
        <p>{body}</p>
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

function CreateDialog({
  locale,
  controller,
  hostVersion,
  error,
}: {
  locale: WorkbenchLocale;
  controller: WorkbenchController;
  hostVersion: string | null;
  /** The failure of this form. The dialog stays open and shows it here. */
  error: string | null;
}): ReactElement {
  const panel = useRef<HTMLFormElement>(null);
  const modal = useModalDialog(panel, { onCancel: controller.closeOverlay });
  const [name, setName] = useState("");
  const displayRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<string>(SPACE_AVATARS[0].image);
  const modelSourceRef = useRef<HTMLSelectElement>(null);
  const [base, setBase] = useState<'web' | 'browser'>('web');
  const [version, setVersion] = useState('');
  const [catalog, setCatalog] = useState<{ base: 'web' | 'browser'; versions: string[] } | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setCatalog(null); setVersion(''); setVersionError(null);
    void controller.baseVersions(base).then(result => {
      if (!active) return;
      setCatalog(result); setVersion(result.preferred ?? '');
    }, error => { if (active) setVersionError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [controller, base]);
  const versionReady = catalog?.base === base && catalog.versions.includes(version);
  const iconState = useRef<IconPickState>("idle");
  const [iconBlocked, setIconBlocked] = useState(false);
  const onIconState = (state: IconPickState): void => {
    iconState.current = state;
    setIconBlocked(state !== "idle");
  };
  const nameInvalid = name.length > 0 && !SPACE_NAME_RE.test(name);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (iconState.current !== "idle" || !versionReady || !name || nameInvalid) return;
    controller.createSpace({
      name,
      displayName: displayRef.current?.value,
      icon: iconRef.current,
      base, baseVersion: version,
      ...(base === 'web' ? {modelSource:modelSourceRef.current?.value === 'local' ? 'local' : 'main'} : {}),
    });
  };
  return (
    <div className="dsh-wb-overlay">
      <MotionForm
        ref={panel}
        className="dsh-wb-dialog dsh-wb-create-dialog"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-wb-create-title"
        onKeyDown={modal.onKeyDown}
        initial={{ opacity: 1, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={springSoft}
      >
        <h2 id="dsh-wb-create-title" className="dsh-wb-title">{t(locale, "create.title")}</h2>
        <div className="dsh-wb-create-fields">
        <p className="dsh-wb-muted">{t(locale, "create.hint")}</p>
        {!SPACES_BLUEPRINT_SEALED ? (
          <button type="button" className="dsh-wb-btn" onClick={controller.openBlueprintUse}>
            {t(locale, "blueprints.createFrom")}
          </button>
        ) : null}
        {!SPACES_BROWSER_SEALED ? <label className="dsh-wb-field">
          {t(locale, 'create.base')}
          <select name="base" value={base} onChange={event => setBase(event.target.value as 'web' | 'browser')}>
            <option value="web">Web</option><option value="browser">Browser</option>
          </select>
        </label> : null}
        <label className="dsh-wb-field">
          {t(locale, SPACES_BROWSER_SEALED ? 'create.webVersion' : 'create.baseVersion')}
          <select name="baseVersion" value={versionReady ? version : ''} onChange={event => setVersion(event.target.value)} disabled={catalog?.base !== base} required>
            {!versionReady ? <option value="">{t(locale, 'create.versionPending')}</option> : null}
            {catalog?.base === base ? catalog.versions.map(value => <option key={value} value={value}>{value}</option>) : null}
          </select>
        </label>
        <p className="dsh-wb-muted">{t(locale, base === 'browser' ? 'create.browserBaseHint' : 'create.webBaseHint')}</p>
        {versionError ? <p className="dsh-wb-alert" role="alert">{versionError}</p> : null}
        <label className="dsh-wb-field">
          {t(locale, "create.name")}
          <input
            name="name"
            required
            autoComplete="off"
            maxLength={33}
            spellCheck={false}
            data-autofocus="true"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={nameInvalid || undefined}
            aria-describedby={nameInvalid ? "dsh-wb-create-name-invalid" : undefined}
          />
          {nameInvalid ? (
            <span id="dsh-wb-create-name-invalid" className="dsh-wb-muted" role="alert">
              {t(locale, "app.nameInvalid")}
            </span>
          ) : null}
        </label>
        <label className="dsh-wb-field">
          {t(locale, "create.displayName")}
          <input ref={displayRef} name="displayName" autoComplete="off" />
        </label>
        {base === 'web' ? <>
        <label className="dsh-wb-field">
          {t(locale,'create.modelSource')}
          <select ref={modelSourceRef} name="modelSource" defaultValue="main">
            <option value="main">{t(locale,'create.mainModel')}</option>
            <option value="local">{t(locale,'create.localModel')}</option>
          </select>
        </label>
        <p className="dsh-wb-muted">{t(locale,'create.modelSourceHint')}</p>
        </> : null}
        <IconPicker locale={locale} value={iconRef.current} onChange={(icon) => (iconRef.current = icon)} onState={onIconState} />
        {error ? <p className="dsh-wb-alert" role="alert" data-create-error="true">{error}</p> : null}
        </div>
        {controller.hasActiveJobs() ? (
          <p className="dsh-wb-muted" role="status" data-create-busy="true">{t(locale, "create.busy")}</p>
        ) : null}
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={controller.closeOverlay}>
            {t(locale, "app.cancel")}
          </button>
          <button type="submit" className="dsh-wb-btn primary" disabled={controller.isBusy() || iconBlocked || !versionReady || !name || nameInvalid}>
            {t(locale, "app.create")}
          </button>
        </div>
      </MotionForm>
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

