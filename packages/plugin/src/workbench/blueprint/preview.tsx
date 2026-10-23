/**
 * The preview of a staged blueprint.
 *
 * The preview is the plan that the apply step would run. An expired preview
 * is a real failure and stays readable from the first frame, so the section
 * moves without ever lowering its opacity.
 */
import React, { type ReactElement } from "react";
import type { BlueprintPreviewInput } from "../../../../../src/shared/workbench-blueprint";
import { t, type WorkbenchLocale } from "../i18n";
import type { BlueprintUiState } from "../blueprint-session";
import { previewIsExpired, previewPlanMatchesApply } from "../blueprint-session";
import { springSoft, StaggerItem, StaggerList } from "../../../../../src/shared/ui";
import { VisibleSlide } from "../feature-motion";
import { DiagnosticList } from "./shared";

/** The staged plan of a blueprint. */
export function PreviewBody({
  locale,
  ui,
  now,
}: {
  locale: WorkbenchLocale;
  ui: BlueprintUiState;
  now: number;
}): ReactElement {
  const preview = ui.preview;
  if (!preview) return <></>;
  const expired = !previewPlanMatchesApply(ui) && (ui.previewInvalid || previewIsExpired(preview.expiresAt, now));
  return (
    <VisibleSlide as="section" data-blueprint-preview="true" className="dsh-wb-blueprint-preview" from={10}>
      {expired ? (
        <p className="dsh-wb-alert" role="alert">
          {t(locale, "blueprints.previewExpired")}
        </p>
      ) : null}
      {preview.packages.some((item) => item.source === "github") ? (
        <p className="dsh-wb-notice">{t(locale, "blueprints.githubUnsupported")}</p>
      ) : null}
      <h3 className="dsh-wb-title">{t(locale, "blueprints.host")}</h3>
      <HostVersions locale={locale} host={preview.host} />
      <h3 className="dsh-wb-title">{t(locale, "blueprints.packages")}</h3>
      <StaggerList as="ul" className="dsh-wb-blueprint-cards" step={0}>
        {preview.packages.map((item, index) => (
          <StaggerItem
            key={`${item.name}:${item.order ?? "x"}`}
            as="li"
            className="dsh-wb-blueprint-card-row"
            transition={{ ...springSoft, delay: index * 0.05 }}
          >
            <div className="dsh-wb-blueprint-card">
              {item.name} {item.version} · {item.source} · {t(locale, "blueprints.selected")}
              {item.bundled
                ? ` · ${t(locale, "blueprints.bundled")}${item.order !== undefined ? ` #${item.order}` : ""}`
                : ""}
            </div>
          </StaggerItem>
        ))}
      </StaggerList>
      <h3 className="dsh-wb-title">{t(locale, "blueprints.inputs")}</h3>
      <StaggerList as="ul" className="dsh-wb-blueprint-input-list" step={0}>
        {preview.inputs.map((item, index) => (
          <StaggerItem
            key={item.id}
            as="li"
            data-origin={item.origin}
            transition={{ ...springSoft, delay: index * 0.04 }}
          >
            {item.id} · {t(locale, originKey(item.origin))}
            {item.origin === "missing" ? "" : ` · ${formatPreviewValue(item.value)}`}
          </StaggerItem>
        ))}
      </StaggerList>
      {preview.expiresAt ? (
        <p>
          {t(locale, "blueprints.expires")}: {preview.expiresAt}
        </p>
      ) : null}
      {preview.missingInputs.length > 0 ? (
        <p className="dsh-wb-notice">
          {t(locale, "blueprints.missingInputs")}: {preview.missingInputs.join(", ")}
        </p>
      ) : null}
      <DiagnosticList locale={locale} diagnostics={preview.diagnostics} />
    </VisibleSlide>
  );
}

/** The host versions a preview was planned against. */
function HostVersions({
  locale,
  host,
}: {
  locale: WorkbenchLocale;
  host: {
    dsh: string | null;
    spaces: string | null;
    node?: string;
    os?: string;
    arch?: string;
    base: string | null;
    webApp: string | null;
  };
}): ReactElement {
  return (
    <p>
      {t(locale, "home.dshVersion")} {host.dsh ?? "—"} · spaces {host.spaces ?? "—"}
      {host.node ? ` · node ${host.node}` : ""}
      {host.os ? ` · ${host.os}/${host.arch ?? "—"}` : ""} · base {host.base ?? "—"} · web {host.webApp ?? "—"}
    </p>
  );
}

function originKey(origin: "explicit" | "default" | "missing"): "blueprints.origin.explicit" | "blueprints.origin.default" | "blueprints.origin.missing" {
  if (origin === "explicit") return "blueprints.origin.explicit";
  if (origin === "default") return "blueprints.origin.default";
  return "blueprints.origin.missing";
}

function formatPreviewValue(value: BlueprintPreviewInput["value"]): string {
  if (value === undefined) return "—";
  if (typeof value === "object") return `${value.connectionId}/${value.modelId}`;
  return JSON.stringify(value);
}
