/**
 * The inspected blueprint: the catalog of a blueprint that was read.
 *
 * The metadata block is the catalogue of the blueprint, the package list is
 * the card grid and the diagnostics stay readable without an entrance
 * animation.
 */
import React, { type ReactElement } from "react";
import type { BlueprintRecipe } from "@klarkxy/dsh-blueprint/document";
import type { BlueprintDiagnostic } from "@klarkxy/dsh-blueprint/v1/types";
import { t, type WorkbenchLocale } from "../i18n";
import { blueprintHasGithub } from "../blueprint-session";
import { springSoft, StaggerItem, StaggerList } from "../../../../../src/shared/ui/motion";
import { VisibleSlide } from "../feature-motion";
import { DiagnosticList, SafeLink } from "./shared";

/** The catalogue of a blueprint that was read. */
export function InspectedBlueprint({
  locale,
  blueprint,
  diagnostics,
}: {
  locale: WorkbenchLocale;
  blueprint: BlueprintRecipe;
  diagnostics: BlueprintDiagnostic[];
}): ReactElement {
  const bundled = new Set(blueprint.profile.bundles);
  return (
    <VisibleSlide
      as="section"
      data-blueprint-inspect="true"
      className="dsh-wb-blueprint-inspect"
      from={10}
    >
      <h3 className="dsh-wb-title">{t(locale, "blueprints.metadata")}</h3>
      <dl className="dsh-wb-dl">
        <dt>{t(locale, "create.name")}</dt>
        <dd>{blueprint.metadata.name}</dd>
        <dt>{t(locale, "blueprints.exportContents")}</dt>
        <dd>{t(locale, blueprint.formatVersion === 2 ? "blueprints.pluginCombination" : "blueprints.withPresets")}</dd>
        {blueprint.metadata.version ? <>
          <dt>{t(locale, "blueprints.version")}</dt>
          <dd>{blueprint.metadata.version}</dd>
        </> : null}
        {blueprint.metadata.description ? (
          <>
            <dt>{t(locale, "blueprints.description")}</dt>
            <dd>{blueprint.metadata.description}</dd>
          </>
        ) : null}
        {blueprint.metadata.author ? (
          <>
            <dt>{t(locale, "blueprints.author")}</dt>
            <dd>{blueprint.metadata.author}</dd>
          </>
        ) : null}
        {blueprint.metadata.license ? (
          <>
            <dt>{t(locale, "blueprints.license")}</dt>
            <dd>{blueprint.metadata.license}</dd>
          </>
        ) : null}
        {blueprint.metadata.homepage ? (
          <>
            <dt>{t(locale, "blueprints.homepage")}</dt>
            <dd>
              <SafeLink href={blueprint.metadata.homepage} />
            </dd>
          </>
        ) : null}
      </dl>
      <p className="dsh-wb-muted">{t(locale, "blueprints.selectionNote")}</p>
      <h3 className="dsh-wb-title">{t(locale, "blueprints.packages")}</h3>
      <PackageList locale={locale} packages={blueprint.packages} bundled={bundled} />
      <h3 className="dsh-wb-title">{t(locale, "blueprints.bundles")}</h3>
      {blueprint.profile.bundles.length === 0 ? (
        <p className="dsh-wb-muted">{t(locale, "plan.none")}</p>
      ) : (
        <ol className="dsh-wb-blueprint-bundles">
          {blueprint.profile.bundles.map((name, index) => (
            <li key={`${index}:${name}`}>
              {name} · {t(locale, "blueprints.bundled")}
            </li>
          ))}
        </ol>
      )}
      {blueprint.formatVersion === 1 ? <details>
        <summary>
          {t(locale, "blueprints.presets")} ({blueprint.profile.patch.length}) / {t(locale, "blueprints.settings")} (
          {Object.keys(blueprint.profile.settings).length})
        </summary>
        <pre className="dsh-wb-pre">{JSON.stringify({ patch: blueprint.profile.patch, settings: blueprint.profile.settings }, null, 2)}</pre>
      </details> : null}
      {blueprint.requirements ? (
        <>
          <h3 className="dsh-wb-title">{t(locale, "blueprints.requirements")}</h3>
          <p>
            dsh {blueprint.requirements.dsh ?? "—"} · spaces {blueprint.requirements.spaces ?? "—"} · node{" "}
            {blueprint.requirements.node ?? "—"} · os {(blueprint.requirements.os ?? []).join(", ") || "—"} · arch{" "}
            {(blueprint.requirements.arch ?? []).join(", ") || "—"}
          </p>
        </>
      ) : null}
      {blueprint.testedWith && blueprint.testedWith.length > 0 ? (
        <>
          <h3 className="dsh-wb-title">{t(locale, "blueprints.testedWith")}</h3>
          {blueprint.testedWith.map((row, index) => (
            <p key={`${row.checkedAt}:${index}`}>
              {row.os}/{row.arch} · dsh {row.dsh} · spaces {row.spaces} · node {row.node} · {row.checks.join(", ")}
              {row.evidence ? (
                <>
                  {" "}
                  · <SafeLink href={row.evidence} />
                </>
              ) : null}
            </p>
          ))}
          <p className="dsh-wb-muted">{t(locale, "blueprints.evidenceLimit")}</p>
        </>
      ) : null}
      {blueprint.relations.length > 0 ? (
        <>
          <h3 className="dsh-wb-title">{t(locale, "blueprints.relations")}</h3>
          <ul>
            {blueprint.relations.map((row, index) => (
              <li key={`${row.type}:${row.from}:${row.to}:${index}`}>
                {row.type}: {row.from}
                {row.fromVersion ? `@${row.fromVersion}` : ""} → {row.to}
                {row.toVersion ? `@${row.toVersion}` : ""} — {row.reason}
              </li>
            ))}
          </ul>
          <p className="dsh-wb-muted">{t(locale, "blueprints.evidenceLimit")}</p>
        </>
      ) : null}
      <DiagnosticList locale={locale} diagnostics={diagnostics} />
      {blueprintHasGithub(blueprint) ? (
        <p className="dsh-wb-notice" role="status">
          {t(locale, "blueprints.githubUnsupported")}
        </p>
      ) : null}
    </VisibleSlide>
  );
}

/** The package cards of an inspected blueprint. */
function PackageList({
  locale,
  packages,
  bundled,
}: {
  locale: WorkbenchLocale;
  packages: BlueprintRecipe["packages"];
  bundled: Set<string>;
}): ReactElement {
  if (packages.length === 0) return <p className="dsh-wb-muted">{t(locale, "plan.none")}</p>;
  return (
    <StaggerList as="ul" className="dsh-wb-blueprint-cards" step={0}>
      {packages.map((item, index) => (
        <StaggerItem
          key={item.name}
          as="li"
          className="dsh-wb-blueprint-card-row"
          transition={{ ...springSoft, delay: index * 0.05 }}
        >
          <div className="dsh-wb-blueprint-card">
            {item.name} {item.version} · {item.source.type}
            {item.source.type === "github" ? ` ${item.source.repository}@${item.source.commit}` : ""}
            {item.integrity || item.source.type === "builtin" ? "" : ` · ${t(locale, "blueprints.integrityMissing")}`} · {t(locale, "blueprints.selected")}
            {bundled.has(item.name) ? ` · ${t(locale, "blueprints.bundled")}` : ""}
          </div>
        </StaggerItem>
      ))}
    </StaggerList>
  );
}
