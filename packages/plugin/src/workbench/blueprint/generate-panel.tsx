/**
 * The "create a blueprint" panel.
 *
 * The panel reads a source space, lists what may be shared, collects the
 * convert bindings and writes the blueprint. The eligibility notes next to a
 * package are facts about the source, not failures of this panel, so they
 * travel with the rows they belong to.
 */
import React, { type ReactElement } from "react";
import { t, type WorkbenchLocale } from "../i18n";
import type { BlueprintUiState } from "../blueprint-session";
import type { WorkbenchController } from "../store";
import type { WorkbenchSpace } from "../../../../../src/shared/workbench";
import { springSoft, StaggerItem, StaggerList } from "../../../../../src/shared/ui/motion";
import { CollapseSection, PressableButton, VisibleSlide } from "../feature-motion";
import { BindingEditor } from "./bindings";
import { DiagnosticList } from "./shared";

/** The panel that writes a blueprint from a source space. */
export function GenerateBlueprintPanel({
  ui,
  controller,
  locale,
  spaces,
  showSource = true,
}: {
  ui: BlueprintUiState;
  controller: WorkbenchController;
  locale: WorkbenchLocale;
  spaces: WorkbenchSpace[];
  /** Whether the panel picks the source space itself. The unified page picks it once for every export. */
  showSource?: boolean;
}): ReactElement {
  const session = controller.blueprint;
  const source = ui.source;
  const localNotes = source
    ? source.localObservations.filter((item) => item.kind !== "managed")
    : [];
  return (
    <VisibleSlide as="div" className="dsh-wb-form wide" from={12}>
      {showSource ? (
        <label className="dsh-wb-field">
          {t(locale, "blueprints.source")}
          <select
            value={ui.sourceSpaceId}
            aria-label={t(locale, "blueprints.source")}
            onChange={(event) => session.setSourceSpaceId(event.target.value)}
          >
            <option value="">{t(locale, "blueprints.needSource")}</option>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {ui.sourceStatus === "loading" ? (
        <p role="status" className="dsh-wb-status-line">
          <span className="dsh-wb-spin" aria-hidden="true" />
          {t(locale, "app.loading")}
        </p>
      ) : null}
      {ui.sourceError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.sourceError}
        </p>
      ) : null}
      {source ? (
        <>
          <label className="dsh-wb-field">
            {t(locale, "blueprints.exportContents")}
            <select value={ui.formatVersion} aria-label={t(locale, "blueprints.exportContents")} onChange={(event) => session.setFormatVersion(event.target.value === "1" ? 1 : 2)}>
              <option value="2">{t(locale, "blueprints.pluginCombination")}</option>
              <option value="1">{t(locale, "blueprints.withPresets")}</option>
            </select>
          </label>
          <p className="dsh-wb-muted">{t(locale, ui.formatVersion === 2 ? "blueprints.combinationHint" : "blueprints.presetsHint")}</p>
          <p className="dsh-wb-muted">{t(locale, "blueprints.selectionNote")}</p>
          {ui.formatVersion === 1 ? <p className="dsh-wb-muted">{t(locale, "blueprints.provenance")}</p> : null}
          <h3 className="dsh-wb-title">{t(locale, "blueprints.packages")}</h3>
          <StaggerList as="div" className="dsh-wb-blueprint-package-list" step={0}>
            {source.packages.map((item, index) => {
              const builtinInV1 = ui.formatVersion === 1 && item.source === "builtin";
              const disabled = !item.eligibility.available || builtinInV1;
              return (
                <StaggerItem
                  key={item.name}
                  as="div"
                  transition={{ ...springSoft, delay: index * 0.04 }}
                >
                  <label className="dsh-wb-check dsh-wb-blueprint-package">
                    <input
                      type="checkbox"
                      checked={ui.selectedPackages.includes(item.name)}
                      disabled={disabled}
                      onChange={(event) => session.setPackageSelected(item.name, event.target.checked)}
                    />
                    <span>
                      {item.name} {item.version ?? t(locale, "app.status.unknown")} · {item.source}
                      {item.inBundles ? ` · ${t(locale, "blueprints.bundled")}` : ""}
                      {item.lifecycleScripts.length > 0
                        ? ` · ${t(locale, "blueprints.lifecycle")}: ${item.lifecycleScripts.join(", ")}`
                        : ""}
                      {disabled ? ` · ${builtinInV1 ? t(locale, "blueprints.builtinV2Only") : item.eligibility.reason ?? t(locale, "blueprints.eligibleNo")}` : ""}
                    </span>
                  </label>
                </StaggerItem>
              );
            })}
          </StaggerList>
          <h3 className="dsh-wb-title">{t(locale, "blueprints.bundles")}</h3>
          <ol className="dsh-wb-blueprint-bundles">
            {source.bundles.map((bundle) => (
              <li key={`${bundle.order}:${bundle.name}`}>
                {bundle.order + 1}. {bundle.name}
                {bundle.eligible ? "" : ` · ${bundle.reason ?? t(locale, "blueprints.eligibleNo")}`}
              </li>
            ))}
          </ol>
          {ui.formatVersion === 1 ? <>
          <h3 className="dsh-wb-title">{t(locale, "blueprints.patch")}</h3>
          <label className="dsh-wb-check dsh-wb-blueprint-package">
            <input
              type="checkbox"
              checked={ui.includePatch}
              disabled={!source.patch.exists}
              onChange={(event) => session.setIncludePatch(event.target.checked)}
            />
            <span>
              {t(locale, "blueprints.presets")}
              {source.patch.shareable ? "" : ` · ${source.patch.reason ?? t(locale, "blueprints.eligibleNo")}`}
            </span>
          </label>
          <h3 className="dsh-wb-title">{t(locale, "blueprints.settings")}</h3>
          {source.settingsNamespaces.map((item) => {
            const disabled = !item.eligible || (!item.shareable && !item.convertible);
            return (
              <label key={item.namespace} className="dsh-wb-check dsh-wb-blueprint-package">
                <input
                  type="checkbox"
                  checked={ui.selectedNamespaces.includes(item.namespace)}
                  disabled={disabled}
                  onChange={(event) => session.setNamespaceSelected(item.namespace, event.target.checked)}
                />
                <span>
                  {item.namespace}
                  {item.shareable ? "" : ` · ${item.reason ?? t(locale, "blueprints.eligibleNo")}`}
                  {item.convertible && !item.shareable ? ` · ${t(locale, "blueprints.convert")}` : ""}
                </span>
              </label>
            );
          })}
          <CollapseSection open={localNotes.length > 0} className="dsh-wb-blueprint-notes">
            {localNotes.length > 0 ? (
              <>
                <h3 className="dsh-wb-title">{t(locale, "blueprints.local")}</h3>
                {localNotes.map((item, index) => (
                  <p key={`${item.pointer}:${index}`} className="dsh-wb-muted">
                    <code>{item.pointer}</code> · {item.kind} · {item.reason}
                  </p>
                ))}
              </>
            ) : null}
          </CollapseSection>
          <StaggerList as="div" className="dsh-wb-blueprint-binding-list" step={0}>
            {ui.bindings.map((row, index) => (
              <StaggerItem
                key={`detected:${row.pointer}:${index}`}
                as="div"
                transition={{ ...springSoft, delay: index * 0.05 }}
              >
                <BindingEditor
                  locale={locale}
                  row={row}
                  onChange={(patch) => session.setBinding(index, patch)}
                />
              </StaggerItem>
            ))}
          </StaggerList>
          <details className="dsh-wb-form">
            <summary>{t(locale, "blueprints.advancedPointer")}</summary>
            <BindingEditor locale={locale} row={ui.advanced} onChange={session.setAdvanced} advanced />
          </details>
          </> : null}
          <label className="dsh-wb-field">
            {t(locale, "create.name")}
            <input value={ui.metaName} onChange={(event) => session.setMetaName(event.target.value)} />
          </label>
          {ui.formatVersion === 1 ? <label className="dsh-wb-field">
            {t(locale, "blueprints.version")}
            <input value={ui.metaVersion} onChange={(event) => session.setMetaVersion(event.target.value)} />
          </label> : null}
          <label className="dsh-wb-field">
            {t(locale, "blueprints.description")}
            <textarea rows={3} value={ui.metaDescription} onChange={(event) => session.setMetaDescription(event.target.value)} />
          </label>
          <div className="dsh-wb-actions">
            <PressableButton
              
              type="button"
              className="dsh-wb-btn primary"
              disabled={ui.generateStatus === "loading"}
              onClick={() => session.generate()}
            >
              {t(locale, "blueprints.generate")}
            </PressableButton>
          </div>
        </>
      ) : null}
      {ui.generateError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.generateError}
        </p>
      ) : null}
      {ui.generate && !ui.generateInvalid ? (
        <GeneratedOutput locale={locale} ui={ui} session={session} />
      ) : null}
    </VisibleSlide>
  );
}

/** The written blueprint: its diagnostics, its JSON and its share code. */
function GeneratedOutput({
  locale,
  ui,
  session,
}: {
  locale: WorkbenchLocale;
  ui: BlueprintUiState;
  session: WorkbenchController["blueprint"];
}): ReactElement | null {
  const generate = ui.generate;
  if (!generate) return null;
  return (
    <VisibleSlide as="section" data-blueprint-output="true" className="dsh-wb-blueprint-output" from={12}>
      <h3 className="dsh-wb-title">{t(locale, "blueprints.output")}</h3>
      <DiagnosticList locale={locale} diagnostics={generate.diagnostics} />
      <pre className="dsh-wb-pre">{generate.json}</pre>
      <p className="dsh-wb-muted" data-blueprint-share-code="true" style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap", minWidth: 0 }}>
        {generate.shareCode}
      </p>
      <div className="dsh-wb-actions">
        <PressableButton type="button" className="dsh-wb-btn" onClick={() => session.copyShareCode()}>
          {t(locale, "blueprints.copyShare")}
        </PressableButton>
        <PressableButton type="button" className="dsh-wb-btn" onClick={() => session.saveJson()}>
          {t(locale, "blueprints.saveJson")}
        </PressableButton>
      </div>
      {ui.copied ? <p className="dsh-wb-notice">{t(locale, "blueprints.copied")}</p> : null}
      {ui.copyError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.copyError}
        </p>
      ) : null}
      {ui.downloadError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.downloadError}
        </p>
      ) : null}
    </VisibleSlide>
  );
}
