import { useEffect, useState } from "react";
import type {
  CreateProgress,
  HubSettings,
  OnboardingScan,
  PluginQueueSnapshot,
  PresetIcon,
  ProfileRecord,
} from "@shared/types";
import { CreateWizard } from "./components/CreateWizard";
import { DeleteDialog } from "./components/DeleteDialog";
import { IconDialog, RenameDialog } from "./components/MetaDialogs";
import { Onboarding } from "./components/Onboarding";
import { Rail } from "./components/Rail";
import { SettingsDialog } from "./components/SettingsDialog";

type OverlayKind = "create" | "settings" | "rename" | "icon" | "delete" | "onboarding" | null;

export default function App() {
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [overlay, setOverlay] = useState<OverlayKind>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [scan, setScan] = useState<OnboardingScan | null>(null);
  const [settings, setSettings] = useState<HubSettings | null>(null);
  const [dshHome, setDshHome] = useState("");
  const [progress, setProgress] = useState<CreateProgress | null>(null);
  const [queue, setQueue] = useState<PluginQueueSnapshot>({ pending: 0 });
  const [tip, setTip] = useState<{ text: string; top: number } | null>(null);

  const refresh = async () => {
    const next = await window.dshSpaces.listProfiles();
    setProfiles(next);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
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
        setQueue(snap);
        if (!onboarding.onboarded) setOverlay("onboarding");
        await refresh();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    const offStatus = window.dshSpaces.onStatus(() => {
      void refresh();
    });
    const offProgress = window.dshSpaces.onCreateProgress((payload) => setProgress(payload));
    const offQueue = window.dshSpaces.onPluginQueue((payload) => setQueue(payload));
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
    });
    return () => {
      cancelled = true;
      offStatus();
      offProgress();
      offQueue();
      offUi();
    };
  }, []);

  const overlayOpen = overlay !== null;
  useEffect(() => {
    void window.dshSpaces.setOverlayOpen(overlayOpen);
  }, [overlayOpen]);

  useEffect(() => {
    void window.dshSpaces.setRailGutter(tip ? 188 : 0);
  }, [tip]);

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

  const current = profiles.find((p) => p.name === selected);
  const overlayProfile = profiles.find((p) => p.name === target);

  return (
    <div className="flex h-full">
      <Rail
        profiles={profiles}
        selected={selected}
        onSelect={(name) => {
          setSelected(name);
          void run(`select ${name}`, () => window.dshSpaces.selectProfile(name));
        }}
        onCreate={() => {
          setProgress(null);
          setOverlay("create");
        }}
        onSettings={() => setOverlay("settings")}
        onMenu={(name) => void window.dshSpaces.showProfileMenu(name)}
        onReorder={(names) => void run("reorder", () => window.dshSpaces.reorderProfiles(names))}
        onHover={(profile, top) => {
          if (!profile) setTip(null);
          else setTip({ text: profile.meta.displayName, top });
        }}
      />
      <main className="relative flex-1 bg-[#313338]">
        {tip ? (
          <div
            className="pointer-events-none absolute left-3 z-20 rounded bg-zinc-950 px-3 py-1.5 text-sm shadow-lg"
            style={{ top: Math.max(12, tip.top - 8) }}
          >
            {tip.text}
          </div>
        ) : null}
        {busy ? (
          <p className="pointer-events-none absolute top-3 left-4 z-20 text-sm text-amber-200">{busy}…</p>
        ) : null}
        {queue.pending > 0 && overlay !== "settings" ? (
          <p className="pointer-events-none absolute top-3 right-4 z-20 text-sm text-amber-200">
            Plugin queue {queue.pending}
            {queue.current ? `: ${queue.current}` : ""}
          </p>
        ) : null}
        {error && !overlay ? (
          <p className="pointer-events-none absolute top-10 left-4 z-20 max-w-[480px] text-sm text-red-300">
            {error}
          </p>
        ) : null}
        {current?.status === "crashed" ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <div className="w-[360px] rounded-xl bg-[#2b2d31] p-5">
              <h2 className="text-lg font-semibold">Crashed</h2>
              <p className="mt-2 text-sm text-white/65">{current.lastError || "The profile process stopped."}</p>
              <button
                type="button"
                className="mt-4 rounded bg-[#5865f2] px-3 py-1.5 text-sm"
                onClick={() => void run(`restart ${current.name}`, () => window.dshSpaces.restartProfile(current.name))}
              >
                Restart
              </button>
            </div>
          </div>
        ) : null}
        {overlay === "onboarding" && scan ? (
          <Onboarding
            scan={scan}
            busy={Boolean(busy)}
            error={error}
            onConfirm={() =>
              void run("onboarding", async () => {
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
              void run(`create ${name}`, async () => {
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
            pluginPending={queue.pending}
            pluginCurrent={queue.current}
            onCancel={() => setOverlay(null)}
            onSave={(next) =>
              void run("save settings", async () => {
                const saved = await window.dshSpaces.saveSettings(next);
                setSettings(saved);
                setOverlay(null);
              })
            }
          />
        ) : null}
        {overlay === "rename" && overlayProfile ? (
          <RenameDialog
            profile={overlayProfile}
            onCancel={() => setOverlay(null)}
            onSave={(displayName) =>
              void run("rename", async () => {
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
              void run("icon", async () => {
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
              void run("delete", async () => {
                await window.dshSpaces.deleteProfile(overlayProfile.name, { deleteOfficial });
                if (selected === overlayProfile.name) setSelected(null);
                setOverlay(null);
              })
            }
          />
        ) : null}
      </main>
    </div>
  );
}
