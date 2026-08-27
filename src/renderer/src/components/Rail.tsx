import { motion } from "motion/react";
import { Settings, Plus } from "lucide-react";
import { useState } from "react";
import type { ProfileRecord, ProfileStatus } from "@shared/types";
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
          className="absolute left-[-14px] h-10 w-[4px] rounded-r-full bg-white"
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
        />
      ) : (
        <span className="absolute left-[-14px] h-2 w-[4px] rounded-r-full bg-transparent group-hover:bg-white/40" />
      )}
      <motion.span
        className={`flex h-12 w-12 items-center justify-center bg-[#313338] text-white ${
          selected ? "rounded-[16px] bg-[#5865f2]" : "rounded-full"
        }`}
        whileHover={{ borderRadius: 16 }}
        transition={{ type: "spring", stiffness: 380, damping: 24 }}
      >
        <SpaceGlyph icon={profile.meta.icon} name={profile.meta.displayName} />
      </motion.span>
      <span
        className={`absolute right-0 bottom-0 h-3 w-3 rounded-full border-2 border-[#111214] ${statusClass(profile.status)}`}
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
  const root = profiles.filter((p) => p.kind === "root");
  const benches = profiles.filter((p) => p.kind === "workbench");
  const [dragging, setDragging] = useState<string | null>(null);

  return (
    <aside className="z-10 flex h-full w-[72px] flex-col items-center gap-2 border-r border-white/10 bg-[#111214] py-3">
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
      {benches.length > 0 ? <div className="my-1 h-0.5 w-8 rounded bg-white/15" /> : null}
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
        onClick={onCreate}
        className="flex h-12 w-12 items-center justify-center rounded-full bg-[#313338] text-emerald-400 transition hover:rounded-[16px] hover:bg-emerald-500 hover:text-white"
        onMouseEnter={(event) =>
          onHover(
            {
              name: "+",
              kind: "workbench",
              path: "",
              hasWebApp: true,
              needsConversion: false,
              meta: { displayName: "New space", order: 0 },
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
        onClick={onSettings}
        className="mb-1 flex h-10 w-10 items-center justify-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white"
        onMouseEnter={(event) =>
          onHover(
            {
              name: "settings",
              kind: "workbench",
              path: "",
              hasWebApp: true,
              needsConversion: false,
              meta: { displayName: "Settings", order: 0 },
              status: "stopped",
            },
            event.currentTarget.getBoundingClientRect().top,
          )
        }
        onMouseLeave={() => onHover(null, 0)}
      >
        <Settings className="h-5 w-5" />
      </button>
    </aside>
  );
}
