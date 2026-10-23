/**
 * The "use a blueprint" panel.
 *
 * The panel reads a share code or a JSON file, inspects it and hands over to
 * the creation flow (`create-flow.tsx`), which collects the local inputs,
 * previews the plan and applies it. Every failure of that flow — a file that
 * cannot be read, a blueprint that does not inspect, an expired preview, a
 * package that did not install — is rendered as a plain alert that is readable
 * from the first frame. Only the decorative blocks move.
 */
import React, { type ChangeEvent, type ReactElement } from "react";
import { t, type WorkbenchLocale } from "../i18n";
import type { BlueprintUiState } from "../blueprint-session";
import type { WorkbenchController } from "../store";
import { PressableButton } from "../feature-motion";
import { VisibleSlide } from "../feature-motion";
import { BlueprintCreateFlow } from "./create-flow";

/** The panel that reads and applies an existing blueprint. */
export function UseBlueprintPanel({
  ui,
  controller,
  locale,
}: {
  ui: BlueprintUiState;
  controller: WorkbenchController;
  locale: WorkbenchLocale;
}): ReactElement {
  const session = controller.blueprint;
  return (
    <VisibleSlide as="div" className="dsh-wb-form wide" from={12}>
      <label className="dsh-wb-field">
        {t(locale, "blueprints.paste")}
        <textarea
          rows={8}
          value={ui.content}
          aria-label={t(locale, "blueprints.paste")}
          spellCheck={false}
          onChange={(event) => session.setContent(event.target.value)}
        />
      </label>
      <label className="dsh-wb-field">
        {t(locale, "blueprints.openFile")}
        <input
          type="file"
          accept=".json,.txt,text/plain,application/json"
          aria-label={t(locale, "blueprints.openFile")}
          onChange={(event) => void onBlueprintFile(event, controller)}
        />
      </label>
      {ui.fileName ? <p className="dsh-wb-muted">{ui.fileName}</p> : null}
      {ui.contentError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.contentError}
        </p>
      ) : null}
      <div className="dsh-wb-actions">
        <PressableButton
          as="button"
          type="button"
          className="dsh-wb-btn primary"
          disabled={ui.inspectStatus === "loading"}
          onClick={() => session.inspect()}
        >
          {t(locale, "blueprints.inspect")}
        </PressableButton>
      </div>
      {ui.inspectStatus === "loading" ? (
        <p role="status" className="dsh-wb-status-line">
          <span className="dsh-wb-spin" aria-hidden="true" />
          {t(locale, "app.loading")}
        </p>
      ) : null}
      {ui.inspectError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.inspectError}
        </p>
      ) : null}
      <BlueprintCreateFlow locale={locale} ui={ui} controller={controller} />
    </VisibleSlide>
  );
}

async function onBlueprintFile(event: ChangeEvent<HTMLInputElement>, controller: WorkbenchController): Promise<void> {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const buffer = await file.arrayBuffer();
  controller.blueprint.readFileBytes(new Uint8Array(buffer), file.name);
}
