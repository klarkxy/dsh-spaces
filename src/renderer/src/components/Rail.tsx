import { motion } from "motion/react";
import { Puzzle, Settings, Plus } from "lucide-react";
import { useState } from "react";
import type { ProfileRecord, ProfileStatus } from "@shared/types";
import { useI18n } from "../i18n";
import { isUploadedSpaceIcon } from "@shared/space-icon";
import { SpaceGlyph } from "./icons";

function statusClass(status: ProfileStatus): string {
  switch (status) {
    case "running":
      return "ui-status ui-status-running";
    case "starting":
      return "ui-status ui-status-starting";
    case "crashed":
      return "ui-status ui-status-crashed";
    default:
      return "ui-status ui-status-idle";
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
  const uploaded = isUploadedSpaceIcon(profile.meta.icon);
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
      className="relative flex size-12 items-center justify-center"
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
        className={`flex size-12 items-center justify-center overflow-hidden ${
          selected ? "rounded-[16px]" : "rounded-full"
        }`}
        style={
          uploaded
            ? {
                background: "var(--bg-icon)",
                boxShadow: selected ? "0 0 0 2px var(--accent), 0 0 18px var(--accent-glow)" : "none",
              }
            : {
                background: selected ? "var(--accent)" : "var(--bg-icon)",
                color: selected ? "var(--accent-ink)" : "var(--text)",
                boxShadow: selected ? "0 0 18px var(--accent-glow)" : "none",
              }
        }
        whileHover={{ borderRadius: 16 }}
        transition={{ type: "spring", stiffness: 380, damping: 24 }}
      >
        <SpaceGlyph icon={profile.meta.icon} className={uploaded ? "h-full w-full" : "h-6 w-6"} />
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
  onPlugins,
  onMenu,
  onReorder,
  onHover,
}: {
  profiles: ProfileRecord[];
  selected: string | null;
  onSelect: (name: string) => void;
  onCreate: () => void;
  onSettings: () => void;
  onPlugins: () => void;
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
      style={{
        background: "var(--bg-rail)",
        borderColor: "var(--border)",
        boxShadow: "inset -1px 0 12px var(--accent-glow)",
      }}
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
        className="ui-rail-add flex size-12 items-center justify-center rounded-full transition hover:rounded-[16px]"
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
        className="ui-rail-tool flex size-10 items-center justify-center rounded-full"
        onClick={onPlugins}
        aria-label={t("rail.plugins")}
        onMouseEnter={(event) =>
          onHover(
            {
              name: "plugins",
              kind: "workbench",
              path: "",
              hasWebApp: true,
              needsConversion: false,
              meta: { displayName: t("rail.plugins"), order: 0 },
              status: "stopped",
            },
            event.currentTarget.getBoundingClientRect().top,
          )
        }
        onMouseLeave={() => onHover(null, 0)}
      >
        <Puzzle className="h-5 w-5" />
      </button>
      <button
        type="button"
        aria-label={t("rail.settings")}
        onClick={onSettings}
        className="ui-rail-tool mb-1 flex size-10 items-center justify-center rounded-full"
        onMouseEnter={(event) =>
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
          )
        }
        onMouseLeave={() => onHover(null, 0)}
      >
        <Settings className="h-5 w-5" />
      </button>
    </aside>
  );
}
