/**
 * The creation flow of an inspected blueprint.
 *
 * The flow starts at an inspected blueprint: it shows the catalogue, collects
 * the receiver-local inputs, names the new space, previews the plan and applies
 * it. A preview is always required before a space is created, and every failure
 * of that flow is rendered as a plain alert next to the control that caused it.
 */
import React, { type ReactElement } from "react";
import { blueprintRecipe } from "@klarkxy/dsh-blueprint/document";
import { t, type WorkbenchLocale } from "../i18n";
import type { BlueprintUiState } from "../blueprint-session";
import { previewPlanMatchesApply } from "../blueprint-session";
import type { WorkbenchController } from "../store";
import { CollapseSection, PressableButton } from "../feature-motion";
import { BlueprintApplyResult } from "./apply";
import { InspectedBlueprint } from "./inspect";
import { LocalInputs } from "./inputs";
import { PreviewBody } from "./preview";

/** The part of the blueprint flow that creates a space. */
export function BlueprintCreateFlow({
  locale,
  ui,
  controller,
}: {
  locale: WorkbenchLocale;
  ui: BlueprintUiState;
  controller: WorkbenchController;
}): ReactElement {
  const session = controller.blueprint;
  const writable = controller.canMutate();
  const blueprint = ui.inspect ? blueprintRecipe(ui.inspect.blueprint) : null;
  const applying = ui.applyStatus === "submitting" || ui.applyStatus === "running";
  const submittedCurrent = previewPlanMatchesApply(ui);
  const hideCreate = submittedCurrent && (ui.applyStatus === "succeeded" || ui.applyStatus === "failed");
  const showApplyChrome = applying || submittedCurrent;
  return (
    <>
      {blueprint ? (
        <InspectedBlueprint locale={locale} blueprint={blueprint} diagnostics={ui.inspect?.diagnostics ?? []} />
      ) : null}
      {blueprint ? (
        <LocalInputs
          locale={locale}
          blueprint={blueprint}
          ui={ui}
          onString={session.setStringInput}
          onBoolean={session.setBooleanInput}
          onModel={session.setModelInput}
          onUnset={session.unsetInput}
        />
      ) : null}
      <CollapseSection open={blueprint !== null} className="dsh-wb-blueprint-create">
        {blueprint ? (
          <>
            <label className="dsh-wb-field">
              {t(locale, "create.name")}
              <input
                value={ui.name}
                autoComplete="off"
                aria-label={t(locale, "create.name")}
                onChange={(event) => session.setName(event.target.value)}
              />
            </label>
            <label className="dsh-wb-field">
              {t(locale, "create.displayName")}
              <input
                value={ui.displayName}
                autoComplete="off"
                aria-label={t(locale, "create.displayName")}
                onChange={(event) => session.setDisplayName(event.target.value)}
              />
            </label>
            <div className="dsh-wb-actions">
              <PressableButton
                as="button"
                type="button"
                className="dsh-wb-btn"
                disabled={!writable || ui.previewStatus === "loading"}
                onClick={() => session.preview()}
              >
                {t(locale, "blueprints.preview")}
              </PressableButton>
              <PressableButton as="button" type="button" className="dsh-wb-btn" onClick={() => session.cancelStaged()}>
                {t(locale, "blueprints.cancelStaged")}
              </PressableButton>
            </div>
          </>
        ) : null}
      </CollapseSection>
      {ui.previewError && (!submittedCurrent || ui.previewStatus === "error") ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.previewError}
        </p>
      ) : null}
      {ui.previewStatus === "loading" ? (
        <p role="status" className="dsh-wb-status-line">
          <span className="dsh-wb-spin" aria-hidden="true" />
          {t(locale, "app.loading")}
        </p>
      ) : null}
      {ui.preview ? (
        <PreviewBody locale={locale} ui={ui} now={controller.now()} />
      ) : null}
      {ui.preview && !hideCreate ? (
        <>
          <p className="dsh-wb-notice">{t(locale, "blueprints.installHint")}</p>
          <div className="dsh-wb-actions">
            <PressableButton
              as="button"
              type="button"
              className="dsh-wb-btn primary"
              data-blueprint-apply-action="true"
              disabled={!writable || applying || !session.canApply()}
              onClick={() => session.apply()}
            >
              {t(locale, "blueprints.apply")}
            </PressableButton>
            {applying ? <span className="dsh-wb-pulse-dot" data-pulse="true" aria-hidden="true" /> : null}
          </div>
        </>
      ) : null}
      {showApplyChrome && ui.applyError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.applyError}
        </p>
      ) : null}
      {showApplyChrome && ui.applyStatus === "succeeded" ? (
        <p className="dsh-wb-notice" role="status" data-blueprint-created="true">
          {t(locale, "blueprints.createdNotStarted")}
          {ui.applyOutcome?.spaceId ? ` · ${controller.space(ui.applyOutcome.spaceId)?.displayName ?? ui.applyOutcome.spaceId}` : ""}
        </p>
      ) : null}
      {showApplyChrome && ui.applyOutcome ? <BlueprintApplyResult locale={locale} outcome={ui.applyOutcome} /> : null}
    </>
  );
}
