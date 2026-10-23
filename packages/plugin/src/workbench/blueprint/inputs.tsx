/**
 * The receiver-local inputs of a blueprint.
 *
 * An input control carries a value the receiver supplies, so the section is
 * decorative chrome around real fields. The model picker inside it reports a
 * read failure, so the failure text is never part of an entrance animation.
 */
import React, { type ReactElement } from "react";
import type { BlueprintInput } from "../../../../../src/shared/blueprint";
import type { BlueprintRecipe } from "@klarkxy/dsh-blueprint/document";
import { t, type WorkbenchLocale } from "../i18n";
import type { BlueprintUiState } from "../blueprint-session";
import { springSoft, StaggerItem, StaggerList } from "../../../../../src/shared/ui";
import { VisibleSlide } from "../feature-motion";

/** The local input fields of an inspected blueprint. */
export function LocalInputs({
  locale,
  blueprint,
  ui,
  onString,
  onBoolean,
  onModel,
  onUnset,
}: {
  locale: WorkbenchLocale;
  blueprint: BlueprintRecipe;
  ui: BlueprintUiState;
  onString: (id: string, text: string) => void;
  onBoolean: (id: string, value: boolean) => void;
  onModel: (id: string, connectionId: string, modelId: string) => void;
  onUnset: (id: string) => void;
}): ReactElement | null {
  if (blueprint.inputs.length === 0) return null;
  return (
    <VisibleSlide as="section" className="dsh-wb-blueprint-inputs" from={10}>
      <h3 className="dsh-wb-title">{t(locale, "blueprints.inputs")}</h3>
      <StaggerList as="div" className="dsh-wb-blueprint-input-list" step={0}>
        {blueprint.inputs.map((input, index) => (
          <StaggerItem
            key={input.id}
            as="div"
            transition={{ ...springSoft, delay: index * 0.05 }}
          >
            <InputControl
              locale={locale}
              input={input}
              ui={ui}
              onString={onString}
              onBoolean={onBoolean}
              onModel={onModel}
              onUnset={onUnset}
            />
          </StaggerItem>
        ))}
      </StaggerList>
    </VisibleSlide>
  );
}

/** One local input control. */
function InputControl({
  locale,
  input,
  ui,
  onString,
  onBoolean,
  onModel,
  onUnset,
}: {
  locale: WorkbenchLocale;
  input: BlueprintInput;
  ui: BlueprintUiState;
  onString: (id: string, text: string) => void;
  onBoolean: (id: string, value: boolean) => void;
  onModel: (id: string, connectionId: string, modelId: string) => void;
  onUnset: (id: string) => void;
}): ReactElement {
  const draft = ui.inputDrafts[input.id];
  const present = Boolean(draft?.present);
  return (
    <div className="dsh-wb-field" data-blueprint-input={input.id} data-input-type={input.type}>
      <span>
        {input.label}
        {input.required ? " *" : ""}
        {input.description ? ` — ${input.description}` : ""}
      </span>
      {input.required ? null : (
        <label className="dsh-wb-check">
          <input
            type="checkbox"
            checked={!present}
            onChange={(event) => {
              if (event.target.checked) {
                onUnset(input.id);
                return;
              }
              if (input.type === "boolean") onBoolean(input.id, false);
              else onString(input.id, draft?.text ?? "");
            }}
          />
          {t(locale, "blueprints.unset")}
        </label>
      )}
      {input.type === "boolean" ? (
        <select
          value={present ? (draft?.booleanValue ? "true" : "false") : ""}
          aria-label={input.label}
          onChange={(event) => {
            if (event.target.value === "") onUnset(input.id);
            else onBoolean(input.id, event.target.value === "true");
          }}
        >
          <option value="">{t(locale, "blueprints.origin.missing")}</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : null}
      {input.type === "model" ? (
        <ModelSelect locale={locale} input={input} ui={ui} onModel={onModel} onUnset={onUnset} />
      ) : null}
      {input.type === "directory" || input.type === "string" || input.type === "number" ? (
        <>
          <input
            value={present ? draft?.text ?? "" : ""}
            inputMode={input.type === "number" ? "decimal" : undefined}
            aria-label={input.label}
            onChange={(event) => onString(input.id, event.target.value)}
          />
          {input.type === "directory" ? <p className="dsh-wb-muted">{t(locale, "blueprints.directoryHint")}</p> : null}
        </>
      ) : null}
    </div>
  );
}

/** The model picker of a local input. */
function ModelSelect({
  locale,
  input,
  ui,
  onModel,
  onUnset,
}: {
  locale: WorkbenchLocale;
  input: BlueprintInput;
  ui: BlueprintUiState;
  onModel: (id: string, connectionId: string, modelId: string) => void;
  onUnset: (id: string) => void;
}): ReactElement {
  const draft = ui.inputDrafts[input.id];
  const current = draft?.present && draft.model ? `${draft.model.connectionId}::${draft.model.modelId}` : "";
  return (
    <>
      <select
        value={current}
        aria-label={input.label}
        onChange={(event) => {
          if (!event.target.value) {
            onUnset(input.id);
            return;
          }
          const sep = event.target.value.indexOf("::");
          onModel(input.id, event.target.value.slice(0, sep), event.target.value.slice(sep + 2));
        }}
      >
        <option value="">{t(locale, "blueprints.origin.missing")}</option>
        {ui.models.map((model) => (
          <option key={`${model.connectionId}:${model.modelId}`} value={`${model.connectionId}::${model.modelId}`}>
            {model.connectionName} / {model.modelId}
          </option>
        ))}
      </select>
      {ui.modelsStatus === "ready" && ui.models.length === 0 ? (
        <p className="dsh-wb-muted">{t(locale, "blueprints.modelsUnavailable")}</p>
      ) : null}
      {ui.modelsError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.modelsError}
        </p>
      ) : null}
    </>
  );
}
