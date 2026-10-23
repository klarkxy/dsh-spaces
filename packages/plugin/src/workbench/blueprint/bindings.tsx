/**
 * The convert bindings of a blueprint.
 *
 * A binding maps a detected pointer of the source space onto a blueprint
 * input. The editor is a plain fieldset: the values are drafts and the
 * reasons next to them are eligibility notes, not failures.
 */
import React, { type ReactElement } from "react";
import type { BlueprintInputType } from "../../../../../src/shared/blueprint";
import { t, type WorkbenchLocale } from "../i18n";
import type { BlueprintBindingDraft } from "../blueprint-session";

function parseBindingType(value: string): BlueprintInputType | null {
  if (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "directory" ||
    value === "model"
  ) {
    return value;
  }
  return null;
}

/** The editor of one convert binding. */
export function BindingEditor({
  locale,
  row,
  onChange,
  advanced,
}: {
  locale: WorkbenchLocale;
  row: BlueprintBindingDraft;
  onChange: (patch: Partial<BlueprintBindingDraft>) => void;
  advanced?: boolean;
}): ReactElement {
  const types: BlueprintBindingDraft["type"][] = ["string", "number", "boolean", "directory", "model"];
  return (
    <fieldset className="dsh-wb-form dsh-wb-blueprint-binding">
      <label className="dsh-wb-check">
        <input
          type="checkbox"
          checked={row.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
        />
        {t(locale, "blueprints.convert")}
      </label>
      <label className="dsh-wb-field">
        {t(locale, "blueprints.advancedPointer")}
        <input
          value={row.pointer}
          readOnly={!advanced}
          onChange={(event) => onChange({ pointer: event.target.value, enabled: true })}
        />
      </label>
      <label className="dsh-wb-field">
        {t(locale, "blueprints.inputId")}
        <input value={row.id} onChange={(event) => onChange({ id: event.target.value, enabled: true })} />
      </label>
      <label className="dsh-wb-field">
        {t(locale, "blueprints.inputLabel")}
        <input value={row.label} onChange={(event) => onChange({ label: event.target.value, enabled: true })} />
      </label>
      <label className="dsh-wb-field">
        {t(locale, "blueprints.inputType")}
        <select
          value={row.type}
          onChange={(event) => {
            const type = parseBindingType(event.target.value);
            if (type) onChange({ type });
          }}
        >
          {types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <label className="dsh-wb-check">
        <input
          type="checkbox"
          checked={row.required}
          onChange={(event) => onChange({ required: event.target.checked })}
        />
        {t(locale, "blueprints.inputRequired")}
      </label>
      {row.type === "directory" || row.type === "model" ? null : (
        <label className="dsh-wb-field">
          {t(locale, "blueprints.inputDefault")}
          <input value={row.defaultText} onChange={(event) => onChange({ defaultText: event.target.value })} />
        </label>
      )}
    </fieldset>
  );
}
