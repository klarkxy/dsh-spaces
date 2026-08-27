import { useEffect, useState } from "react";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES, type CreateProgress, type PresetIcon } from "@shared/types";
import { PRESET_ICONS, SpaceGlyph } from "./icons";
import { Card, Overlay } from "./Overlay";

const STEPS: CreateProgress["step"][] = ["validate", "plugin", "patch", "verify", "meta"];

export function CreateWizard({
  busy,
  error,
  progress,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: string;
  progress: CreateProgress | null;
  onCancel: () => void;
  onSubmit: (name: string, displayName: string, icon?: PresetIcon) => void;
}) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [icon, setIcon] = useState<PresetIcon | undefined>();
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    setLocalError("");
  }, [name]);

  const submit = () => {
    const trimmed = name.trim().toLowerCase();
    if (!PROFILE_NAME_RE.test(trimmed)) {
      setLocalError("Use lowercase letters, digits, and hyphens (max 39).");
      return;
    }
    if ((RESERVED_PROFILE_NAMES as readonly string[]).includes(trimmed)) {
      setLocalError(`${trimmed} is reserved`);
      return;
    }
    onSubmit(trimmed, displayName.trim() || trimmed, icon);
  };

  return (
    <Overlay onBackdrop={busy ? undefined : onCancel}>
      <Card>
        <h2 className="text-lg font-semibold">New space</h2>
        <p className="mt-1 text-sm text-white/60">Creates a workbench with isolated sessions and storages.</p>
        <label className="mt-4 block text-xs text-white/50">Folder name</label>
        <input
          autoFocus
          disabled={busy}
          className="mt-1 w-full rounded bg-black/40 px-3 py-2 text-sm outline-none"
          placeholder="coding"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <label className="mt-3 block text-xs text-white/50">Display name</label>
        <input
          disabled={busy}
          className="mt-1 w-full rounded bg-black/40 px-3 py-2 text-sm outline-none"
          placeholder="Coding"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <p className="mt-3 text-xs text-white/50">Icon</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PRESET_ICONS.map((id) => (
            <button
              key={id}
              type="button"
              disabled={busy}
              onClick={() => setIcon(id)}
              className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                icon === id ? "bg-[#5865f2]" : "bg-black/30 hover:bg-white/10"
              }`}
            >
              <SpaceGlyph icon={id} name={id} className="h-4 w-4" />
            </button>
          ))}
        </div>
        {busy && progress ? (
          <ol className="mt-4 space-y-1 text-sm text-white/70">
            {STEPS.map((step) => {
              const active = progress.step === step;
              const done = STEPS.indexOf(progress.step) > STEPS.indexOf(step);
              return (
                <li key={step} className={active ? "text-amber-200" : done ? "text-emerald-300" : "text-white/35"}>
                  {done ? "✓" : active ? "●" : "○"} {step}
                  {active ? ` — ${progress.message}` : ""}
                </li>
              );
            })}
          </ol>
        ) : null}
        {(localError || error) && <p className="mt-3 text-sm text-red-400">{localError || error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm text-white/70 hover:bg-white/10"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-[#5865f2] px-3 py-1.5 text-sm"
            onClick={submit}
            disabled={busy}
          >
            {busy ? "Working…" : "Create"}
          </button>
        </div>
      </Card>
    </Overlay>
  );
}
