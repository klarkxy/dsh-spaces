/**
 * Shared blueprint view pieces.
 *
 * The diagnostic list and the safe link are used by more than one blueprint
 * panel, so they live here instead of being copied into every panel.
 */
import React, { type ReactElement } from "react";
import type { BlueprintDiagnostic } from "../../../../../src/shared/blueprint";
import { t, type WorkbenchLocale } from "../i18n";
import { isHttpsHref } from "../blueprint-session";

/**
 * Validation diagnostics of a blueprint.
 *
 * The list is never wrapped in an entrance animation: a diagnostic is a real
 * finding and has to be readable as soon as it exists.
 */
export function DiagnosticList({
  locale,
  diagnostics,
}: {
  locale: WorkbenchLocale;
  diagnostics: BlueprintDiagnostic[];
}): ReactElement | null {
  if (diagnostics.length === 0) return null;
  return (
    <>
      <h3 className="dsh-wb-title">{t(locale, "blueprints.diagnostics")}</h3>
      <ul className="dsh-wb-blueprint-diagnostics">
        {diagnostics.map((item, index) => (
          <li
            key={`${item.code}:${item.path ?? ""}:${index}`}
            className="dsh-wb-blueprint-diagnostic"
            data-severity={item.severity}
          >
            <span className="dsh-wb-blueprint-dot" data-severity={item.severity} aria-hidden="true" />
            {item.severity} · {item.code}
            {item.path ? ` · ${item.path}` : ""} — {item.message}
          </li>
        ))}
      </ul>
    </>
  );
}

/** A link that is only rendered as a link when it is an https address. */
export function SafeLink({ href }: { href: string }): ReactElement {
  const safe = isHttpsHref(href);
  if (!safe) return <span>{href}</span>;
  return (
    <a href={safe} rel="noopener noreferrer" target="_blank">
      {safe}
    </a>
  );
}
