/**
 * The unified space template page of the workbench.
 *
 * The page replaces the three overlapping flows of the old settings — the
 * blueprint tab, the templates tab and the share import — with one surface
 * that has three sections:
 *
 * - **Create from a template**: the saved templates and the share package that
 *   was read last, each leading into the flow that creates the space.
 * - **Import**: one drop zone that takes a share file or a blueprint, and the
 *   collapsed paste box for a share code.
 * - **Export**: one space and the three ways to take it out of this machine.
 *
 * The blueprint session decides which section is open: a session that writes a
 * blueprint belongs to the export section, a session that reads one belongs to
 * the create section. That is why `controller.openBlueprintGenerate(spaceId)`
 * lands in the export section with the space already picked.
 *
 * The root carries `data-templates-section` with the open section; the section
 * itself carries `data-templates-panel`.
 */
import React, { useState, type ReactElement } from "react";
import { FadeIn, LayoutIndicator } from "../../../../../src/shared/ui";
import type { BlueprintMode } from "../blueprint-session";
import { InlineErrors } from "../inline-error";
import { t } from "../i18n";
import type { WorkbenchController, WorkbenchUiState } from "../store";
import { TemplatesCreateSection } from "./create-section";
import { TemplatesExportSection } from "./export-section";
import { BLUEPRINT_SELECTION, TemplatesImportSection } from "./import-section";

/** The three sections of the page. */
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
  const locale = ui.locale;
  const mode = ui.blueprint.mode;
  const [view, setView] = useState<{ section: TemplatesSection; mode: BlueprintMode }>({
    section: initialSection ?? sectionForMode(mode),
    mode,
  });
  // A blueprint session that changes its mode decides the section again: a
  // session that writes a blueprint belongs to the export section.
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
      data-blueprints="true"
      data-blueprint-mode={mode}
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
