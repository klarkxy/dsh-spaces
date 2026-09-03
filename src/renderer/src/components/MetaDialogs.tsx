import { useState } from "react";
import type { PresetIcon, ProfileRecord } from "@shared/types";
import { useI18n } from "../i18n";
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
  const { t } = useI18n();
  const [value, setValue] = useState(profile.meta.displayName);
  return (
    <Overlay onBackdrop={onCancel}>
      <Card className="w-[360px]">
        <h2 className="text-lg font-semibold">{t("rename.title")}</h2>
        <p className="faint mt-1 text-sm">{t("rename.folderStays", { name: profile.name })}</p>
        <input
          autoFocus
          className="field mt-4"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost rounded px-3 py-1.5 text-sm" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-primary rounded px-3 py-1.5 text-sm"
            onClick={() => onSave(value.trim() || profile.name)}
          >
            {t("common.save")}
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
  const { t } = useI18n();
  const [icon, setIcon] = useState<PresetIcon | undefined>(
    PRESET_ICONS.includes(profile.meta.icon as PresetIcon) ? (profile.meta.icon as PresetIcon) : undefined,
  );
  return (
    <Overlay onBackdrop={onCancel}>
      <Card className="w-[360px]">
        <h2 className="text-lg font-semibold">{t("icon.title")}</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-lg"
            style={{ background: !icon ? "var(--accent)" : "var(--bg-icon)", color: !icon ? "#fff" : "var(--text)" }}
            onClick={() => setIcon(undefined)}
          >
            {profile.name.slice(0, 1).toUpperCase()}
          </button>
          {PRESET_ICONS.map((id) => (
            <button
              key={id}
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-lg"
              style={{
                background: icon === id ? "var(--accent)" : "var(--bg-icon)",
                color: icon === id ? "#fff" : "var(--text)",
              }}
              onClick={() => setIcon(id)}
            >
              <SpaceGlyph icon={id} name={id} className="h-4 w-4" />
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost rounded px-3 py-1.5 text-sm" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-primary rounded px-3 py-1.5 text-sm"
            onClick={() => onSave(icon)}
          >
            {t("common.save")}
          </button>
        </div>
      </Card>
    </Overlay>
  );
}
