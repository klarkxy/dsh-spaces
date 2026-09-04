import { motion } from "motion/react";
import { Settings, Plus } from "lucide-react";
import { useState } from "react";
import type { ProfileRecord, ProfileStatus } from "@shared/types";
import { useI18n } from "../i18n";
import { SpaceGlyph } from "./icons";

function statusClass(status: ProfileStatus): string {
  switch (status) {
    case "running":
      return "bg-emerald-400 animate-pulse";
    case "starting":
      return "bg-amber-400 animate-pulse";
    case "crashed":
      return "bg-red-500";
    default:
      return "bg-zinc-500";
  }
}

function RailButton({
  profile,
  selected,
  onSelect,
  onMenu,
  onHover,
  draggable,
  onDragStart,
  onDrop,
}: {
  profile: ProfileRecord;
  selected: boolean;
  onSelect: () => void;
  onMenu: () => void;
  onHover: (profile: ProfileRecord | null, top: number) => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDrop?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={profile.meta.displayName}
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onDragOver={(event) => {
        if (!draggable) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop?.();
      }}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu();
      }}
      onMouseEnter={(event) => {
        const top = event.currentTarget.getBoundingClientRect().top;
        onHover(profile, top);
      }}
      onMouseLeave={() => onHover(null, 0)}
      className="relative flex h-12 w-12 items-center justify-center"
    >
      {selected ? (
        <motion.span
          layoutId="rail-indicator"
          className="absolute left-[-14px] h-10 w-[4px] rounded-r-full"
          style={{ background: "var(--rail-indicator)" }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
        />
      ) : (
        <span className="absolute left-[-14px] h-2 w-[4px] rounded-r-full bg-transparent" />
      )}
      <motion.span
        className={`flex h-12 w-12 items-center justify-center ${
          selected ? "rounded-[16px] text-white" : "rounded-full"
        }`}
        style={{
          background: selected ? "var(--accent)" : "var(--bg-icon)",
          color: selected ? "#fff" : "var(--text)",
        }}
        whileHover={{ borderRadius: 16 }}
        transition={{ type: "spring", stiffness: 380, damping: 24 }}
      >
        <SpaceGlyph icon={profile.meta.icon} name={profile.meta.displayName} />
      </motion.span>
      <span
        className={`absolute right-0 bottom-0 h-3 w-3 rounded-full border-2 ${statusClass(profile.status)}`}
        style={{ borderColor: "var(--status-border)" }}
      />
    </button>
  );
}

export function Rail({
  profiles,
  selected,
  onSelect,
  onCreate,
  onSettings,
  onMenu,
  onReorder,
  onHover,
}: {
  profiles: ProfileRecord[];
  selected: string | null;
  onSelect: (name: string) => void;
  onCreate: () => void;
  onSettings: () => void;
  onMenu: (name: string) => void;
  onReorder: (names: string[]) => void;
  onHover: (profile: ProfileRecord | null, top: number) => void;
}) {
  const { t } = useI18n();
  const root = profiles.filter((p) => p.kind === "root");
  const benches = profiles.filter((p) => p.kind === "workbench");
  const [dragging, setDragging] = useState<string | null>(null);

  return (
    <aside
      className="z-10 flex h-full w-[72px] flex-col items-center gap-2 border-r py-3"
      style={{ background: "var(--bg-rail)", borderColor: "var(--border)" }}
    >
      {root.map((profile) => (
        <RailButton
          key={profile.name}
          profile={profile}
          selected={selected === profile.name}
          onSelect={() => onSelect(profile.name)}
          onMenu={() => onMenu(profile.name)}
          onHover={onHover}
        />
      ))}
      {benches.length > 0 ? (
        <div className="my-1 h-0.5 w-8 rounded" style={{ background: "var(--border)" }} />
      ) : null}
      <div
        className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto"
        onDragEnd={() => setDragging(null)}
      >
        {benches.map((profile) => (
          <RailButton
            key={profile.name}
            profile={profile}
            selected={selected === profile.name}
            draggable
            onSelect={() => onSelect(profile.name)}
            onMenu={() => onMenu(profile.name)}
            onHover={onHover}
            onDragStart={() => setDragging(profile.name)}
            onDrop={() => {
              if (!dragging || dragging === profile.name) return;
              const names = benches.map((item) => item.name);
              const from = names.indexOf(dragging);
              const to = names.indexOf(profile.name);
              if (from < 0 || to < 0) return;
              names.splice(from, 1);
              names.splice(to, 0, dragging);
              setDragging(null);
              onReorder(names);
            }}
          />
        ))}
      </div>
      <button
        type="button"
        aria-label={t("rail.newSpace")}
        onClick={onCreate}
        className="flex h-12 w-12 items-center justify-center rounded-full text-emerald-500 transition hover:rounded-[16px] hover:bg-emerald-500 hover:text-white"
        style={{ background: "var(--bg-icon)" }}
        onMouseEnter={(event) =>
          onHover(
            {
              name: "+",
              kind: "workbench",
              path: "",
              hasWebApp: true,
              needsConversion: false,
              meta: { displayName: t("rail.newSpace"), order: 0 },
              status: "stopped",
            },
            event.currentTarget.getBoundingClientRect().top,
          )
        }
        onMouseLeave={() => onHover(null, 0)}
      >
        <Plus className="h-6 w-6" />
      </button>
      <button
        type="button"
        aria-label={t("rail.settings")}
        onClick={onSettings}
        className="mb-1 flex h-10 w-10 items-center justify-center rounded-full transition"
        style={{ color: "var(--text-faint)" }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
          onHover(
            {
              name: "settings",
              kind: "workbench",
              path: "",
              hasWebApp: true,
              needsConversion: false,
              meta: { displayName: t("rail.settings"), order: 0 },
              status: "stopped",
            },
            event.currentTarget.getBoundingClientRect().top,
          );
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = "transparent";
          event.currentTarget.style.color = "var(--text-faint)";
          onHover(null, 0);
        }}
      >
        <Settings className="h-5 w-5" />
      </button>
    </aside>
  );
}
