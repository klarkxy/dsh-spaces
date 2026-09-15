import { useEffect, useRef, useState } from "react";
import type {
  HubSettings,
  LocalePreference,
  PackageSource,
  ThemePreference,
} from "@shared/types";
import { useI18n } from "../i18n";
import { settingsFormKey } from "../recovery";
import { useTheme } from "../theme";
import { LocaleSelect } from "./LocaleSelect";
import { MaintenancePanel } from "./MaintenanceDialog";
import { Card, Overlay } from "./Overlay";

export function SettingsDialog({
  initial,
  dshHome,
  initialTab = "general",
  onCancel,
  onSave,
  onQuit,
  onMaintenanceChanged,
}: {
  initial: HubSettings;
  dshHome: string;
  initialTab?: "general" | "runtime";
  onCancel: () => void;
  onSave: (settings: HubSettings) => void;
  onQuit: () => void;
  onMaintenanceChanged: () => Promise<unknown>;
}) {
  const { t, locale: appLocale, setPreference } = useI18n();
  const { setPreference: setThemePreference } = useTheme();
  const [tab, setTab] = useState<"general" | "runtime">(initialTab);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [portStart, setPortStart] = useState(String(initial.portStart));
  const [portEnd, setPortEnd] = useState(String(initial.portEnd));
  const showQuitKeepHint = initial.quitBehavior === "keep" && !initial.quitKeepHintDismissed;
  const [packageSource, setPackageSource] = useState<PackageSource>(initial.packageSource);
  const [locale, setLocale] = useState<LocalePreference>(initial.locale);
  const [shareNotice, setShareNotice] = useState("");
  const [theme, setTheme] = useState<ThemePreference>(initial.theme);

  // A maintenance action (e.g. snapshot create) rewrites settings on disk and
  // updates `initial`; drop the now-stale draft so Save can't overwrite the
  // restored values. Unchanged settings keep in-progress edits untouched.
  const initialKey = settingsFormKey(initial);
  const syncedKey = useRef(initialKey);
  useEffect(() => {
    if (syncedKey.current === initialKey) return;
    syncedKey.current = initialKey;
    setPortStart(String(initial.portStart));
    setPortEnd(String(initial.portEnd));
    setPackageSource(initial.packageSource);
    setLocale(initial.locale);
    setTheme(initial.theme);
  }, [initialKey, initial]);

  const revert = () => {
    setPreference(initial.locale);
    setThemePreference(initial.theme);
    onCancel();
  };

  const changeLocale = (next: LocalePreference) => {
    setLocale(next);
    setPreference(next);
  };

  const changeTheme = (next: ThemePreference) => {
    setTheme(next);
    setThemePreference(next);
  };

  const tabStyle = (active: boolean) => ({
    color: active ? "var(--text)" : "var(--text-muted)",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
  });

  return (
    <Overlay onBackdrop={maintenanceBusy ? undefined : revert}>
      <Card wide>
        <p className="ui-kicker">{t("cli.brand")}</p>
        <h2 className="mt-1 text-lg font-semibold">{t("settings.title")}</h2>
        <div className="mt-3 flex gap-4">
          <button
            type="button"
            className="pb-1 text-sm disabled:opacity-40"
            style={tabStyle(tab === "general")}
            disabled={maintenanceBusy}
            onClick={() => setTab("general")}
          >
            {t("settings.tabGeneral")}
          </button>
          <button
            type="button"
            className="pb-1 text-sm disabled:opacity-40"
            style={tabStyle(tab === "runtime")}
            disabled={maintenanceBusy && tab !== "runtime"}
            onClick={() => setTab("runtime")}
          >
            {t("settings.tabRuntime")}
          </button>
        </div>
        {tab === "general" ? (
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
            <LocaleSelect value={locale} onChange={changeLocale} />
            <label className="mt-4 block text-xs" style={{ color: "var(--text-label)" }}>
              {t("settings.appearance")}
              <select
                className="field mt-1"
                value={theme}
                onChange={(event) => changeTheme(event.target.value as ThemePreference)}
              >
                <option value="system">{t("settings.appearanceSystem")}</option>
                <option value="light">{t("settings.appearanceLight")}</option>
                <option value="dark">{t("settings.appearanceDark")}</option>
              </select>
            </label>
            <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
              {t("settings.appearanceHint")}
            </p>
            <p className="mt-4 text-xs" style={{ color: "var(--text-label)" }}>
              {t("settings.dshHome")}
            </p>
            <p className="field mt-1 break-all">{dshHome}</p>
            <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
              {t("settings.dshHomeHint")}
            </p>
            <button
              type="button"
              className="btn-ghost mt-4 rounded px-3 py-1.5 text-sm"
              onClick={() => {
                void (async () => {
                  setShareNotice("");
                  const result = await window.dshSpaces.importSpaceShare();
                  if (!result) return;
                  const lines = [
                    `definition: ${result.definition}`,
                    `plugins: ${result.plugins}`,
                    `start: ${result.start}`,
                    ...result.errors,
                    ...result.pendingManual.map((row) => `${row.packageName}: ${row.source}`),
                  ];
                  setShareNotice(lines.join("\n"));
                  await onMaintenanceChanged();
                })();
              }}
            >
              {t("settings.importSpace")}
            </button>
            <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
              {t("settings.importSpaceHint")}
            </p>
            {shareNotice ? (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs" role="status">
                {shareNotice}
              </pre>
            ) : null}
            <button
              type="button"
              className="btn-ghost mt-3 rounded px-3 py-1.5 text-sm"
              onClick={() => {
                void (async () => {
                  const templates = await window.dshSpaces.listSpaceTemplates();
                  const first = templates[0];
                  if (!first) {
                    setShareNotice("No templates.");
                    return;
                  }
                  const result = await window.dshSpaces.createSpaceFromTemplate(first.id);
                  setShareNotice(`template ${first.id}\nspace ${result.spaceId}\nplugins ${result.plugins}\n${result.errors.join("\n")}`);
                  await onMaintenanceChanged();
                })();
              }}
            >
              {appLocale === "zh" ? "从模板创建" : "Create from template"}
            </button>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="text-xs" style={{ color: "var(--text-label)" }}>
                {t("settings.portStart")}
                <input
                  className="field mt-1"
                  value={portStart}
                  onChange={(event) => setPortStart(event.target.value)}
                />
              </label>
              <label className="text-xs" style={{ color: "var(--text-label)" }}>
                {t("settings.portEnd")}
                <input
                  className="field mt-1"
                  value={portEnd}
                  onChange={(event) => setPortEnd(event.target.value)}
                />
              </label>
            </div>
            <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
              {t("settings.portHint")}
            </p>
            <label className="mt-4 block text-xs" style={{ color: "var(--text-label)" }}>
              {t("settings.packageSource")}
              <select
                className="field mt-1"
                value={packageSource}
                onChange={(event) => setPackageSource(event.target.value as PackageSource)}
              >
                <option value="china">{t("cli.sourceChina")}</option>
                <option value="official">{t("cli.sourceOfficial")}</option>
              </select>
            </label>
            <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
              {t("settings.packageSourceHint")}
            </p>
            <p className="mt-4 text-xs" style={{ color: "var(--text-label)" }}>
              {t("settings.onQuit")}
            </p>
            <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
              {t("settings.quitHint")}
            </p>
            {showQuitKeepHint ? (
              <p className="mt-2 text-xs" style={{ color: "var(--warn)" }}>
                {t("settings.quitKeepMigrate")}
              </p>
            ) : null}
            <button type="button" className="mt-3 rounded border px-3 py-1.5 text-sm" onClick={onQuit}>
              {t("tray.quit")}
            </button>
          </div>
        ) : (
          <div className="mt-4 flex min-h-0 flex-1 flex-col">
            <MaintenancePanel
              onChanged={onMaintenanceChanged}
              onBusyChange={setMaintenanceBusy}
            />
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="btn-ghost rounded px-3 py-1.5 text-sm disabled:opacity-40"
            disabled={maintenanceBusy}
            onClick={revert}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-primary rounded px-3 py-1.5 text-sm disabled:opacity-40"
            disabled={maintenanceBusy}
            onClick={() =>
              onSave({
                portStart: Number(portStart),
                portEnd: Number(portEnd),
                quitBehavior: "stop",
                quitKeepHintDismissed: true,
                packageSource,
                locale,
                theme,
                catalogUrl: initial.catalogUrl,
              })
            }
          >
            {t("common.save")}
          </button>
        </div>
      </Card>
    </Overlay>
  );
}
