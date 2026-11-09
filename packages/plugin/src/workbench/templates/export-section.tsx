/**
 * The export section of the space template page.
 *
 * One space is picked, and three ways to take it out of this machine are
 * offered: a local template, a share file and a share code. The share code
 * carries the options that only matter to somebody who writes templates by
 * hand, so they stay inside the advanced options.
 */
import React, { useState, type ReactElement } from "react";
import { t } from "../i18n";
import { SPACES_BLUEPRINT_SEALED } from "../../../../../src/shared/blueprint-sealed";
import type { WorkbenchController, WorkbenchUiState } from "../store";
import { GenerateBlueprintPanel } from "../blueprint/generate-panel";
import { EmptyState } from "../empty-state";
import { InlineErrors } from "../inline-error";
import { PressableButton } from "../feature-motion";
import { TemplatesError } from "./errors";

export function TemplatesExportSection({
  ui,
  controller,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
}): ReactElement {
  const locale = ui.locale;
  const spaces = controller.workspaceSpaces();
  const writable = controller.canMutate();
  const busy = controller.isBusy();
  const spaceId = ui.blueprint.sourceSpaceId || ui.shareSpaceId;
  const [saveError, setSaveError] = useState<string | null>(null);
  const generating = ui.blueprint.mode === "generate";
  return (
    <section
      className="dsh-wb-templates-section"
      data-templates-panel="export"
      role="tabpanel"
      aria-label={t(locale, "templates.section.export")}
    >
      <h3 className="dsh-wb-title">{t(locale, "templates.section.export")}</h3>
      <InlineErrors ui={ui} origin="templates:export" />
      {spaces.length === 0 ? (
        <EmptyState
          testId="templatesExport"
          title={t(locale, "templates.export.empty")}
          action={
            <PressableButton type="button" className="dsh-wb-btn primary" disabled={!writable} onClick={controller.openCreate}>
              {t(locale, "app.newSpace")}
            </PressableButton>
          }
        />
      ) : null}
      <label className="dsh-wb-field">
        {t(locale, "templates.export.sourceSpace")}
        <select
          value={spaceId}
          aria-label={t(locale, "templates.export.sourceSpace")}
          onChange={(event) => {
            const value = event.target.value;
            controller.setShareSpaceId(value);
            controller.setTemplateSpaceId(value);
            if (generating) controller.blueprint.setSourceSpaceId(value);
          }}
        >
          {spaces.map((space) => (
            <option key={space.id} value={space.id}>
              {space.displayName}
            </option>
          ))}
        </select>
      </label>
      <div className="dsh-wb-template-cards">
        <div className="dsh-wb-template-card" data-templates-action="save">
          <h4 className="dsh-wb-title">{t(locale, "templates.export.saveTemplate")}</h4>
          <label className="dsh-wb-field">
            {t(locale, "templates.export.templateName")}
            <input
              value={ui.templateName}
              aria-label={t(locale, "templates.export.templateName")}
              autoComplete="off"
              onChange={(event) => controller.setTemplateName(event.target.value)}
            />
          </label>
          <label className="dsh-wb-field">
            {t(locale, "create.displayName")}
            <input
              value={ui.templateDisplayName}
              aria-label={t(locale, "create.displayName")}
              autoComplete="off"
              onChange={(event) => controller.setTemplateDisplayName(event.target.value)}
            />
          </label>
          <label className="dsh-wb-check">
            <input
              type="checkbox"
              checked={ui.templateIncludeConfig}
              onChange={(event) => controller.setTemplateIncludeConfig(event.target.checked)}
            />
            {t(locale, "templates.includeConfig")}
          </label>
          {saveError ? <TemplatesError message={saveError} /> : null}
          <div className="dsh-wb-actions">
            <PressableButton
              
              type="button"
              className="dsh-wb-btn primary"
              disabled={!writable || busy}
              onClick={() => {
                if (!spaceId || !ui.templateName.trim()) {
                  setSaveError(t(locale, "templates.needName"));
                  return;
                }
                setSaveError(null);
                controller.setTemplateSpaceId(spaceId);
                controller.saveTemplate();
              }}
            >
              {t(locale, "templates.save")}
            </PressableButton>
          </div>
        </div>
        <div className="dsh-wb-template-card" data-templates-action="share">
          <h4 className="dsh-wb-title">{t(locale, "templates.export.shareFile")}</h4>
          <label className="dsh-wb-check">
            <input
              type="checkbox"
              checked={ui.shareIncludeConfig}
              onChange={(event) => controller.setShareIncludeConfig(event.target.checked)}
            />
            {t(locale, "share.includeConfig")}
          </label>
          <div className="dsh-wb-actions">
            <PressableButton
              
              type="button"
              className="dsh-wb-btn primary"
              disabled={!writable || busy || !spaceId}
              onClick={() => {
                controller.setShareSpaceId(spaceId);
                controller.exportShare();
              }}
            >
              {t(locale, "share.export")}
            </PressableButton>
          </div>
        </div>
        {!SPACES_BLUEPRINT_SEALED ? (
          <div className="dsh-wb-template-card" data-templates-action="share-code">
            <h4 className="dsh-wb-title">{t(locale, "templates.export.shareCode")}</h4>
            <div className="dsh-wb-actions">
              <PressableButton
                
                type="button"
                className="dsh-wb-btn"
                onClick={() => {
                  controller.blueprint.setSourceSpaceId(spaceId);
                  controller.blueprint.setMode("generate");
                }}
              >
                {t(locale, "templates.export.createShareCode")}
              </PressableButton>
            </div>
            <details className="dsh-wb-form" data-templates-advanced="true" open={generating}>
              <summary>{t(locale, "templates.export.advanced")}</summary>
              <GenerateBlueprintPanel
                locale={locale}
                ui={ui.blueprint}
                controller={controller}
                spaces={spaces}
                showSource={false}
              />
            </details>
          </div>
        ) : null}
      </div>
    </section>
  );
}
