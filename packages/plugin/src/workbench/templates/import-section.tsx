/**
 * The import section of the space template page.
 *
 * One drop zone takes both kinds of input: a share archive is previewed and
 * imported, a blueprint is inspected and leads into the creation flow. The
 * kind is detected from the content; a file that is neither is reported as
 * unknown instead of being guessed. The paste box stays collapsed, because a
 * share code is the rare case.
 */
import React, { useState, type ReactElement } from "react";
import { MAX_WORKBENCH_SHARE_BASE64 } from "../../../../../src/shared/workbench-product";
import { SPACES_BLUEPRINT_SEALED } from "../../../../../src/shared/blueprint-sealed";
import { bytesToBase64, decodeBlueprintFileBytes } from "../blueprint-session";
import { InlineErrors } from "../inline-error";
import { t, type WorkbenchLocale, type WorkbenchMessageKey } from "../i18n";
import type { WorkbenchController, WorkbenchUiState } from "../store";
import { PressableButton } from "../feature-motion";
import { detectTemplateFile, formatFileSize } from "./detect";
import { TemplateDropZone } from "./drop-zone";
import { TemplatesError } from "./errors";

/** The name of the blueprint entry in the create list. */
export const BLUEPRINT_SELECTION = "blueprint";

export function TemplatesImportSection({
  ui,
  controller,
  onBlueprintReady,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  onBlueprintReady: () => void;
}): ReactElement {
  const locale = ui.locale;
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const take = (selected: File): void => {
    setFile({ name: selected.name, size: selected.size });
    setError(null);
    void importTemplateFile(selected, controller, locale, setError, onBlueprintReady);
  };

  return (
    <section
      className="dsh-wb-templates-section"
      data-templates-panel="import"
      role="tabpanel"
      aria-label={t(locale, "templates.section.import")}
    >
      <h3 className="dsh-wb-title">{t(locale, "templates.section.import")}</h3>
      <TemplateDropZone locale={locale} onFile={take} />
      {file ? (
        <p className="dsh-wb-muted" data-templates-file="true">
          {t(locale, "templates.drop.selected")}: {file.name} · {formatFileSize(file.size)}
        </p>
      ) : null}
      {error ? <TemplatesError message={error} /> : null}
      <InlineErrors ui={ui} origin="templates:import" />
      {!SPACES_BLUEPRINT_SEALED ? (
        <details className="dsh-wb-form" data-templates-paste="true">
          <summary>{t(locale, "blueprints.paste")}</summary>
          <div className="dsh-wb-field">
            <textarea
              rows={6}
              value={ui.blueprint.content}
              aria-label={t(locale, "blueprints.paste")}
              spellCheck={false}
              onChange={(event) => controller.blueprint.setContent(event.target.value)}
            />
          </div>
          <div className="dsh-wb-actions">
            <PressableButton
              
              type="button"
              className="dsh-wb-btn primary"
              disabled={ui.blueprint.inspectStatus === "loading"}
              onClick={() => {
                controller.blueprint.setMode("use");
                controller.blueprint.inspect();
                onBlueprintReady();
              }}
            >
              {t(locale, "blueprints.inspect")}
            </PressableButton>
          </div>
          {ui.blueprint.contentError ? <TemplatesError message={ui.blueprint.contentError} /> : null}
          {ui.blueprint.inspectError ? <TemplatesError message={ui.blueprint.inspectError} /> : null}
        </details>
      ) : null}
    </section>
  );
}

function decodeMessageKey(code: string): WorkbenchMessageKey {
  if (code === "bom") return "blueprints.bom";
  if (code === "utf8") return "blueprints.utf8";
  if (code === "too-large-json") return "blueprints.tooLargeJson";
  if (code === "too-large-share") return "blueprints.tooLargeShare";
  return "blueprints.empty";
}

/**
 * Read the file the user picked and route it to the flow it belongs to.
 *
 * A share archive goes to the import preview, a blueprint is inspected and
 * leads into the creation flow, and anything else is reported as unknown.
 */
export async function importTemplateFile(
  file: File,
  controller: WorkbenchController,
  locale: WorkbenchLocale,
  onError: (message: string) => void,
  onBlueprintReady: () => void,
): Promise<void> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detectTemplateFile(file.name, bytes);
    if (kind === "share-archive") {
      const base64 = bytesToBase64(bytes);
      if (base64.length > MAX_WORKBENCH_SHARE_BASE64) {
        onError(t(locale, "templates.drop.tooLarge"));
        return;
      }
      controller.previewImportArchive(base64, file.name);
      return;
    }
    if (kind === "blueprint" && !SPACES_BLUEPRINT_SEALED) {
      const decoded = decodeBlueprintFileBytes(bytes);
      if (!decoded.ok) {
        onError(t(locale, decodeMessageKey(decoded.code)));
        return;
      }
      controller.blueprint.setMode("use");
      controller.blueprint.readFileBytes(bytes, file.name);
      controller.blueprint.inspect();
      onBlueprintReady();
      return;
    }
    onError(t(locale, SPACES_BLUEPRINT_SEALED ? "templates.drop.unknown" : "templates.drop.unknownWithBlueprint"));
  } catch (failure) {
    controller.reportFailure(failure);
  }
}
