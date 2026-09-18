import { useEffect, useRef, useState } from "react";
import type {
  CliEnsureStatus,
  CreateProgress,
  HubSettings,
  LocalePreference,
  OnboardingScan,
  PackageSource,
  PluginQueueSnapshot,
  ProfileRecord,
  RuntimeStatus,
} from "@shared/types";
import { inferPackageSource } from "@shared/types";
import {
  desktopSelectAccess,
  shouldDesktopAutoLaunch,
  type DesktopControllerState,
} from "@shared/desktop-controller";
import {
  defaultSpaceName,
  restoreSelected,
  shouldShowIdleCard,
  shouldShowStartingCard,
} from "@shared/restore-selected";
import { CliSetup } from "./components/CliSetup";
import { CreateWizard } from "./components/CreateWizard";
import { DeleteDialog } from "./components/DeleteDialog";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { EmptyMain, IdleMain, StartingMain } from "./components/EmptyMain";
import { IconDialog, RenameDialog } from "./components/MetaDialogs";
import { Onboarding } from "./components/Onboarding";
import { PluginDialog } from "./components/PluginPanel";
import { Rail } from "./components/Rail";
import { SettingsDialog } from "./components/SettingsDialog";
import { TitleBar } from "./components/TitleBar";
import { visibleError } from "@shared/i18n";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";

type OverlayKind = "create" | "settings" | "rename" | "icon" | "delete" | "onboarding" | "diagnostics" | "plugins" | null;
type BusyOperation = {
  id: number;
  label: string;
  launchingProfile?: string;
};

export default function App() {
  const { t, locale, preference, setPreference } = useI18n();
  const { setPreference: setThemePreference } = useTheme();
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<BusyOperation | null>(null);
  const busyId = useRef(0);
  const [overlay, setOverlay] = useState<OverlayKind>(null);
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
  const [runtimeFault, setRuntimeFault] = useState<string | null>(null);
  const [controller, setController] = useState<DesktopControllerState | null>(null);
  const suppressAutoLaunch = useRef(false);
  const defaultLaunch = useRef<string | null>(null);
  const writable = controller?.writable === true;

  const refresh = async () => {
    const [next, visible] = await Promise.all([
      window.dshSpaces.listProfiles(),
      window.dshSpaces.getSelectedProfile(),
    ]);
    setProfiles(next);
    setSelected((current) => restoreSelected(current, visible, next) ?? defaultLaunch.current);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    const loadHub = async (canWrite: boolean) => {
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
      if (!onboarding.onboarded && canWrite) setOverlay("onboarding");
      await refresh();
    };
    const finishRuntime = async (bin: string) => {
      if (cancelled) return;
      setCli({ state: "ready", message: bin });
      await loadHub(true);
    };
    const bootstrap = async () => {
      let initialState: DesktopControllerState;
      try {
        initialState = await window.dshSpaces.getControllerState();
      } catch (err) {
        if (!cancelled) setError(visibleError(err instanceof Error ? err.message : String(err)));
        return;
      }
      if (cancelled) return;
      setController(initialState);
      if (!initialState.writable) {
        setCli({ state: "ready", message: "" });
        await loadHub(false);
        return;
      }
      let initialCli: CliEnsureStatus;
      let hubSettings: HubSettings;
      try {
        [initialCli, hubSettings] = await Promise.all([
          window.dshSpaces.getCliStatus(),
          window.dshSpaces.getSettings(),
        ]);
      } catch (err) {
        if (!cancelled) setError(visibleError(err instanceof Error ? err.message : String(err)));
        return;
      }
      if (cancelled) return;
      setCli(initialCli);
      setSettings(hubSettings);
      setPreference(hubSettings.locale);
      setThemePreference(hubSettings.theme);
      let runtime: RuntimeStatus;
      try {
        runtime = await window.dshSpaces.getRuntimeStatus();
      } catch (err) {
        // A damaged selected runtime must not block settings.
        if (cancelled) return;
        setPackageSource(hubSettings.packageSource);
        setRuntimeFault(visibleError(err instanceof Error ? err.message : String(err)));
        await loadHub(true);
        return;
      }
      setPackageSource(runtime.packageSource || hubSettings.packageSource);
      if (runtime.node && runtime.pnpm && runtime.cli) {
        try {
          const bin = await window.dshSpaces.ensureCli(runtime.packageSource);
          await finishRuntime(bin);
        } catch (err) {
          if (cancelled) return;
          const message = visibleError(err instanceof Error ? err.message : String(err));
          setCli({ state: "error", message });
          setError(message);
        }
      }
    };
    const offStatus = window.dshSpaces.onStatus(() => {
      void refresh();
    });
    const offProgress = window.dshSpaces.onCreateProgress((payload) => setProgress(payload));
    const offQueue = window.dshSpaces.onPluginQueue((payload) => setQueue(payload));
    const offCli = window.dshSpaces.onCliStatus((payload) => setCli(payload));
    const offController = window.dshSpaces.onControllerStatus((payload) => setController(payload));
    void bootstrap();
    const offUi = window.dshSpaces.onUiCommand((payload) => {
      if (payload.type === "error" && payload.message) setError(visibleError(payload.message));
      if (payload.type === "diagnostics" && payload.name) {
        setTarget(payload.name);
        setOverlay("diagnostics");
      }
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
        setOverlay("plugins");
      }
    });
    return () => {
      cancelled = true;
      offStatus();
      offProgress();
      offQueue();
      offCli();
      offController();
      offUi();
    };
  }, []);

  useEffect(() => {
    if (shouldDesktopAutoLaunch(controller)) return;
    const timer = window.setInterval(() => {
      void window.dshSpaces.getControllerState().then(setController).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [controller]);

  const cliBusy = Boolean(writable && !runtimeFault && cli.state !== "ready");
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
    if (!settings || !writable) return;
    void window.dshSpaces.saveSettings({ ...settings, locale: next }).then(setSettings);
  };

  const refuseWrite = (message?: string) => {
    setError(
      message ||
        (locale === "zh"
          ? "当前为只读。接管 Home 后才能更改。"
          : "Home is read-only. Take over before making changes."),
    );
  };

  const selectSpace = (name: string) => {
    const profile = profiles.find((item) => item.name === name);
    const display = profile?.meta.displayName || name;
    const running = profile?.status === "running";
    const access = desktopSelectAccess(writable, Boolean(running));
    setSelected(name);
    if (access === "deny") {
      refuseWrite();
      return;
    }
    void run(
      t("busy.select", { name: display }),
      () => window.dshSpaces.selectProfile(name),
      name,
    );
  };

  useEffect(() => {
    if (!shouldDesktopAutoLaunch(controller)) return;
    if (cliBusy || overlay || runtimeFault) return;
    if (selected || defaultLaunch.current) return;
    // Maintenance (upgrade/snapshot create) leaves spaces stopped; the suppress
    // flag stays set until the user explicitly starts a space, so later profile
    // or settings refreshes cannot auto-start one.
    if (suppressAutoLaunch.current) return;
    const name = defaultSpaceName(profiles);
    if (!name) return;
    const profile = profiles.find((item) => item.name === name);
    if (!profile) return;
    defaultLaunch.current = name;
    const display = profile.meta.displayName || name;
    setSelected(name);
    void run(
      t("busy.select", { name: display }),
      () => window.dshSpaces.selectProfile(name),
      name,
    ).finally(() => {
      defaultLaunch.current = null;
    });
  }, [cliBusy, overlay, selected, profiles, t, runtimeFault, controller]);

  const refreshAfterMaintenance = async () => {
    const saved = await window.dshSpaces.getSettings();
    setSettings(saved);
    setPreference(saved.locale);
    setThemePreference(saved.theme);
    setPackageSource(saved.packageSource);
    await refresh();
    // Maintenance leaves spaces stopped; block auto-launch until explicit user start.
    suppressAutoLaunch.current = true;
    // Maintenance can fix (or break) the selected runtime; always re-resolve it
    // so the fault view appears exactly while the runtime is unusable.
    try {
      const runtime = await window.dshSpaces.getRuntimeStatus();
      if (runtimeFault) {
        // Recovered runtime: getRuntimeStatus/getCliStatus alone never advance the
        // CLI past idle/error, so finish toolchain readiness through ensureCli
        // before leaving the fault view. Failure keeps the fault visible.
        const bin = await window.dshSpaces.ensureCli(runtime.packageSource || saved.packageSource);
        setCli({ state: "ready", message: bin });
      } else {
        setCli(await window.dshSpaces.getCliStatus());
      }
      setPackageSource(runtime.packageSource || saved.packageSource);
      setRuntimeFault(null);
    } catch (err) {
      setRuntimeFault(visibleError(err instanceof Error ? err.message : String(err)));
    }
  };

  const current = profiles.find((p) => p.name === selected);
  const overlayProfile = profiles.find((p) => p.name === target);
  const launchingCurrent = Boolean(selected && busy?.launchingProfile === selected);
  const showStarting =
    Boolean(selected) &&
    shouldShowStartingCard(current?.status, launchingCurrent) &&
    !overlay &&
    !cliBusy &&
    !runtimeFault;
  const showIdle =
    Boolean(selected) &&
    shouldShowIdleCard(current?.status, launchingCurrent) &&
    !overlay &&
    !cliBusy &&
    !runtimeFault;

  return (
    <div className="relative flex h-full flex-col">
      <TitleBar
        busy={busy?.label}
        error={current?.status === "crashed" ? undefined : error || undefined}
        onDismissError={() => setError("")}
        queueText={
          queue.pending > 0 && overlay !== "plugins"
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
        onSelect={selectSpace}
        onCreate={() => {
          if (!writable) {
            refuseWrite();
            return;
          }
          setProgress(null);
          setOverlay("create");
        }}
        onPlugins={() => {
          setPluginSpace(null);
          setOverlay("plugins");
        }}
        onSettings={() => setOverlay("settings")}
        onMenu={(name) => {
          void window.dshSpaces.hideRailTip();
          void window.dshSpaces.showProfileMenu(name);
        }}
        onReorder={(names) => {
          if (!writable) {
            refuseWrite();
            return;
          }
          void run(t("busy.reorder"), () => window.dshSpaces.reorderProfiles(names));
        }}
        onHover={(profile, top) => {
          if (!profile) void window.dshSpaces.hideRailTip();
          else void window.dshSpaces.showRailTip(profile.meta.displayName, top);
        }}
        />
        <main className="relative flex-1 overflow-hidden" style={{ background: "var(--bg-main)" }}>
        <div className="ui-grid" aria-hidden />
        {showStarting && current ? (
          <StartingMain name={current.meta.displayName || current.name} />
        ) : null}
        {showIdle && current ? (
          writable ? (
          <IdleMain
            name={current.meta.displayName || current.name}
            onOpen={() => selectSpace(current.name)}
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
          ) : (
            <EmptyMain
              firstName={current.meta.displayName || current.name}
              onCreate={() => refuseWrite()}
            />
          )
        ) : null}
        {!selected && !overlay && !cliBusy && !runtimeFault ? (
          <EmptyMain
            firstName={profiles[0]?.meta.displayName || profiles[0]?.name}
            onOpen={
              writable && profiles[0]
                ? () => selectSpace(profiles[0].name)
                : undefined
            }
            onCreate={() => {
              if (!writable) {
                refuseWrite();
                return;
              }
              setProgress(null);
              setOverlay("create");
            }}
          />
        ) : null}
        {runtimeFault && !overlay ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <div className="ui-card w-[420px] p-5">
              <h2 className="text-lg font-semibold text-balance">
                {locale === "zh" ? "运行时不可用" : "Runtime unavailable"}
              </h2>
              <p className="mt-2 text-sm text-pretty" style={{ color: "var(--text-muted)" }}>
                {runtimeFault}
              </p>
              <p className="mt-2 text-sm" style={{ color: "var(--text-faint)" }}>
                {locale === "zh"
                  ? "空间不会自动启动。可在“版本”中查看已安装运行时。"
                  : "Spaces will not auto-start. Open Versions to inspect installed runtimes."}
              </p>
              <button
                type="button"
                className="btn-primary mt-4 rounded px-3 py-1.5 text-sm"
                onClick={() => setOverlay("settings")}
              >
                {locale === "zh" ? "版本" : "Versions"}
              </button>
            </div>
          </div>
        ) : null}
        {current?.status === "crashed" ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <div className="ui-card w-[360px] p-5">
              <h2 className="text-lg font-semibold text-balance">{t("crash.title")}</h2>
              <p className="mt-2 text-sm text-pretty" style={{ color: "var(--text-muted)" }}>
                {current.lastError || t("crash.fallback")}
              </p>
              <p className="mt-2 text-sm" style={{ color: "var(--text-faint)" }}>
                {t("crash.hint")}
              </p>
              <button
                type="button"
                className="btn-primary mt-4 rounded px-3 py-1.5 text-sm"
                onClick={() => {
                  setTarget(current.name); setOverlay("diagnostics");
                }}
              >
                {locale === "zh" ? "查看错误详情" : "View error details"}
              </button>
              <button type="button" className="btn-ghost ml-3 rounded px-3 py-1.5 text-sm" onClick={() => {
                const text = [current.lastError, current.name].filter(Boolean).join("\n");
                void navigator.clipboard?.writeText(text);
              }}>{locale === "zh" ? "复制脱敏日志" : "Copy redacted logs"}</button>
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
              if (!writable) {
                refuseWrite();
                return;
              }
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
                  if (!onboarding.onboarded && writable) setOverlay("onboarding");
                  await refresh();
                })
                .catch((err: unknown) => {
                  const message = visibleError(err instanceof Error ? err.message : String(err));
                  setCli({ state: "error", message });
                  setError(message);
                });
            }}
          />
        ) : overlay === "onboarding" && scan && writable ? (
          <Onboarding
            scan={scan}
            busy={Boolean(busy)}
            error={error}
            locale={settings?.locale ?? preference}
            onLocale={persistLocale}
            onConfirm={() => {
              if (!writable) {
                refuseWrite();
                return;
              }
              void run(t("busy.onboarding"), async () => {
                const next = await window.dshSpaces.confirmOnboarding();
                setScan(next);
                setOverlay(null);
              });
            }}
          />
        ) : null}
        {overlay === "diagnostics" && target ? <DiagnosticsPanel key={target} name={target} onClose={() => setOverlay(null)} onChanged={refresh} /> : null}
        {overlay === "plugins" ? (
          <PluginDialog
            profiles={profiles}
            selected={pluginSpace ?? selected}
            initialCatalogUrl={settings?.catalogUrl ?? ""}
            pluginPending={queue.pending}
            pluginCurrent={queue.current}
            onClose={() => {
              setPluginSpace(null);
              setOverlay(null);
            }}
            onSaveCatalogUrl={async (url) => {
              if (!settings || !writable) return;
              const saved = await window.dshSpaces.saveSettings({ ...settings, catalogUrl: url });
              setSettings(saved);
            }}
            onRestart={(name) => {
              if (!writable) {
                refuseWrite();
                return;
              }
              void run(
                t("busy.restart", { name }),
                () => window.dshSpaces.restartProfile(name),
                name,
              );
            }}
          />
        ) : null}
        {overlay === "create" ? (
          <CreateWizard
            busy={Boolean(busy)}
            error={error}
            progress={progress}
            onCancel={() => setOverlay(null)}
            onSubmit={(name, displayName, icon) => {
              if (!writable) {
                refuseWrite();
                return;
              }
              void run(t("busy.create", { name }), async () => {
                await window.dshSpaces.createProfile(name, displayName, icon);
                setOverlay(null);
              });
            }}
          />
        ) : null}
        {overlay === "settings" && settings ? (
          <SettingsDialog
            initial={settings}
            dshHome={dshHome}
            initialTab={runtimeFault ? "runtime" : "general"}
            onQuit={() => void run(t("tray.quit"), () => window.dshSpaces.quitApp())}
            onCancel={() => setOverlay(null)}
            onMaintenanceChanged={refreshAfterMaintenance}
            onSave={(next) => {
              if (!writable) {
                refuseWrite();
                return;
              }
              void run(t("busy.saveSettings"), async () => {
                const saved = await window.dshSpaces.saveSettings(next);
                setSettings(saved);
                setPreference(saved.locale);
                setThemePreference(saved.theme);
                setOverlay(null);
              });
            }}
          />
        ) : null}
        {overlay === "rename" && overlayProfile ? (
          <RenameDialog
            profile={overlayProfile}
            onCancel={() => setOverlay(null)}
            onSave={(displayName) => {
              if (!writable) {
                refuseWrite();
                return;
              }
              void run(t("busy.rename"), async () => {
                await window.dshSpaces.updateMeta(overlayProfile.name, { displayName });
                setOverlay(null);
              });
            }}
          />
        ) : null}
        {overlay === "icon" && overlayProfile ? (
          <IconDialog
            profile={overlayProfile}
            onCancel={() => setOverlay(null)}
            onSave={(icon: string) => {
              if (!writable) {
                refuseWrite();
                return;
              }
              void run(t("busy.icon"), async () => {
                await window.dshSpaces.updateMeta(overlayProfile.name, { icon });
                setOverlay(null);
              });
            }}
          />
        ) : null}
        {overlay === "delete" && overlayProfile ? (
          <DeleteDialog
            profile={overlayProfile}
            onCancel={() => setOverlay(null)}
            onConfirm={(deleteOfficial) => {
              if (!writable) {
                refuseWrite();
                return;
              }
              void run(t("busy.delete"), async () => {
                await window.dshSpaces.deleteProfile(overlayProfile.name, { deleteOfficial });
                if (selected === overlayProfile.name) setSelected(null);
                setOverlay(null);
              });
            }}
          />
        ) : null}
        {!writable && scan && !scan.onboarded && !overlay && !cliBusy ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-8">
            <div className="ui-card w-[420px] max-w-full p-5">
              <h2 className="text-lg font-semibold">
                {locale === "zh" ? "只读概览" : "Read-only overview"}
              </h2>
              <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
                {locale === "zh"
                  ? "此 Home 尚未完成引导。当前为只读，不会写入空间配置。"
                  : "This Home has not been onboarded. The desktop is read-only and will not write space setup."}
              </p>
              <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto text-sm">
                {scan.profiles.map((profile) => (
                  <li key={profile.name} style={{ color: "var(--text-muted)" }}>
                    {profile.name}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        </main>
      </div>
    </div>
  );
}
