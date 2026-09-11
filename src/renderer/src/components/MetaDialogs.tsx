import { useState } from "react";
import type { ProfileRecord } from "@shared/types";
import { isUploadedSpaceIcon } from "@shared/space-icon";
import { useI18n } from "../i18n";
import { SpaceIconPicker } from "./icons";
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
  onSave: (icon: string) => void;
}) {
  const { t } = useI18n();
  const [icon, setIcon] = useState(
    isUploadedSpaceIcon(profile.meta.icon) ? profile.meta.icon! : "",
  );
  return (
    <Overlay onBackdrop={onCancel}>
      <Card className="w-[360px]">
        <h2 className="text-lg font-semibold">{t("icon.title")}</h2>
        <SpaceIconPicker icon={icon} onChange={setIcon} />
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
