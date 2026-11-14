import React, { useState, type ReactElement } from "react";
import { FadeIn, LayoutIndicator, springSoft, StaggerItem, StaggerList } from "../../../../../src/shared/ui/motion";
import { SPACES_BLUEPRINT_SEALED } from "../../../../../src/shared/blueprint-sealed";
import type { BlueprintMode } from "../blueprint-session";
import { EmptyState } from "../empty-state";
import { PressableButton } from "../feature-motion";
import { InlineErrors } from "../inline-error";
import { t } from "../i18n";
import { ProductOutcomeCard } from "../product-ui";
import type { WorkbenchController, WorkbenchUiState } from "../store";
import { TemplatesCreateSection } from "./create-section";
import { TemplatesExportSection } from "./export-section";
import { BLUEPRINT_SELECTION, TemplatesImportSection } from "./import-section";

/** The legacy blueprint sections when blueprint mode is unsealed. */
export type TemplatesSection = "create" | "import" | "export";

/** The section a blueprint session belongs to: writing one is an export, reading one is a create. */
export function sectionForMode(mode: BlueprintMode): TemplatesSection {
  return mode === "generate" ? "export" : "create";
}

const SECTIONS: Array<{ id: TemplatesSection; label: "templates.section.create" | "templates.section.import" | "templates.section.export" }> = [
  { id: "create", label: "templates.section.create" },
  { id: "import", label: "templates.section.import" },
  { id: "export", label: "templates.section.export" },
];

export function SpaceTemplatesPage({
  ui,
  controller,
  initialSection,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  /** The section to open with. Without it the blueprint session decides. */
  initialSection?: TemplatesSection;
}): ReactElement {
  if (SPACES_BLUEPRINT_SEALED) {
    return <SavedTemplatesManager ui={ui} controller={controller} />;
  }
  return <UnsealedBlueprintTemplatesPage ui={ui} controller={controller} initialSection={initialSection} />;
}

function SavedTemplatesManager({
  ui,
  controller,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
}): ReactElement {
  const locale = ui.locale;
  const writable = controller.canMutate();
  const busy = controller.isGlobalBusy() || ui.commandPending;
  return (
    <div className="dsh-wb-templates" data-templates="true">
      <FadeIn as="h2" className="dsh-wb-title">
        {t(locale, "templates.title")}
      </FadeIn>
      <InlineErrors ui={ui} origin="templates" />
      {ui.templatesStatus === "loading" ? (
        <p role="status" className="dsh-wb-muted">{t(locale, "app.loading")}</p>
      ) : null}
      {ui.templatesStatus === "error" ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.readError.templates ?? t(locale, "app.genericError")}
        </p>
      ) : null}
      {ui.templates.length === 0 && ui.templatesStatus !== "loading" ? (
        <div data-templates-empty="true">
          <EmptyState
            testId="templates"
            title={t(locale, "templates.emptySaved")}
            hint={t(locale, "templates.emptySavedHint")}
            action={
              <PressableButton
                type="button"
                className="dsh-wb-btn primary"
                disabled={!writable}
                onClick={() => controller.openCreate()}
              >
                {t(locale, "app.newSpace")}
              </PressableButton>
            }
          />
        </div>
      ) : null}
      {ui.templates.length > 0 ? (
        <StaggerList as="ul" className="dsh-wb-template-list" step={0.04}>
          {ui.templates.map((row, index) => (
            <StaggerItem
              key={row.id}
              as="li"
              className="dsh-wb-template-item"
              transition={{ ...springSoft, delay: index * 0.04 }}
            >
              <div className="dsh-wb-template-card" data-template-card="true" data-template-id={row.id}>
                <div className="dsh-wb-template-card-body">
                  <strong>{row.displayName || row.name}</strong>
                  {row.displayName && row.displayName !== row.name ? (
                    <p className="dsh-wb-muted">{row.name}</p>
                  ) : null}
                  <p className="dsh-wb-muted">
                    {t(locale, "templates.pluginCount", { count: String(row.plugins.length) })}
                    {row.plugins.length > 0
                      ? ` · ${row.plugins.map((plugin) => plugin.packageName).join(", ")}`
                      : ""}
                  </p>
                </div>
                <div className="dsh-wb-actions">
                  <PressableButton
                    type="button"
                    className="dsh-wb-btn primary"
                    disabled={!writable}
                    data-template-use={row.id}
                    onClick={() => controller.openCreate({ mode: "template", templateId: row.id })}
                  >
                    {t(locale, "templates.useTemplate")}
                  </PressableButton>
                  <PressableButton
                    type="button"
                    className="dsh-wb-btn danger"
                    disabled={!writable || busy}
                    data-template-delete={row.id}
                    onClick={() => controller.deleteTemplate(row.id)}
                  >
                    {t(locale, "templates.delete")}
                  </PressableButton>
                </div>
              </div>
            </StaggerItem>
          ))}
        </StaggerList>
      ) : null}
      <ProductOutcomeCard locale={locale} outcome={ui.lastProductOutcome} />
    </div>
  );
}

function UnsealedBlueprintTemplatesPage({
  ui,
  controller,
  initialSection,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  initialSection?: TemplatesSection;
}): ReactElement {
  const locale = ui.locale;
  const mode = ui.blueprint.mode;
  const [view, setView] = useState<{ section: TemplatesSection; mode: BlueprintMode }>({
    section: initialSection ?? sectionForMode(mode),
    mode,
  });
  let section = view.section;
  if (view.mode !== mode) {
    section = sectionForMode(mode);
    setView({ section, mode });
  }
  const [selected, setSelected] = useState<string | null>(null);

  const choose = (next: TemplatesSection): void => {
    setView({ section: next, mode });
    if (next === "create") controller.blueprint.setMode("use");
  };

  return (
    <div
      className="dsh-wb-templates"
      data-templates="true"
      data-blueprints={SPACES_BLUEPRINT_SEALED ? undefined : true}
      data-blueprint-mode={SPACES_BLUEPRINT_SEALED ? undefined : mode}
      data-templates-section={section}
    >
      <FadeIn as="h2" className="dsh-wb-title">
        {t(locale, "templates.title")}
      </FadeIn>
      <div className="dsh-wb-tabs dsh-wb-template-tabs" role="tablist" aria-label={t(locale, "templates.title")}>
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className="dsh-wb-tab dsh-wb-template-tab"
            aria-selected={section === entry.id}
            onClick={() => choose(entry.id)}
          >
            {t(locale, entry.label)}
            <LayoutIndicator
              as="span"
              layoutId="dsh-wb-template-tab"
              active={section === entry.id}
              className="dsh-wb-template-tab-indicator"
            />
          </button>
        ))}
      </div>
      {section === "create" ? (
        <TemplatesCreateSection
          ui={ui}
          controller={controller}
          selected={selected}
          onSelect={setSelected}
          onGoToImport={() => choose("import")}
          onGoToExport={() => choose("export")}
        />
      ) : null}
      {section === "import" ? (
        <TemplatesImportSection
          ui={ui}
          controller={controller}
          onBlueprintReady={() => {
            setSelected(BLUEPRINT_SELECTION);
            choose("create");
          }}
        />
      ) : null}
      {section === "export" ? <TemplatesExportSection ui={ui} controller={controller} /> : null}
      {section !== "import" ? <InlineErrors ui={ui} origin="templates:import" /> : null}
      {section !== "export" ? <InlineErrors ui={ui} origin="templates:export" /> : null}
    </div>
  );
}
