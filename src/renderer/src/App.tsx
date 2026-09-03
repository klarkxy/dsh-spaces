import { useEffect, useState } from "react";
import type {
  CliEnsureStatus,
  CreateProgress,
  HubSettings,
  LocalePreference,
  OnboardingScan,
  PackageSource,
  PluginQueueSnapshot,
  PresetIcon,
  ProfileRecord,
} from "@shared/types";
import { inferPackageSource } from "@shared/types";
import { CliSetup } from "./components/CliSetup";
import { CreateWizard } from "./components/CreateWizard";
import { DeleteDialog } from "./components/DeleteDialog";
import { IconDialog, RenameDialog } from "./components/MetaDialogs";
import { Onboarding } from "./components/Onboarding";
import { Rail } from "./components/Rail";
import { SettingsDialog } from "./components/SettingsDialog";
import { TitleBar } from "./components/TitleBar";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";

type OverlayKind = "create" | "settings" | "rename" | "icon" | "delete" | "onboarding" | null;

export default function App() {
  const { t, preference, setPreference } = useI18n();
  const { setPreference: setThemePreference } = useTheme();
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [overlay, setOverlay] = useState<OverlayKind>(null);
  const [settingsTab, setSettingsTab] = useState<"general" | "plugins">("general");
  const [pluginSpace, setPluginSpace] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [scan, setScan] = useState<OnboardingScan | null>(null);
  const [settings, setSettings] = useState<HubSettings | null>(null);
  const [dshHome, setDshHome] = useState("");
  const [progress, setProgress] = useState<CreateProgress | null>(null);
  const [queue, setQueue] = useState<PluginQueueSnapshot>({ pending: 0 });
  const [cli, setCli] = useState<CliEnsureStatus>({
    state: "idle",
    message: "",
  });
  const [packageSource, setPackageSource] = useState<PackageSource>(inferPackageSource());

  const refresh = async () => {
    const next = await window.dshSpaces.listProfiles();
    setProfiles(next);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    const loadHub = async () => {
      const [home, onboarding, hubSettings, snap] = await Promise.all([
        window.dshSpaces.getDshHome(),
        window.dshSpaces.getOnboarding(),
        window.dshSpaces.getSettings(),
        window.dshSpaces.getPluginQueue(),
      ]);
      if (cancelled) return;
      setDshHome(home);
      setScan(onboarding);
      setSettings(hubSettings);
      setPreference(hubSettings.locale);
      setThemePreference(hubSettings.theme);
      setQueue(snap);
      if (!onboarding.onboarded) setOverlay("onboarding");
      await refresh();
    };
    const finishRuntime = async (bin: string) => {
      if (cancelled) return;
      setCli({ state: "ready", message: bin });
      await loadHub();
    };
    const bootstrap = async () => {
      try {
        const [initialCli, runtime, hubSettings] = await Promise.all([
          window.dshSpaces.getCliStatus(),
          window.dshSpaces.getRuntimeStatus(),
          window.dshSpaces.getSettings(),
        ]);
        if (cancelled) return;
        setCli(initialCli);
        setPackageSource(runtime.packageSource || hubSettings.packageSource);
        setSettings(hubSettings);
        setPreference(hubSettings.locale);
        setThemePreference(hubSettings.theme);
        if (runtime.node && runtime.pnpm && runtime.cli) {
          const bin = await window.dshSpaces.ensureCli(runtime.packageSource);
          await finishRuntime(bin);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    const offStatus = window.dshSpaces.onStatus(() => {
      void refresh();
    });
    const offProgress = window.dshSpaces.onCreateProgress((payload) => setProgress(payload));
    const offQueue = window.dshSpaces.onPluginQueue((payload) => setQueue(payload));
    const offCli = window.dshSpaces.onCliStatus((payload) => setCli(payload));
    void bootstrap();
    const offUi = window.dshSpaces.onUiCommand((payload) => {
      if (payload.type === "error" && payload.message) setError(payload.message);
      if (payload.type === "rename" && payload.name) {
        setTarget(payload.name);
        setOverlay("rename");
      }
      if (payload.type === "icon" && payload.name) {
        setTarget(payload.name);
        setOverlay("icon");
      }
      if (payload.type === "delete" && payload.name) {
        setTarget(payload.name);
        setOverlay("delete");
      }
      if (payload.type === "plugins" && payload.name) {
        setPluginSpace(payload.name);
        setSettingsTab("plugins");
        setOverlay("settings");
      }
    });
    return () => {
      cancelled = true;
      offStatus();
      offProgress();
      offQueue();
      offCli();
      offUi();
    };
  }, []);

  const cliBusy = cli.state !== "ready";
  const overlayOpen = overlay !== null || cliBusy;
  useEffect(() => {
    void window.dshSpaces.setOverlayOpen(overlayOpen);
  }, [overlayOpen]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const persistLocale = (next: LocalePreference) => {
    setPreference(next);
    if (!settings) return;
    void window.dshSpaces.saveSettings({ ...settings, locale: next }).then(setSettings);
  };

  const current = profiles.find((p) => p.name === selected);
  const overlayProfile = profiles.find((p) => p.name === target);

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        busy={busy}
        queueText={
          queue.pending > 0 && overlay !== "settings"
            ? queue.current
              ? t("titleBar.pluginQueueCurrent", { count: queue.pending, current: queue.current })
              : t("titleBar.pluginQueue", { count: queue.pending })
            : undefined
        }
      />
      <div className="flex min-h-0 flex-1">
        <Rail
        profiles={profiles}
        selected={selected}
        onSelect={(name) => {
          setSelected(name);
          void run(t("busy.select", { name }), () => window.dshSpaces.selectProfile(name));
        }}
        onCreate={() => {
          setProgress(null);
          setOverlay("create");
        }}
        onSettings={() => {
          setPluginSpace(null);
          setSettingsTab("general");
          setOverlay("settings");
        }}
        onMenu={(name) => void window.dshSpaces.showProfileMenu(name)}
        onReorder={(names) => void run(t("busy.reorder"), () => window.dshSpaces.reorderProfiles(names))}
        onHover={(profile, top) => {
          if (!profile) void window.dshSpaces.hideRailTip();
          else void window.dshSpaces.showRailTip(profile.meta.displayName, top);
        }}
        />
        <main className="relative flex-1" style={{ background: "var(--bg-main)" }}>
        {error && !overlay ? (
          <p className="pointer-events-none absolute top-4 left-4 z-20 max-w-[480px] text-sm text-red-500">
            {error}
          </p>
        ) : null}
        {current?.status === "crashed" ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <div
              className="w-[360px] rounded-xl p-5"
              style={{ background: "var(--bg-card)", border: "1px solid var(--border)" }}
            >
              <h2 className="text-lg font-semibold">{t("crash.title")}</h2>
              <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
                {current.lastError || t("crash.fallback")}
              </p>
              <button
                type="button"
                className="mt-4 rounded px-3 py-1.5 text-sm text-white"
                style={{ background: "var(--accent)" }}
                onClick={() =>
                  void run(t("busy.restart", { name: current.name }), () =>
                    window.dshSpaces.restartProfile(current.name),
                  )
                }
              >
                {t("crash.restart")}
              </button>
            </div>
          </div>
        ) : null}
        {cliBusy ? (
          <CliSetup
            status={cli}
            packageSource={packageSource}
            locale={settings?.locale ?? preference}
            onPackageSource={setPackageSource}
            onLocale={persistLocale}
            onInstall={(source) => {
              setError("");
              setPackageSource(source);
              setCli({ state: "installing", step: "node", message: t("cli.starting") });
              void window.dshSpaces
                .ensureCli(source)
                .then(async (bin) => {
                  setCli({ state: "ready", message: bin });
                  const [home, onboarding, hubSettings, snap] = await Promise.all([
                    window.dshSpaces.getDshHome(),
                    window.dshSpaces.getOnboarding(),
                    window.dshSpaces.getSettings(),
                    window.dshSpaces.getPluginQueue(),
                  ]);
                  setDshHome(home);
                  setScan(onboarding);
                  setSettings(hubSettings);
                  setPreference(hubSettings.locale);
                  setThemePreference(hubSettings.theme);
                  setQueue(snap);
                  if (!onboarding.onboarded) setOverlay("onboarding");
                  await refresh();
                })
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : String(err));
                });
            }}
          />
        ) : overlay === "onboarding" && scan ? (
          <Onboarding
            scan={scan}
            busy={Boolean(busy)}
            error={error}
            locale={settings?.locale ?? preference}
            onLocale={persistLocale}
            onConfirm={() =>
              void run(t("busy.onboarding"), async () => {
                const next = await window.dshSpaces.confirmOnboarding();
                setScan(next);
                setOverlay(null);
              })
            }
          />
        ) : null}
        {overlay === "create" ? (
          <CreateWizard
            busy={Boolean(busy)}
            error={error}
            progress={progress}
            onCancel={() => setOverlay(null)}
            onSubmit={(name, displayName, icon) =>
              void run(t("busy.create", { name }), async () => {
                await window.dshSpaces.createProfile(name, displayName, icon);
                setOverlay(null);
                setSelected(name);
              })
            }
          />
        ) : null}
        {overlay === "settings" && settings ? (
          <SettingsDialog
            initial={settings}
            dshHome={dshHome}
            profiles={profiles}
            selected={pluginSpace ?? selected}
            initialTab={settingsTab}
            pluginPending={queue.pending}
            pluginCurrent={queue.current}
            onCancel={() => setOverlay(null)}
            onSave={(next) =>
              void run(t("busy.saveSettings"), async () => {
                const saved = await window.dshSpaces.saveSettings(next);
                setSettings(saved);
                setPreference(saved.locale);
                setThemePreference(saved.theme);
                setOverlay(null);
              })
            }
            onRestart={(name) =>
              void run(t("busy.restart", { name }), () => window.dshSpaces.restartProfile(name))
            }
          />
        ) : null}
        {overlay === "rename" && overlayProfile ? (
          <RenameDialog
            profile={overlayProfile}
            onCancel={() => setOverlay(null)}
            onSave={(displayName) =>
              void run(t("busy.rename"), async () => {
                await window.dshSpaces.updateMeta(overlayProfile.name, { displayName });
                setOverlay(null);
              })
            }
          />
        ) : null}
        {overlay === "icon" && overlayProfile ? (
          <IconDialog
            profile={overlayProfile}
            onCancel={() => setOverlay(null)}
            onSave={(icon: PresetIcon | undefined) =>
              void run(t("busy.icon"), async () => {
                await window.dshSpaces.updateMeta(overlayProfile.name, { icon: icon ?? "" });
                setOverlay(null);
              })
            }
          />
        ) : null}
        {overlay === "delete" && overlayProfile ? (
          <DeleteDialog
            profile={overlayProfile}
            onCancel={() => setOverlay(null)}
            onConfirm={(deleteOfficial) =>
              void run(t("busy.delete"), async () => {
                await window.dshSpaces.deleteProfile(overlayProfile.name, { deleteOfficial });
                if (selected === overlayProfile.name) setSelected(null);
                setOverlay(null);
              })
            }
          />
        ) : null}
        </main>
      </div>
    </div>
  );
}
