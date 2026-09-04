import { useState } from "react";
import type {
  HubSettings,
  LocalePreference,
  PackageSource,
  ProfileRecord,
  ThemePreference,
} from "@shared/types";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { LocaleSelect } from "./LocaleSelect";
import { Card, Overlay } from "./Overlay";
import { PluginPanel } from "./PluginPanel";

export function SettingsDialog({
  initial,
  dshHome,
  profiles,
  selected,
  initialTab = "general",
  pluginPending,
  pluginCurrent,
  onCancel,
  onSave,
  onRestart,
}: {
  initial: HubSettings;
  dshHome: string;
  profiles: ProfileRecord[];
  selected: string | null;
  initialTab?: "general" | "plugins";
  pluginPending: number;
  pluginCurrent?: string;
  onCancel: () => void;
  onSave: (settings: HubSettings) => void;
  onRestart: (name: string) => void;
}) {
  const { t, setPreference } = useI18n();
  const { setPreference: setThemePreference } = useTheme();
  const [tab, setTab] = useState<"general" | "plugins">(initialTab);
  const [portStart, setPortStart] = useState(String(initial.portStart));
  const [portEnd, setPortEnd] = useState(String(initial.portEnd));
  const [quitBehavior, setQuitBehavior] = useState(initial.quitBehavior);
  const [packageSource, setPackageSource] = useState<PackageSource>(initial.packageSource);
  const [locale, setLocale] = useState<LocalePreference>(initial.locale);
  const [theme, setTheme] = useState<ThemePreference>(initial.theme);
  const [catalogUrl, setCatalogUrl] = useState(initial.catalogUrl);

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
    <Overlay onBackdrop={revert}>
      <Card wide>
        <h2 className="text-lg font-semibold">{t("settings.title")}</h2>
        <div className="mt-3 flex gap-4">
          <button
            type="button"
            className="pb-1 text-sm"
            style={tabStyle(tab === "general")}
            onClick={() => setTab("general")}
          >
            {t("settings.tabGeneral")}
          </button>
          <button
            type="button"
            className="pb-1 text-sm"
            style={tabStyle(tab === "plugins")}
            onClick={() => setTab("plugins")}
          >
            {t("settings.tabPlugins")}
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
            <label className="mt-4 block text-xs" style={{ color: "var(--text-label)" }}>
              {t("settings.onQuit")}
              <select
                className="field mt-1"
                value={quitBehavior}
                onChange={(event) =>
                  setQuitBehavior(event.target.value as HubSettings["quitBehavior"])
                }
              >
                <option value="stop">{t("settings.quitStop")}</option>
                <option value="keep">{t("settings.quitKeep")}</option>
              </select>
            </label>
          </div>
        ) : (
          <div className="mt-4 flex min-h-0 flex-1 flex-col">
            <PluginPanel
              profiles={profiles}
              selected={selected}
              catalogUrl={catalogUrl}
              onCatalogUrl={setCatalogUrl}
              onRestart={onRestart}
            />
          </div>
        )}
        {pluginPending > 0 ? (
          <p className="mt-3 text-sm" style={{ color: "var(--warn)" }}>
            {pluginCurrent
              ? t("settings.pluginQueueBusyCurrent", { count: pluginPending, current: pluginCurrent })
              : t("settings.pluginQueueBusy", { count: pluginPending })}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm"
            style={{ color: "var(--text-muted)" }}
            onClick={revert}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm text-white"
            style={{ background: "var(--accent)" }}
            onClick={() =>
              onSave({
                portStart: Number(portStart),
                portEnd: Number(portEnd),
                quitBehavior,
                packageSource,
                locale,
                theme,
                catalogUrl,
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
