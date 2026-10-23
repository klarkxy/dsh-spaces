/**
 * The result of an applied blueprint.
 *
 * The result reports four stages and can carry a real failure: a package that
 * did not install, a write that was refused. The block therefore never lowers
 * its opacity and never waits for an entrance animation to finish.
 */
import React, { Fragment, type ReactElement } from "react";
import type { WorkbenchBlueprintApplyOutcome } from "../../../../../src/shared/workbench-blueprint";
import type { WorkbenchJob } from "../../../../../src/shared/workbench";
import { t, type WorkbenchLocale } from "../i18n";
import { isBlueprintApplyOutcome } from "../blueprint-session";
import { VisibleSlide } from "../feature-motion";

/** The stage report of an applied blueprint. */
export function BlueprintApplyResult({
  locale,
  outcome,
}: {
  locale: WorkbenchLocale;
  outcome: WorkbenchBlueprintApplyOutcome;
}): ReactElement {
  const stages: Array<{ key: "space-create" | "packages" | "presets" | "start"; label: "blueprints.stage.spaceCreate" | "blueprints.stage.packages" | "blueprints.stage.presets" | "blueprints.stage.start" }> = [
    { key: "space-create", label: "blueprints.stage.spaceCreate" },
    { key: "packages", label: "blueprints.stage.packages" },
    { key: "presets", label: "blueprints.stage.presets" },
    { key: "start", label: "blueprints.stage.start" },
  ];
  return (
    <VisibleSlide
      as="dl"
      className="dsh-wb-dl dsh-wb-blueprint-apply"
      data-blueprint-apply="true"
      from={12}
    >
      {stages.map((stage) => {
        const row = outcome.stages[stage.key];
        return (
          <Fragment key={stage.key}>
            <dt>{t(locale, stage.label)}</dt>
            <dd data-blueprint-stage={stage.key} data-status={row.status}>
              <span className="dsh-wb-blueprint-dot" data-status={row.status} aria-hidden="true" />
              <span className="dsh-wb-blueprint-stage-text">
                {stageStatus(locale, row.status)}
                {"error" in row && row.error ? ` — ${row.error}` : ""}
                {stage.key === "presets" && outcome.writes.length > 0
                  ? ` · ${outcome.writes
                      .map((item) => `${item.kind}${item.namespace ? `:${item.namespace}` : ""} ${stageStatus(locale, item.status)}${item.error ? ` — ${item.error}` : ""}`)
                      .join("; ")}`
                  : ""}
              </span>
            </dd>
          </Fragment>
        );
      })}
      {outcome.spaceId ? (
        <>
          <dt>{t(locale, "detail.id")}</dt>
          <dd>{outcome.spaceId}</dd>
        </>
      ) : null}
      <dt>{t(locale, "blueprints.packages")}</dt>
      <dd>
        {outcome.packageResults.length > 0
          ? outcome.packageResults
              .map((item) => `${item.name}@${item.version} ${stageStatus(locale, item.status)}${item.error ? ` — ${item.error}` : ""}`)
              .join("; ")
          : outcome.installed.length === 0
            ? t(locale, "plan.none")
            : outcome.installed.map((item) => `${item.name}@${item.version}`).join(", ")}
      </dd>
      <dt>{t(locale, "blueprints.host")}</dt>
      <dd>
        dsh {outcome.host.dsh ?? "—"} · spaces {outcome.host.spaces ?? "—"} · base {outcome.host.base ?? "—"} · web{" "}
        {outcome.host.webApp ?? "—"}
      </dd>
      {outcome.source ? (
        <>
          <dt>{t(locale, "blueprints.metadata")}</dt>
          <dd>
            {outcome.source.name}{outcome.source.version ? ` ${outcome.source.version}` : ""}
          </dd>
        </>
      ) : null}
    </VisibleSlide>
  );
}

function stageStatus(locale: WorkbenchLocale, status: "succeeded" | "failed" | "not-run"): string {
  if (status === "succeeded") return t(locale, "blueprints.status.succeeded");
  if (status === "failed") return t(locale, "blueprints.status.failed");
  return t(locale, "blueprints.status.notRun");
}

/** The blueprint result of a job, when the job produced one. */
export function BlueprintJobResult({
  locale,
  job,
}: {
  locale: WorkbenchLocale;
  job: WorkbenchJob;
}): ReactElement | null {
  const product = job.result?.product;
  if (!isBlueprintApplyOutcome(product)) return null;
  return <BlueprintApplyResult locale={locale} outcome={product} />;
}
