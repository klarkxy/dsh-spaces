/**
 * The blueprint page of the workbench.
 *
 * The page has two modes: read a blueprint and write one. The mode switch
 * moves the active tab marker, and the panel of the active mode slides into
 * place. The panels keep their failure text readable at all times.
 */
import React, { type ReactElement } from "react";
import type { WorkbenchSpace } from "../../../../../src/shared/workbench";
import { t, type WorkbenchLocale } from "../i18n";
import type { BlueprintUiState } from "../blueprint-session";
import type { WorkbenchController } from "../store";
import { FadeIn, LayoutIndicator } from "../../../../../src/shared/ui";
import { GenerateBlueprintPanel } from "./generate-panel";
import { UseBlueprintPanel } from "./use-panel";

/** The blueprint page. */
export function BlueprintsPage({
  locale,
  ui,
  controller,
  spaces,
}: {
  locale: WorkbenchLocale;
  ui: BlueprintUiState;
  controller: WorkbenchController;
  spaces: WorkbenchSpace[];
}): ReactElement {
  const session = controller.blueprint;
  return (
    <div data-blueprints="true" data-blueprint-mode={ui.mode}>
      <FadeIn as="h2" className="dsh-wb-title">
        {t(locale, "home.blueprints")}
      </FadeIn>
      <div className="dsh-wb-tabs" role="tablist" aria-label={t(locale, "home.blueprints")}>
        <button
          type="button"
          className="dsh-wb-tab dsh-wb-blueprint-tab"
          role="tab"
          aria-selected={ui.mode === "use"}
          onClick={() => session.setMode("use")}
        >
          {t(locale, "blueprints.use")}
          <LayoutIndicator
            as="span"
            layoutId="dsh-wb-blueprint-tab"
            active={ui.mode === "use"}
            className="dsh-wb-blueprint-tab-indicator"
          />
        </button>
        <button
          type="button"
          className="dsh-wb-tab dsh-wb-blueprint-tab"
          role="tab"
          aria-selected={ui.mode === "generate"}
          onClick={() => session.setMode("generate")}
        >
          {t(locale, "blueprints.generate")}
          <LayoutIndicator
            as="span"
            layoutId="dsh-wb-blueprint-tab"
            active={ui.mode === "generate"}
            className="dsh-wb-blueprint-tab-indicator"
          />
        </button>
      </div>
      {ui.mode === "use" ? (
        <UseBlueprintPanel ui={ui} controller={controller} locale={locale} />
      ) : (
        <GenerateBlueprintPanel ui={ui} controller={controller} locale={locale} spaces={spaces} />
      )}
    </div>
  );
}
