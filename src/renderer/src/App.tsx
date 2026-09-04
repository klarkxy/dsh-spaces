import { useEffect, useRef, useState } from "react";
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
import {
  restoreSelected,
  shouldShowIdleCard,
  shouldShowStartingCard,
} from "@shared/restore-selected";
import { CliSetup } from "./components/CliSetup";
import { CreateWizard } from "./components/CreateWizard";
import { DeleteDialog } from "./components/DeleteDialog";
import { EmptyMain, IdleMain, StartingMain } from "./components/EmptyMain";
import { IconDialog, RenameDialog } from "./components/MetaDialogs";
import { Onboarding } from "./components/Onboarding";
import { Rail } from "./components/Rail";
import { SettingsDialog } from "./components/SettingsDialog";
import { TitleBar } from "./components/TitleBar";
import { visibleError } from "@shared/i18n";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";

type OverlayKind = "create" | "settings" | "rename" | "icon" | "delete" | "onboarding" | null;
type BusyOperation = {
  id: number;
  label: string;
  launchingProfile?: string;
};

export default function App() {
  const { t, preference, setPreference } = useI18n();
  const { setPreference: setThemePreference } = useTheme();
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<BusyOperation | null>(null);
  const busyId = useRef(0);
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
    const [next, visible] = await Promise.all([
      window.dshSpaces.listProfiles(),
      window.dshSpaces.getSelectedProfile(),
    ]);
    setProfiles(next);
    setSelected((current) => restoreSelected(current, visible, next));
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
        if (!cancelled) setError(visibleError(err instanceof Error ? err.message : String(err)));
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
      if (payload.type === "error" && payload.message) setError(visibleError(payload.message));
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

  const run = async (
    label: string,
    action: () => Promise<unknown>,
    launchingProfile?: string,
  ) => {
    const id = ++busyId.current;
    setBusy({ id, label, launchingProfile });
    setError("");
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(visibleError(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy((current) => (current?.id === id ? null : current));
    }
  };

  const persistLocale = (next: LocalePreference) => {
    setPreference(next);
    if (!settings) return;
    void window.dshSpaces.saveSettings({ ...settings, locale: next }).then(setSettings);
  };

  const current = profiles.find((p) => p.name === selected);
  const overlayProfile = profiles.find((p) => p.name === target);
  const launchingCurrent = Boolean(selected && busy?.launchingProfile === selected);
  const showStarting =
    Boolean(selected) &&
    shouldShowStartingCard(current?.status, launchingCurrent) &&
    !overlay &&
    !cliBusy;
  const showIdle =
    Boolean(selected) &&
    shouldShowIdleCard(current?.status, launchingCurrent) &&
    !overlay &&
    !cliBusy;

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        busy={busy?.label}
        error={current?.status === "crashed" ? undefined : error || undefined}
        onDismissError={() => setError("")}
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
          const display =
            profiles.find((profile) => profile.name === name)?.meta.displayName || name;
          setSelected(name);
          void run(
            t("busy.select", { name: display }),
            () => window.dshSpaces.selectProfile(name),
            name,
          );
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
        onMenu={(name) => {
          void window.dshSpaces.hideRailTip();
          void window.dshSpaces.showProfileMenu(name);
        }}
        onReorder={(names) => void run(t("busy.reorder"), () => window.dshSpaces.reorderProfiles(names))}
        onHover={(profile, top) => {
          if (!profile) void window.dshSpaces.hideRailTip();
          else void window.dshSpaces.showRailTip(profile.meta.displayName, top);
        }}
        />
        <main className="relative flex-1" style={{ background: "var(--bg-main)" }}>
        {showStarting && current ? (
          <StartingMain name={current.meta.displayName || current.name} />
        ) : null}
        {showIdle && current ? (
          <IdleMain
            name={current.meta.displayName || current.name}
            onOpen={() =>
              void run(
                t("busy.select", { name: current.meta.displayName || current.name }),
                () => window.dshSpaces.selectProfile(current.name),
                current.name,
              )
            }
            onCreate={() => {
              setProgress(null);
              setOverlay("create");
            }}
            onRename={() => {
              setTarget(current.name);
              setOverlay("rename");
            }}
            onDelete={
              current.name === "web"
                ? undefined
                : () => {
                    setTarget(current.name);
                    setOverlay("delete");
                  }
            }
          />
        ) : null}
        {!selected && !overlay && !cliBusy ? (
          <EmptyMain
            firstName={profiles[0]?.meta.displayName || profiles[0]?.name}
            onOpen={
              profiles[0]
                ? () => {
                    const name = profiles[0].name;
                    const display = profiles[0].meta.displayName || name;
                    setSelected(name);
                    void run(
                      t("busy.select", { name: display }),
                      () => window.dshSpaces.selectProfile(name),
                      name,
                    );
                  }
                : undefined
            }
            onCreate={() => {
              setProgress(null);
              setOverlay("create");
            }}
          />
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
              <p className="mt-2 text-sm" style={{ color: "var(--text-faint)" }}>
                {t("crash.hint")}
              </p>
              <button
                type="button"
                className="mt-4 rounded px-3 py-1.5 text-sm text-white"
                style={{ background: "var(--accent)" }}
                onClick={() =>
                  void run(
                    t("busy.restart", { name: current.meta.displayName || current.name }),
                    () => window.dshSpaces.restartProfile(current.name),
                    current.name,
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
                  setError(visibleError(err instanceof Error ? err.message : String(err)));
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
              void run(
                t("busy.restart", { name }),
                () => window.dshSpaces.restartProfile(name),
                name,
              )
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
