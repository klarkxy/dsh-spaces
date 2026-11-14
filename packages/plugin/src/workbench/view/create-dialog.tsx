/**
 * Space creation, save-as-template, and share-export dialogs.
 *
 * The create dialog brings together the three ways a space starts: blank,
 * from a saved local template, or imported from a `.dshspace` archive.
 */

import React, { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { motion } from "motion/react";
import { blueprintRecipe } from "@klarkxy/dsh-blueprint/document";
import { LayoutIndicator, springSoft, VisibleScale } from "../../../../../src/shared/ui/motion";
import { SPACE_AVATARS } from "../../../../../src/shared/space-avatars";
import { RESERVED_PROFILE_NAMES, SPACE_NAME_RE, spaceIdFromName } from "../../../../../src/shared/types";
import { SPACES_BLUEPRINT_SEALED } from "../../../../../src/shared/blueprint-sealed";
import { SPACES_BROWSER_SEALED } from "../../../../../src/shared/browser-sealed";
import { BlueprintCreateFlow } from "../blueprint/create-flow";
import { t } from "../i18n";
import type { CreateDialogMode, WorkbenchController, WorkbenchUiState } from "../store";
import { detectTemplateFile, formatFileSize } from "../templates/detect";
import { TemplateDropZone } from "../templates/drop-zone";
import { TemplatesError } from "../templates/errors";
import { importTemplateFile } from "../templates/import-section";
import { IconPicker, type IconPickState } from "./icon-picker";
import { useModalDialog } from "./use-modal-dialog";

const MotionForm = motion.form;
const RESERVED_SPACE_NAMES = new Set<string>(RESERVED_PROFILE_NAMES);

export function deriveSpaceName(displayName: string, existingIds: ReadonlySet<string>): string {
  const trimmed = displayName.trim();
  if (!trimmed) return "";
  const ascii = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28)
    .replace(/-+$/g, "");
  if (ascii && SPACE_NAME_RE.test(ascii) && !RESERVED_SPACE_NAMES.has(ascii)) {
    if (!existingIds.has(spaceIdFromName(ascii))) return ascii;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${ascii.slice(0, Math.max(1, 33 - String(suffix).length - 1))}-${suffix}`;
      if (SPACE_NAME_RE.test(candidate) && !existingIds.has(spaceIdFromName(candidate))) return candidate;
    }
  }
  for (let index = 1; index < 10000; index += 1) {
    const candidate = String(index);
    if (!existingIds.has(spaceIdFromName(candidate))) return candidate;
  }
  return "1";
}

const CREATE_MODES: Array<[CreateDialogMode, "create.mode.blank" | "create.mode.template" | "create.mode.import"]> = [
  ["blank", "create.mode.blank"],
  ["template", "create.mode.template"],
  ["import", "create.mode.import"],
];

export function CreateDialog({
  ui,
  controller,
  initialMode = "blank",
  initialTemplateId,
  error,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  initialMode?: CreateDialogMode;
  initialTemplateId?: string;
  /** The failure of this form. The dialog stays open and shows it here. */
  error: string | null;
}): ReactElement {
  const locale = ui.locale;
  const panel = useRef<HTMLFormElement>(null);
  const modal = useModalDialog(panel, { onCancel: controller.closeOverlay });
  const [mode, setMode] = useState<CreateDialogMode>(initialMode);
  const [displayName, setDisplayName] = useState("");
  const [customName, setCustomName] = useState("");
  const [startAfterCreate, setStartAfterCreate] = useState(true);
  const [modelSource, setModelSource] = useState<"main" | "local">("main");
  const iconRef = useRef<string>(SPACE_AVATARS[0].image);
  const [base, setBase] = useState<"web" | "browser">("web");
  const [version, setVersion] = useState("");
  const [catalog, setCatalog] = useState<{ base: "web" | "browser"; versions: string[] } | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState(initialTemplateId ?? ui.templateId ?? "");
  const [pickedFile, setPickedFile] = useState<{ name: string; size: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    if (initialTemplateId) setSelectedTemplateId(initialTemplateId);
  }, [initialTemplateId]);

  useEffect(() => {
    if (mode === "template" && ui.templatesStatus === "idle") {
      void controller.loadTemplates();
    }
  }, [controller, mode, ui.templatesStatus]);

  useEffect(() => {
    let active = true;
    setCatalog(null);
    setVersion("");
    setVersionError(null);
    void controller.baseVersions(base).then(
      (result) => {
        if (!active) return;
        setCatalog(result);
        setVersion(result.preferred ?? "");
      },
      (reason) => {
        if (active) setVersionError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [controller, base]);

  const versionReady = catalog?.base === base && catalog.versions.includes(version);
  const iconState = useRef<IconPickState>("idle");
  const [iconBlocked, setIconBlocked] = useState(false);
  const onIconState = (state: IconPickState): void => {
    iconState.current = state;
    setIconBlocked(state !== "idle");
  };

  const existingIds = new Set((ui.state?.spaces ?? []).map((space) => space.id));
  const activeTemplate =
    ui.templates.find((row) => row.id === selectedTemplateId) ?? ui.templates[0] ?? null;
  const effectiveTemplateId = activeTemplate?.id ?? "";
  const seedLabel =
    mode === "template"
      ? displayName.trim() || activeTemplate?.displayName || activeTemplate?.name || ""
      : displayName;
  const derivedName = deriveSpaceName(seedLabel, existingIds);
  const rawCustom = customName.trim().toLowerCase();
  const effectiveName = rawCustom !== "" ? rawCustom : derivedName;
  const nameInvalid =
    effectiveName.length > 0 &&
    (!SPACE_NAME_RE.test(effectiveName) || RESERVED_SPACE_NAMES.has(effectiveName));

  const globalBusy = controller.isGlobalBusy() || ui.commandPending;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (mode === "blank") {
      if (iconState.current !== "idle" || !versionReady || !effectiveName || nameInvalid) return;
      controller.createSpace({
        name: effectiveName,
        displayName: displayName.trim() || undefined,
        icon: iconRef.current,
        base,
        baseVersion: version,
        startAfterCreate,
        ...(base === "web" ? { modelSource } : {}),
      });
      return;
    }
    if (mode === "template") {
      if (!effectiveTemplateId || !effectiveName || nameInvalid) return;
      controller.setTemplateId(effectiveTemplateId);
      controller.setTemplateName(effectiveName);
      controller.setTemplateDisplayName(displayName.trim() || activeTemplate?.displayName || "");
      controller.createFromTemplate();
    }
  };

  const onPickImportFile = (file: File): void => {
    setPickedFile({ name: file.name, size: file.size });
    setFileError(null);
    void importTemplateFile(file, controller, locale, setFileError, () => undefined);
  };

  const recipe = SPACES_BLUEPRINT_SEALED || !ui.blueprint.inspect
    ? null
    : blueprintRecipe(ui.blueprint.inspect.blueprint);

  return (
    <div className="dsh-wb-overlay">
      <MotionForm
        ref={panel}
        className="dsh-wb-dialog dsh-wb-create-dialog"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-wb-create-title"
        data-create-dialog="true"
        data-create-mode={mode}
        onKeyDown={modal.onKeyDown}
        initial={{ opacity: 1, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={springSoft}
      >
        <h2 id="dsh-wb-create-title" className="dsh-wb-title">{t(locale, "create.title")}</h2>
        <div
          className="dsh-wb-tabs dsh-wb-template-tabs"
          role="tablist"
          aria-label={t(locale, "create.title")}
          data-create-modes="true"
        >
          {CREATE_MODES.map(([candidate, labelKey], index) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              id={`create-mode-${candidate}`}
              aria-selected={mode === candidate}
              tabIndex={mode === candidate ? 0 : -1}
              className="dsh-wb-tab dsh-wb-template-tab"
              data-create-mode-tab={candidate}
              onClick={() => {
                setFileError(null);
                setMode(candidate);
              }}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % CREATE_MODES.length
                    : event.key === "ArrowLeft"
                      ? (index + CREATE_MODES.length - 1) % CREATE_MODES.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? CREATE_MODES.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                const target = CREATE_MODES[next][0];
                setFileError(null);
                setMode(target);
                document.getElementById(`create-mode-${target}`)?.focus();
              }}
            >
              {t(locale, labelKey)}
              <LayoutIndicator
                as="span"
                layoutId="dsh-wb-create-mode-tab"
                active={mode === candidate}
                className="dsh-wb-template-tab-indicator"
              />
            </button>
          ))}
        </div>

        <div className="dsh-wb-create-fields">
          {mode === "blank" ? (
            <>
              {!SPACES_BLUEPRINT_SEALED ? (
                <button type="button" className="dsh-wb-btn" onClick={controller.openBlueprintUse}>
                  {t(locale, "blueprints.createFrom")}
                </button>
              ) : null}
              <label className="dsh-wb-field">
                {t(locale, "create.displayName")}
                <input
                  name="displayName"
                  autoComplete="off"
                  data-autofocus="true"
                  placeholder={t(locale, "create.displayNamePlaceholder")}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              {effectiveName && !nameInvalid ? (
                <p className="dsh-wb-muted" data-create-id-hint="true">
                  {t(locale, "create.autoIdHint", { id: spaceIdFromName(effectiveName) })}
                </p>
              ) : null}
              <IconPicker
                locale={locale}
                value={iconRef.current}
                onChange={(icon) => (iconRef.current = icon)}
                onState={onIconState}
              />
              <label className="dsh-wb-check">
                <input
                  type="checkbox"
                  name="startAfterCreate"
                  checked={startAfterCreate}
                  data-create-start-after="true"
                  onChange={(event) => setStartAfterCreate(event.target.checked)}
                />
                {t(locale, "create.startAfter")}
              </label>
              <details className="dsh-wb-create-advanced" data-create-advanced="true">
                <summary>{t(locale, "create.advanced")}</summary>
                <div className="dsh-wb-create-advanced-body">
                  <label className="dsh-wb-field">
                    {t(locale, "create.name")}
                    <input
                      name="name"
                      autoComplete="off"
                      maxLength={33}
                      spellCheck={false}
                      placeholder={derivedName || "writing"}
                      value={customName}
                      onChange={(event) => setCustomName(event.target.value)}
                      aria-invalid={nameInvalid || undefined}
                      aria-describedby={nameInvalid ? "dsh-wb-create-name-invalid" : undefined}
                    />
                    {nameInvalid ? (
                      <span id="dsh-wb-create-name-invalid" className="dsh-wb-muted" role="alert">
                        {t(locale, "app.nameInvalid")}
                      </span>
                    ) : null}
                  </label>
                  {!SPACES_BROWSER_SEALED ? (
                    <label className="dsh-wb-field">
                      {t(locale, "create.base")}
                      <select
                        name="base"
                        value={base}
                        onChange={(event) => setBase(event.target.value as "web" | "browser")}
                      >
                        <option value="web">Web</option>
                        <option value="browser">Browser</option>
                      </select>
                    </label>
                  ) : null}
                  <label className="dsh-wb-field">
                    {t(locale, SPACES_BROWSER_SEALED ? "create.webVersion" : "create.baseVersion")}
                    <select
                      name="baseVersion"
                      value={versionReady ? version : ""}
                      onChange={(event) => setVersion(event.target.value)}
                      disabled={catalog?.base !== base}
                      required
                    >
                      {!versionReady ? <option value="">{t(locale, "create.versionPending")}</option> : null}
                      {catalog?.base === base
                        ? catalog.versions.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))
                        : null}
                    </select>
                  </label>
                  {base === "web" ? (
                    <label className="dsh-wb-field">
                      {t(locale, "create.modelSource")}
                      <select
                        name="modelSource"
                        value={modelSource}
                        onChange={(event) =>
                          setModelSource(event.target.value === "local" ? "local" : "main")
                        }
                      >
                        <option value="main">{t(locale, "create.mainModel")}</option>
                        <option value="local">{t(locale, "create.localModel")}</option>
                      </select>
                    </label>
                  ) : null}
                </div>
              </details>
              {versionError ? <p className="dsh-wb-alert" role="alert">{versionError}</p> : null}
            </>
          ) : null}

          {mode === "template" ? (
            <>
              {ui.templatesStatus === "loading" ? (
                <p role="status" className="dsh-wb-muted">{t(locale, "app.loading")}</p>
              ) : null}
              {ui.templatesStatus === "error" ? (
                <p className="dsh-wb-alert" role="alert">
                  {ui.readError.templates ?? t(locale, "app.genericError")}
                </p>
              ) : null}
              {ui.templates.length === 0 && ui.templatesStatus !== "loading" ? (
                <p className="dsh-wb-muted" data-create-template-empty="true">
                  {t(locale, "create.templateEmpty")}
                </p>
              ) : null}
              {ui.templates.length > 0 ? (
                <>
                  <label className="dsh-wb-field">
                    {t(locale, "create.templatePick")}
                    <select
                      value={effectiveTemplateId}
                      aria-label={t(locale, "create.templatePick")}
                      data-create-template-select="true"
                      onChange={(event) => setSelectedTemplateId(event.target.value)}
                    >
                      {ui.templates.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.displayName || row.name} · {t(locale, "templates.pluginCount", { count: String(row.plugins.length) })}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="dsh-wb-field">
                    {t(locale, "create.displayName")}
                    <input
                      name="displayName"
                      autoComplete="off"
                      data-autofocus="true"
                      placeholder={activeTemplate?.displayName || t(locale, "create.displayNamePlaceholder")}
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                    />
                  </label>
                  {effectiveName && !nameInvalid ? (
                    <p className="dsh-wb-muted" data-create-id-hint="true">
                      {t(locale, "create.autoIdHint", { id: spaceIdFromName(effectiveName) })}
                    </p>
                  ) : null}
                  <details className="dsh-wb-create-advanced" data-create-template-advanced="true">
                    <summary>{t(locale, "create.advanced")}</summary>
                    <div className="dsh-wb-create-advanced-body">
                      <label className="dsh-wb-field">
                        {t(locale, "create.name")}
                        <input
                          name="name"
                          autoComplete="off"
                          maxLength={33}
                          spellCheck={false}
                          placeholder={derivedName || "writing"}
                          value={customName}
                          onChange={(event) => setCustomName(event.target.value)}
                          aria-invalid={nameInvalid || undefined}
                        />
                        {nameInvalid ? (
                          <span className="dsh-wb-muted" role="alert">
                            {t(locale, "app.nameInvalid")}
                          </span>
                        ) : null}
                      </label>
                    </div>
                  </details>
                </>
              ) : null}
            </>
          ) : null}

          {mode === "import" ? (
            <>
              <TemplateDropZone locale={locale} onFile={onPickImportFile} />
              {pickedFile ? (
                <p className="dsh-wb-muted" data-templates-file="true">
                  {t(locale, "templates.drop.selected")}: {pickedFile.name} · {formatFileSize(pickedFile.size)}
                </p>
              ) : null}
              {fileError ? <TemplatesError message={fileError} /> : null}
              {!SPACES_BLUEPRINT_SEALED && recipe ? (
                <div className="dsh-wb-template-form" data-templates-form="blueprint">
                  <BlueprintCreateFlow locale={locale} ui={ui.blueprint} controller={controller} />
                </div>
              ) : null}
            </>
          ) : null}

          {error ? <p className="dsh-wb-alert" role="alert" data-create-error="true">{error}</p> : null}
        </div>

        {controller.hasActiveJobs() && mode !== "import" ? (
          <p className="dsh-wb-muted" role="status" data-create-busy="true">{t(locale, "create.busy")}</p>
        ) : null}
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={controller.closeOverlay}>
            {t(locale, "app.cancel")}
          </button>
          {mode === "blank" ? (
            <button
              type="submit"
              className="dsh-wb-btn primary"
              disabled={globalBusy || iconBlocked || !versionReady || !effectiveName || nameInvalid}
            >
              {t(locale, "app.create")}
            </button>
          ) : null}
          {mode === "template" ? (
            <button
              type="submit"
              className="dsh-wb-btn primary"
              disabled={globalBusy || !effectiveTemplateId || !effectiveName || nameInvalid}
            >
              {t(locale, "templates.createConfirm")}
            </button>
          ) : null}
        </div>
      </MotionForm>
    </div>
  );
}

export function SaveTemplateDialog({
  ui,
  controller,
  spaceId,
  error,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  spaceId: string;
  error: string | null;
}): ReactElement | null {
  const locale = ui.locale;
  const space = controller.space(spaceId);
  const panel = useRef<HTMLFormElement>(null);
  const modal = useModalDialog(panel, { onCancel: controller.closeOverlay });
  const [localError, setLocalError] = useState<string | null>(null);
  if (!space) return null;
  const writable = controller.canMutate();
  const busy = controller.isGlobalBusy() || ui.commandPending;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ui.templateName.trim()) {
      setLocalError(t(locale, "templates.needName"));
      return;
    }
    setLocalError(null);
    controller.setTemplateSpaceId(space.id);
    controller.saveTemplate();
  };
  const visibleError = error ?? localError;
  return (
    <div className="dsh-wb-overlay">
      <MotionForm
        ref={panel}
        className="dsh-wb-dialog"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-wb-save-template-title"
        data-save-template-dialog="true"
        onKeyDown={modal.onKeyDown}
        initial={{ opacity: 1, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={springSoft}
      >
        <h2 id="dsh-wb-save-template-title" className="dsh-wb-title">{t(locale, "templates.saveTitle")}</h2>
        <p className="dsh-wb-muted">{t(locale, "templates.saveHint", { name: space.displayName })}</p>
        <label className="dsh-wb-field">
          {t(locale, "templates.export.templateName")}
          <input
            value={ui.templateName}
            aria-label={t(locale, "templates.export.templateName")}
            autoComplete="off"
            data-autofocus="true"
            onChange={(event) => {
              if (localError) setLocalError(null);
              controller.setTemplateName(event.target.value);
            }}
          />
        </label>
        <label className="dsh-wb-check">
          <input
            type="checkbox"
            checked={ui.templateIncludeConfig}
            onChange={(event) => controller.setTemplateIncludeConfig(event.target.checked)}
          />
          {t(locale, "templates.includeConfig")}
        </label>
        {visibleError ? <p className="dsh-wb-alert" role="alert">{visibleError}</p> : null}
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={controller.closeOverlay}>
            {t(locale, "app.cancel")}
          </button>
          <button type="submit" className="dsh-wb-btn primary" disabled={!writable || busy}>
            {t(locale, "templates.save")}
          </button>
        </div>
      </MotionForm>
    </div>
  );
}

export function ExportShareDialog({
  ui,
  controller,
  spaceId,
  error,
}: {
  ui: WorkbenchUiState;
  controller: WorkbenchController;
  spaceId: string;
  error: string | null;
}): ReactElement | null {
  const locale = ui.locale;
  const space = controller.space(spaceId);
  const panel = useRef<HTMLElement>(null);
  const modal = useModalDialog(panel, { onCancel: controller.closeOverlay });
  if (!space) return null;
  const busy = controller.isGlobalBusy() || ui.commandPending;
  return (
    <div className="dsh-wb-overlay">
      <VisibleScale
        ref={panel}
        className="dsh-wb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-wb-export-share-title"
        data-export-share-dialog="true"
        onKeyDown={modal.onKeyDown}
      >
        <h2 id="dsh-wb-export-share-title" className="dsh-wb-title">{t(locale, "share.exportTitle")}</h2>
        <p className="dsh-wb-muted">{t(locale, "share.exportHint", { name: space.displayName })}</p>
        <label className="dsh-wb-check">
          <input
            type="checkbox"
            checked={ui.shareIncludeConfig}
            onChange={(event) => controller.setShareIncludeConfig(event.target.checked)}
          />
          {t(locale, "share.includeConfig")}
        </label>
        {error ? <p className="dsh-wb-alert" role="alert">{error}</p> : null}
        <div className="dsh-wb-actions">
          <button type="button" className="dsh-wb-btn" onClick={controller.closeOverlay}>
            {t(locale, "app.cancel")}
          </button>
          <button
            type="button"
            className="dsh-wb-btn primary"
            disabled={busy}
            onClick={() => {
              controller.setShareSpaceId(space.id);
              controller.exportShare();
            }}
          >
            {t(locale, "share.export")}
          </button>
        </div>
      </VisibleScale>
    </div>
  );
}

export { detectTemplateFile };
