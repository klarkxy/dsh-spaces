/**
 * The "create from a template" section of the space template page.
 *
 * The list holds the saved templates and the share package that was read
 * last. Every entry leads into the flow that creates the space: a template
 * asks for the name of the new space, a share package shows the inputs the
 * receiver has to fill in. The failure of either flow is rendered next to the
 * control that caused it.
 */
import React, { useState, type ReactElement } from "react";
import { blueprintRecipe } from "@klarkxy/dsh-blueprint/document";
import { springSoft, StaggerItem, StaggerList } from "../../../../../src/shared/ui/motion";
import { SPACES_BLUEPRINT_SEALED } from "../../../../../src/shared/blueprint-sealed";
import { validateBlueprintSpaceName } from "../blueprint-session";
import { BlueprintCreateFlow } from "../blueprint/create-flow";
import { EmptyState } from "../empty-state";
import { t, type WorkbenchLocale } from "../i18n";
import { ProductOutcomeCard } from "../product-ui";
import type { WorkbenchController, WorkbenchUiState } from "../store";
import { PressableButton } from "../feature-motion";
import { BLUEPRINT_SELECTION } from "./import-section";
import { TemplatesError } from "./errors";

export function TemplatesCreateSection({
  ui,
  controller,
  selected,
  onSelect,
  onGoToImport,
  onGoToExport,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  /** The entry the user opened: a template id or the share package. */
  selected: string | null;
  onSelect: (value: string | null) => void;
  onGoToImport: () => void;
  onGoToExport: () => void;
}): ReactElement {
  const locale = ui.locale;
  const recipe = SPACES_BLUEPRINT_SEALED ? null : ui.blueprint.inspect ? blueprintRecipe(ui.blueprint.inspect.blueprint) : null;
  const showBlueprint = !SPACES_BLUEPRINT_SEALED && (selected === BLUEPRINT_SELECTION || (selected === null && recipe !== null));
  const templateId = selected && selected !== BLUEPRINT_SELECTION ? selected : null;
  const template = templateId ? ui.templates.find((row) => row.id === templateId) ?? null : null;
  const empty = ui.templates.length === 0 && recipe === null;
  return (
    <section
      className="dsh-wb-templates-section"
      data-templates-panel="create"
      role="tabpanel"
      aria-label={t(locale, "templates.section.create")}
    >
      <h3 className="dsh-wb-title">{t(locale, "templates.section.create")}</h3>
      {ui.templatesStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.templates ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {empty ? (
        <div data-templates-empty="true">
          <EmptyState
            testId="templates"
            title={t(locale, "templates.emptyList")}
            hint={t(locale, "templates.emptyListHint")}
            action={
              <div className="dsh-wb-actions">
                <PressableButton type="button" className="dsh-wb-btn primary" onClick={onGoToImport}>
                  {t(locale, "templates.section.import")}
                </PressableButton>
                <PressableButton type="button" className="dsh-wb-btn" onClick={onGoToExport}>
                  {t(locale, "templates.section.export")}
                </PressableButton>
              </div>
            }
          />
        </div>
      ) : null}
      <StaggerList as="ul" className="dsh-wb-template-list" step={0.04}>
        {ui.templates.map((row, index) => (
          <StaggerItem
            key={row.id}
            as="li"
            className="dsh-wb-template-item"
            transition={{ ...springSoft, delay: index * 0.04 }}
          >
            <TemplateCard
              locale={locale}
              name={row.displayName || row.name}
              description={row.name}
              pluginCount={row.plugins.length}
              selected={templateId === row.id}
              onPick={() => onSelect(row.id)}
            />
          </StaggerItem>
        ))}
        {recipe ? (
          <StaggerItem as="li" className="dsh-wb-template-item">
            <TemplateCard
              locale={locale}
              name={recipe.metadata.name}
              description={recipe.metadata.description ?? ""}
              pluginCount={recipe.packages.length}
              selected={showBlueprint}
              onPick={() => onSelect(BLUEPRINT_SELECTION)}
            />
          </StaggerItem>
        ) : null}
      </StaggerList>
      {template ? (
        <TemplateCreateForm ui={ui} controller={controller} templateId={template.id} templateName={template.displayName || template.name} />
      ) : null}
      {showBlueprint ? (
        <div className="dsh-wb-template-form" data-templates-form="blueprint">
          <BlueprintCreateFlow locale={locale} ui={ui.blueprint} controller={controller} />
        </div>
      ) : null}
      <ProductOutcomeCard locale={locale} outcome={ui.lastProductOutcome} />
    </section>
  );
}

/** One entry of the list: a template or the share package that was read. */
function TemplateCard({
  locale,
  name,
  description,
  pluginCount,
  selected,
  onPick,
}: {
  locale: WorkbenchLocale;
  name: string;
  description: string;
  pluginCount: number;
  selected: boolean;
  onPick: () => void;
}): ReactElement {
  return (
    <div className="dsh-wb-template-card" data-template-card="true" data-selected={selected ? "true" : undefined}>
      <div className="dsh-wb-template-card-body">
        <strong>{name}</strong>
        {description ? <p className="dsh-wb-muted">{description}</p> : null}
        <p className="dsh-wb-muted">{t(locale, "templates.pluginCount", { count: String(pluginCount) })}</p>
      </div>
      <PressableButton type="button" className="dsh-wb-btn primary" onClick={onPick}>
        {t(locale, "templates.createSpace")}
      </PressableButton>
    </div>
  );
}

/** The form that creates a space from a saved template. */
function TemplateCreateForm({
  ui,
  controller,
  templateId,
  templateName,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  templateId: string;
  templateName: string;
}): ReactElement {
  const locale = ui.locale;
  const [error, setError] = useState<string | null>(null);
  const writable = controller.canMutate();
  const busy = controller.isBusy();
  return (
    <div className="dsh-wb-template-form" data-templates-form="template">
      <h4 className="dsh-wb-title">{templateName}</h4>
      <label className="dsh-wb-field">
        {t(locale, "templates.name")}
        <input
          value={ui.templateName}
          aria-label={t(locale, "templates.name")}
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
      {error ? <TemplatesError message={error} /> : null}
      <div className="dsh-wb-actions">
        <PressableButton
          
          type="button"
          className="dsh-wb-btn primary"
          disabled={!writable || busy}
          onClick={() => {
            const name = ui.templateName.trim().toLowerCase();
            const state = validateBlueprintSpaceName(name);
            if (state !== "ok") {
              setError(t(locale, state === "reserved" ? "app.nameReserved" : "app.nameInvalid"));
              return;
            }
            setError(null);
            controller.setTemplateId(templateId);
            controller.createFromTemplate();
          }}
        >
          {t(locale, "templates.createConfirm")}
        </PressableButton>
      </div>
    </div>
  );
}
