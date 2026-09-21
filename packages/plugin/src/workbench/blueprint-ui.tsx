import React, { Fragment, type ChangeEvent, type ReactElement } from "react";
import type {
  Blueprint,
  BlueprintDiagnostic,
  BlueprintInput,
  BlueprintInputType,
  BlueprintPackage,
} from "../../../../src/shared/blueprint";
import type {
  BlueprintPreviewInput,
  WorkbenchBlueprintApplyOutcome,
} from "../../../../src/shared/workbench-blueprint";
import type { WorkbenchJob, WorkbenchSpace } from "../../../../src/shared/workbench";
import { t, type WorkbenchLocale } from "./i18n";
import type { BlueprintBindingDraft, BlueprintUiState } from "./blueprint-session";
import {
  blueprintHasGithub,
  isBlueprintApplyOutcome,
  isHttpsHref,
  previewIsExpired,
  previewPlanMatchesApply,
} from "./blueprint-session";
import type { WorkbenchController } from "./store";

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
      <h2 className="dsh-wb-title">{t(locale, "home.blueprints")}</h2>
      <div className="dsh-wb-tabs" role="tablist" aria-label={t(locale, "home.blueprints")}>
        <button
          type="button"
          className="dsh-wb-tab"
          role="tab"
          aria-selected={ui.mode === "use"}
          onClick={() => session.setMode("use")}
        >
          {t(locale, "blueprints.use")}
        </button>
        <button
          type="button"
          className="dsh-wb-tab"
          role="tab"
          aria-selected={ui.mode === "generate"}
          onClick={() => session.setMode("generate")}
        >
          {t(locale, "blueprints.generate")}
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

function UseBlueprintPanel({
  ui,
  controller,
  locale,
}: {
  ui: BlueprintUiState;
  controller: WorkbenchController;
  locale: WorkbenchLocale;
}): ReactElement {
  const session = controller.blueprint;
  const writable = controller.canMutate();
  const blueprint = ui.inspect?.blueprint ?? null;
  const applying = ui.applyStatus === "submitting" || ui.applyStatus === "running";
  const submittedCurrent = previewPlanMatchesApply(ui);
  const hideCreate = submittedCurrent && (ui.applyStatus === "succeeded" || ui.applyStatus === "failed");
  const showApplyChrome =
    applying ||
    submittedCurrent ||
    (!ui.preview &&
      (ui.applyStatus === "succeeded" || ui.applyStatus === "failed" || Boolean(ui.applyOutcome || ui.applyError)));
  return (
    <div className="dsh-wb-form wide">
      <label className="dsh-wb-field">
        {t(locale, "blueprints.paste")}
        <textarea
          rows={8}
          value={ui.content}
          aria-label={t(locale, "blueprints.paste")}
          spellCheck={false}
          onChange={(event) => session.setContent(event.target.value)}
        />
      </label>
      <label className="dsh-wb-field">
        {t(locale, "blueprints.openFile")}
        <input
          type="file"
          accept=".json,.txt,text/plain,application/json"
          aria-label={t(locale, "blueprints.openFile")}
          onChange={(event) => void onBlueprintFile(event, controller)}
        />
      </label>
      {ui.fileName ? <p className="dsh-wb-muted">{ui.fileName}</p> : null}
      {ui.contentError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.contentError}
        </p>
      ) : null}
      <div className="dsh-wb-actions">
        <button
          type="button"
          className="dsh-wb-btn primary"
          disabled={ui.inspectStatus === "loading"}
          onClick={() => session.inspect()}
        >
          {t(locale, "blueprints.inspect")}
        </button>
      </div>
      {ui.inspectStatus === "loading" ? <p role="status">{t(locale, "app.loading")}</p> : null}
      {ui.inspectError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.inspectError}
        </p>
      ) : null}
      {blueprint ? <InspectedBlueprint locale={locale} blueprint={blueprint} diagnostics={ui.inspect?.diagnostics ?? []} /> : null}
      {blueprint ? (
        <LocalInputs
          locale={locale}
          blueprint={blueprint}
          ui={ui}
          onString={session.setStringInput}
          onBoolean={session.setBooleanInput}
          onModel={session.setModelInput}
          onUnset={session.unsetInput}
        />
      ) : null}
      {blueprint ? (
        <>
          <label className="dsh-wb-field">
            {t(locale, "create.name")}
            <input
              value={ui.name}
              autoComplete="off"
              aria-label={t(locale, "create.name")}
              onChange={(event) => session.setName(event.target.value)}
            />
          </label>
          <label className="dsh-wb-field">
            {t(locale, "create.displayName")}
            <input
              value={ui.displayName}
              autoComplete="off"
              aria-label={t(locale, "create.displayName")}
              onChange={(event) => session.setDisplayName(event.target.value)}
            />
          </label>
          <div className="dsh-wb-actions">
            <button
              type="button"
              className="dsh-wb-btn"
              disabled={!writable || ui.previewStatus === "loading"}
              onClick={() => session.preview()}
            >
              {t(locale, "blueprints.preview")}
            </button>
            <button type="button" className="dsh-wb-btn" onClick={() => session.cancelStaged()}>
              {t(locale, "blueprints.cancelStaged")}
            </button>
          </div>
        </>
      ) : null}
      {ui.previewError && (!submittedCurrent || ui.previewStatus === "error") ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.previewError}
        </p>
      ) : null}
      {ui.previewStatus === "loading" ? <p role="status">{t(locale, "app.loading")}</p> : null}
      {ui.preview ? (
        <PreviewBody locale={locale} ui={ui} now={controller.now()} />
      ) : null}
      {ui.preview && !hideCreate ? (
        <>
          <p className="dsh-wb-notice">{t(locale, "blueprints.installHint")}</p>
          <div className="dsh-wb-actions">
            <button
              type="button"
              className="dsh-wb-btn primary"
              disabled={!writable || applying || !session.canApply()}
              onClick={() => session.apply()}
            >
              {t(locale, "blueprints.apply")}
            </button>
          </div>
        </>
      ) : null}
      {showApplyChrome && ui.applyError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.applyError}
        </p>
      ) : null}
      {showApplyChrome && ui.applyStatus === "succeeded" ? (
        <p className="dsh-wb-notice" role="status" data-blueprint-created="true">
          {t(locale, "blueprints.createdNotStarted")}
          {ui.applyOutcome?.spaceId ? ` · ${ui.applyOutcome.spaceId}` : ""}
        </p>
      ) : null}
      {showApplyChrome && ui.applyOutcome ? <BlueprintApplyResult locale={locale} outcome={ui.applyOutcome} /> : null}
    </div>
  );
}

function GenerateBlueprintPanel({
  ui,
  controller,
  locale,
  spaces,
}: {
  ui: BlueprintUiState;
  controller: WorkbenchController;
  locale: WorkbenchLocale;
  spaces: WorkbenchSpace[];
}): ReactElement {
  const session = controller.blueprint;
  const source = ui.source;
  const localNotes = source
    ? source.localObservations.filter((item) => item.kind !== "managed")
    : [];
  return (
    <div className="dsh-wb-form wide">
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
      {ui.sourceStatus === "loading" ? <p role="status">{t(locale, "app.loading")}</p> : null}
      {ui.sourceError ? (
        <p className="dsh-wb-alert" role="alert">
          {ui.sourceError}
        </p>
      ) : null}
      {source ? (
        <>
          <p className="dsh-wb-muted">{t(locale, "blueprints.selectionNote")}</p>
          <p className="dsh-wb-muted">{t(locale, "blueprints.provenance")}</p>
          <h3 className="dsh-wb-title">{t(locale, "blueprints.packages")}</h3>
          {source.packages.map((item) => {
            const disabled = !item.eligibility.available;
            return (
              <label key={item.name} className="dsh-wb-check">
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
                  {disabled ? ` · ${item.eligibility.reason ?? t(locale, "blueprints.eligibleNo")}` : ""}
                </span>
              </label>
            );
          })}
          <h3 className="dsh-wb-title">{t(locale, "blueprints.bundles")}</h3>
          <ol>
            {source.bundles.map((bundle) => (
              <li key={`${bundle.order}:${bundle.name}`}>
                {bundle.order + 1}. {bundle.name}
                {bundle.eligible ? "" : ` · ${bundle.reason ?? t(locale, "blueprints.eligibleNo")}`}
              </li>
            ))}
          </ol>
          <h3 className="dsh-wb-title">{t(locale, "blueprints.patch")}</h3>
          <label className="dsh-wb-check">
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
              <label key={item.namespace} className="dsh-wb-check">
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
          {ui.bindings.map((row, index) => (
            <BindingEditor
              key={`detected:${row.pointer}:${index}`}
              locale={locale}
              row={row}
              onChange={(patch) => session.setBinding(index, patch)}
            />
          ))}
          <details className="dsh-wb-form">
            <summary>{t(locale, "blueprints.advancedPointer")}</summary>
            <BindingEditor locale={locale} row={ui.advanced} onChange={session.setAdvanced} advanced />
          </details>
          <label className="dsh-wb-field">
            {t(locale, "create.name")}
            <input value={ui.metaName} onChange={(event) => session.setMetaName(event.target.value)} />
          </label>
          <label className="dsh-wb-field">
            {t(locale, "blueprints.version")}
            <input value={ui.metaVersion} onChange={(event) => session.setMetaVersion(event.target.value)} />
          </label>
          <label className="dsh-wb-field">
            {t(locale, "blueprints.description")}
            <textarea rows={3} value={ui.metaDescription} onChange={(event) => session.setMetaDescription(event.target.value)} />
          </label>
          <div className="dsh-wb-actions">
            <button
              type="button"
              className="dsh-wb-btn primary"
              disabled={ui.generateStatus === "loading"}
              onClick={() => session.generate()}
            >
              {t(locale, "blueprints.generate")}
            </button>
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
    </div>
  );
}

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
    <section data-blueprint-output="true">
      <h3 className="dsh-wb-title">{t(locale, "blueprints.output")}</h3>
      <DiagnosticList locale={locale} diagnostics={generate.diagnostics} />
      <pre className="dsh-wb-pre">{generate.json}</pre>
      <p className="dsh-wb-muted">{generate.shareCode}</p>
      <div className="dsh-wb-actions">
        <button type="button" className="dsh-wb-btn" onClick={() => session.copyShareCode()}>
          {t(locale, "blueprints.copyShare")}
        </button>
        <button type="button" className="dsh-wb-btn" onClick={() => session.saveJson()}>
          {t(locale, "blueprints.saveJson")}
        </button>
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
    </section>
  );
}

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

function BindingEditor({
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
    <fieldset className="dsh-wb-form">
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

function InspectedBlueprint({
  locale,
  blueprint,
  diagnostics,
}: {
  locale: WorkbenchLocale;
  blueprint: Blueprint;
  diagnostics: BlueprintDiagnostic[];
}): ReactElement {
  const bundled = new Set(blueprint.profile.bundles);
  return (
    <section data-blueprint-inspect="true">
      <h3 className="dsh-wb-title">{t(locale, "blueprints.metadata")}</h3>
      <dl className="dsh-wb-dl">
        <dt>{t(locale, "create.name")}</dt>
        <dd>{blueprint.metadata.name}</dd>
        <dt>{t(locale, "blueprints.version")}</dt>
        <dd>{blueprint.metadata.version}</dd>
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
        <ol>
          {blueprint.profile.bundles.map((name, index) => (
            <li key={`${index}:${name}`}>
              {index + 1}. {name} · {t(locale, "blueprints.bundled")}
            </li>
          ))}
        </ol>
      )}
      <details>
        <summary>
          {t(locale, "blueprints.presets")} ({blueprint.profile.patch.length}) / {t(locale, "blueprints.settings")} (
          {Object.keys(blueprint.profile.settings).length})
        </summary>
        <pre className="dsh-wb-pre">{JSON.stringify({ patch: blueprint.profile.patch, settings: blueprint.profile.settings }, null, 2)}</pre>
      </details>
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
    </section>
  );
}

function PackageList({
  locale,
  packages,
  bundled,
}: {
  locale: WorkbenchLocale;
  packages: BlueprintPackage[];
  bundled: Set<string>;
}): ReactElement {
  if (packages.length === 0) return <p className="dsh-wb-muted">{t(locale, "plan.none")}</p>;
  return (
    <ul>
      {packages.map((item) => (
        <li key={item.name}>
          {item.name} {item.version} · {item.source.type}
          {item.source.type === "github" ? ` ${item.source.repository}@${item.source.commit}` : ""}
          {item.integrity ? "" : ` · ${t(locale, "blueprints.integrityMissing")}`} · {t(locale, "blueprints.selected")}
          {bundled.has(item.name) ? ` · ${t(locale, "blueprints.bundled")}` : ""}
        </li>
      ))}
    </ul>
  );
}

function LocalInputs({
  locale,
  blueprint,
  ui,
  onString,
  onBoolean,
  onModel,
  onUnset,
}: {
  locale: WorkbenchLocale;
  blueprint: Blueprint;
  ui: BlueprintUiState;
  onString: (id: string, text: string) => void;
  onBoolean: (id: string, value: boolean) => void;
  onModel: (id: string, connectionId: string, modelId: string) => void;
  onUnset: (id: string) => void;
}): ReactElement | null {
  if (blueprint.inputs.length === 0) return null;
  return (
    <section>
      <h3 className="dsh-wb-title">{t(locale, "blueprints.inputs")}</h3>
      {blueprint.inputs.map((input) => (
        <InputControl
          key={input.id}
          locale={locale}
          input={input}
          ui={ui}
          onString={onString}
          onBoolean={onBoolean}
          onModel={onModel}
          onUnset={onUnset}
        />
      ))}
    </section>
  );
}

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

function PreviewBody({
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
    <section data-blueprint-preview="true">
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
      <ul>
        {preview.packages.map((item) => (
          <li key={`${item.name}:${item.order ?? "x"}`}>
            {item.name} {item.version} · {item.source} · {t(locale, "blueprints.selected")}
            {item.bundled
              ? ` · ${t(locale, "blueprints.bundled")}${item.order !== undefined ? ` #${item.order}` : ""}`
              : ""}
          </li>
        ))}
      </ul>
      <h3 className="dsh-wb-title">{t(locale, "blueprints.inputs")}</h3>
      <ul>
        {preview.inputs.map((item) => (
          <li key={item.id} data-origin={item.origin}>
            {item.id} · {t(locale, originKey(item.origin))}
            {item.origin === "missing" ? "" : ` · ${formatPreviewValue(item.value)}`}
          </li>
        ))}
      </ul>
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
    </section>
  );
}

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

function DiagnosticList({
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
      <ul>
        {diagnostics.map((item, index) => (
          <li key={`${item.code}:${item.path ?? ""}:${index}`} data-severity={item.severity}>
            {item.severity} · {item.code}
            {item.path ? ` · ${item.path}` : ""} — {item.message}
          </li>
        ))}
      </ul>
    </>
  );
}

function SafeLink({ href }: { href: string }): ReactElement {
  const safe = isHttpsHref(href);
  if (!safe) return <span>{href}</span>;
  return (
    <a href={safe} rel="noopener noreferrer" target="_blank">
      {safe}
    </a>
  );
}

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
    <dl className="dsh-wb-dl" data-blueprint-apply="true">
      {stages.map((stage) => {
        const row = outcome.stages[stage.key];
        return (
          <Fragment key={stage.key}>
            <dt>{t(locale, stage.label)}</dt>
            <dd data-blueprint-stage={stage.key} data-status={row.status}>
              {stageStatus(locale, row.status)}
              {"error" in row && row.error ? ` — ${row.error}` : ""}
              {stage.key === "presets" && outcome.writes.length > 0
                ? ` · ${outcome.writes
                    .map((item) => `${item.kind}${item.namespace ? `:${item.namespace}` : ""} ${stageStatus(locale, item.status)}${item.error ? ` — ${item.error}` : ""}`)
                    .join("; ")}`
                : ""}
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
            {outcome.source.name} {outcome.source.version}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function stageStatus(locale: WorkbenchLocale, status: "succeeded" | "failed" | "not-run"): string {
  if (status === "succeeded") return t(locale, "blueprints.status.succeeded");
  if (status === "failed") return t(locale, "blueprints.status.failed");
  return t(locale, "blueprints.status.notRun");
}

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

async function onBlueprintFile(event: ChangeEvent<HTMLInputElement>, controller: WorkbenchController): Promise<void> {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const buffer = await file.arrayBuffer();
  controller.blueprint.readFileBytes(new Uint8Array(buffer), file.name);
}
