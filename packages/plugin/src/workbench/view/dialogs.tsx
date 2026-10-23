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
import type { WorkbenchPlan, WorkbenchSpace } from "../../../../../src/shared/workbench";
import { springSoft } from "../../../../../src/shared/ui";
import { PanelScale } from "./motion";
import { SPACE_AVATARS } from "../../../../../src/shared/space-avatars";
import { ImportPreviewDialog } from "../product-ui";
import { t, type WorkbenchLocale } from "../i18n";
import type { WorkbenchController } from "../store";
import type { WorkbenchViewProps } from "./shared";
import { SpaceMenu } from "./menu";
import { SettingsDialog } from "./settings";
import { IconPicker, type IconPickState } from "./icon-picker";

export { IconPicker } from "./icon-picker";
export type { IconPickState } from "./icon-picker";

/** The form variant of the spring entrance; the shared primitive only knows HTML attributes. */
const MotionForm = motion.form;

export function Overlays({ ui, controller, systemPage }: WorkbenchViewProps): ReactElement | null {
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
      {(systemPage === "settings" || ui.overlay?.type === "settings") && <SettingsDialog ui={ui} controller={controller} systemPage={systemPage} />}
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
      {ui.pendingPlan && (
        <PlanDialog locale={ui.locale} plan={ui.pendingPlan.plan} spaces={ui.state?.spaces ?? []} onCancel={controller.closePlan} onConfirm={controller.confirmPlan} />
      )}

    </>
  );
}

function PlanDialog({
  locale,
  plan,
  spaces,
  onCancel,
  onConfirm,
}: {
  locale: WorkbenchLocale;
  plan: WorkbenchPlan;
  spaces: ReadonlyArray<{ id: string; displayName?: string }>;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  // Show display names; the id stays visible when it differs (ids are what the plan acts on).
  const named = (ids: string[]): string => ids.map((id) => {
    const name = spaces.find((space) => space.id === id)?.displayName;
    return name && name !== id ? `${name} (${id})` : id;
  }).join(", ");
  const scopeKey =
    plan.scope === "home" ? "plan.scope.home" : plan.scope === "controller" ? "plan.scope.controller" : "plan.scope.space";
  return (
    <div className="dsh-wb-overlay">
      <PanelScale className="dsh-wb-dialog" role="dialog" aria-labelledby="dsh-wb-plan-title">
        <h2 id="dsh-wb-plan-title" className="dsh-wb-title">
          {t(locale, "plan.title")}
        </h2>
        <p>{plan.title}</p>
        <dl className="dsh-wb-dl">
          <dt>{t(locale, "plan.scope")}</dt>
          <dd>{t(locale, scopeKey)}</dd>
          <dt>{t(locale, "plan.targets")}</dt>
          <dd>{named(plan.affectedSpaceIds) || t(locale, "plan.none")}</dd>
          <dt>{t(locale, "plan.running")}</dt>
          <dd>{named(plan.runningSpaceIds) || t(locale, "plan.none")}</dd>
          <dt>{t(locale, "plan.expires")}</dt>
          <dd>{plan.expiresAt}</dd>
        </dl>
        <p>{t(locale, "plan.changes")}</p>
        <ul>
          {plan.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
        {plan.destructive && (
          <p className="dsh-wb-alert" role="alert">
            {t(locale, "plan.destructive")}
          </p>
        )}
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={onCancel}>
            {t(locale, "app.cancel")}
          </button>
          <button type="button" className="dsh-wb-btn primary" onClick={onConfirm} data-plan-id={plan.id}>
            {t(locale, "app.confirm")}
          </button>
        </div>
      </PanelScale>
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
  const nameRef = useRef<HTMLInputElement>(null);
  const displayRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<string>(SPACE_AVATARS[0].image);
  const modelSourceRef = useRef<HTMLSelectElement>(null);
  const browserRef = useRef<HTMLInputElement>(null);
  const iconState = useRef<IconPickState>("idle");
  const [iconBlocked, setIconBlocked] = useState(false);
  const onIconState = (state: IconPickState): void => {
    iconState.current = state;
    setIconBlocked(state !== "idle");
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (iconState.current !== "idle") return;
    controller.createSpace({
      name: nameRef.current?.value ?? "",
      displayName: displayRef.current?.value,
      icon: iconRef.current,
      ...(browserRef.current?.checked ? {useSharedLlm:false} : {modelSource:(modelSourceRef.current?.value??'main') as 'main'|'shared'|'local'}),
      browser: browserRef.current?.checked === true,
    });
  };
  return (
    <div className="dsh-wb-overlay">
      <MotionForm
        className="dsh-wb-dialog"
        onSubmit={submit}
        aria-label={t(locale, "create.title")}
        initial={{ opacity: 1, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={springSoft}
      >
        <h2 className="dsh-wb-title">{t(locale, "create.title")}</h2>
        <p className="dsh-wb-muted">{t(locale, "create.hint")}</p>
        <button type="button" className="dsh-wb-btn" onClick={controller.openBlueprintUse}>
          {t(locale, "blueprints.createFrom")}
        </button>
        <label className="dsh-wb-field">
          {t(locale, "create.name")}
          <input ref={nameRef} name="name" required autoComplete="off" />
        </label>
        <label className="dsh-wb-field">
          {t(locale, "create.displayName")}
          <input ref={displayRef} name="displayName" autoComplete="off" />
        </label>
        <label className="dsh-wb-field">
          {t(locale,'create.modelSource')}
          <select ref={modelSourceRef} name="modelSource" defaultValue="main">
            <option value="main">{t(locale,'create.mainModel')}</option>
            <option value="shared">{t(locale,'create.useSharedLlm')}</option>
            <option value="local">{t(locale,'create.localModel')}</option>
          </select>
        </label>
        <p className="dsh-wb-muted">{t(locale,'create.modelSourceHint')}</p>
        <label className="dsh-wb-check">
          <input ref={browserRef} type="checkbox" name="browser" />
          {t(locale, "create.browser")}
        </label>
        <p className="dsh-wb-muted">{t(locale, "create.browserHint")}</p>
        <p className="dsh-wb-muted">{t(locale, "create.dshVersion", { version: hostVersion ?? "—" })}</p>
        <IconPicker locale={locale} value={iconRef.current} onChange={(icon) => (iconRef.current = icon)} onState={onIconState} />
        {error ? <p className="dsh-wb-alert" role="alert" data-create-error="true">{error}</p> : null}
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={controller.closeOverlay}>
            {t(locale, "app.cancel")}
          </button>
          <button type="submit" className="dsh-wb-btn primary" disabled={controller.isBusy() || iconBlocked}>
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
  if (!space) return null;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("displayName");
    controller.updateSpace(space.id, { displayName: String(value ?? "").trim() || space.displayName });
  };
  return (
    <div className="dsh-wb-overlay">
      <MotionForm
        className="dsh-wb-dialog"
        onSubmit={submit}
        initial={{ opacity: 1, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={springSoft}
      >
        <h2 className="dsh-wb-title">{t(locale, "rename.title")}</h2>
        {error ? <p className="dsh-wb-alert" role="alert" data-rename-error="true">{error}</p> : null}
        <label className="dsh-wb-field">
          {t(locale, "create.displayName")}
          <input name="displayName" defaultValue={space.displayName} />
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
  if (!space) return null;
  const onIconState = (state: IconPickState): void => {
    iconState.current = state;
    setIconBlocked(state !== "idle");
  };
  return (
    <div className="dsh-wb-overlay">
      <PanelScale className="dsh-wb-dialog">
        <h2 className="dsh-wb-title">{t(locale, "icon.title")}</h2>
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
      </PanelScale>
    </div>
  );
}

