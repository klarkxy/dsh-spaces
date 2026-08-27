import { useState } from "react";
import type { PresetIcon, ProfileRecord } from "@shared/types";
import { PRESET_ICONS, SpaceGlyph } from "./icons";
import { Card, Overlay } from "./Overlay";

export function RenameDialog({
  profile,
  onCancel,
  onSave,
}: {
  profile: ProfileRecord;
  onCancel: () => void;
  onSave: (displayName: string) => void;
}) {
  const [value, setValue] = useState(profile.meta.displayName);
  return (
    <Overlay onBackdrop={onCancel}>
      <Card className="w-[360px]">
        <h2 className="text-lg font-semibold">Rename</h2>
        <p className="mt-1 text-sm text-white/50">Official folder stays {profile.name}.</p>
        <input
          autoFocus
          className="mt-4 w-full rounded bg-black/40 px-3 py-2 text-sm"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded px-3 py-1.5 text-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-[#5865f2] px-3 py-1.5 text-sm"
            onClick={() => onSave(value.trim() || profile.name)}
          >
            Save
          </button>
        </div>
      </Card>
    </Overlay>
  );
}

export function IconDialog({
  profile,
  onCancel,
  onSave,
}: {
  profile: ProfileRecord;
  onCancel: () => void;
  onSave: (icon: PresetIcon | undefined) => void;
}) {
  const [icon, setIcon] = useState<PresetIcon | undefined>(
    PRESET_ICONS.includes(profile.meta.icon as PresetIcon) ? (profile.meta.icon as PresetIcon) : undefined,
  );
  return (
    <Overlay onBackdrop={onCancel}>
      <Card className="w-[360px]">
        <h2 className="text-lg font-semibold">Icon</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={`flex h-9 w-9 items-center justify-center rounded-lg ${
              !icon ? "bg-[#5865f2]" : "bg-black/30"
            }`}
            onClick={() => setIcon(undefined)}
          >
            {profile.name.slice(0, 1).toUpperCase()}
          </button>
          {PRESET_ICONS.map((id) => (
            <button
              key={id}
              type="button"
              className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                icon === id ? "bg-[#5865f2]" : "bg-black/30 hover:bg-white/10"
              }`}
              onClick={() => setIcon(id)}
            >
              <SpaceGlyph icon={id} name={id} className="h-4 w-4" />
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded px-3 py-1.5 text-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-[#5865f2] px-3 py-1.5 text-sm"
            onClick={() => onSave(icon)}
          >
            Save
          </button>
        </div>
      </Card>
    </Overlay>
  );
}
