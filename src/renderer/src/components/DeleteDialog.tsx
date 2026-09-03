import { useState } from "react";
import type { ProfileRecord } from "@shared/types";
import { useI18n } from "../i18n";
import { Card, Overlay } from "./Overlay";

export function DeleteDialog({
  profile,
  onCancel,
  onConfirm,
}: {
  profile: ProfileRecord;
  onCancel: () => void;
  onConfirm: (deleteOfficial: boolean) => void;
}) {
  const { t } = useI18n();
  const [deleteOfficial, setDeleteOfficial] = useState(false);
  return (
    <Overlay onBackdrop={onCancel}>
      <Card>
        <h2 className="text-lg font-semibold">
          {t("delete.title", { name: profile.meta.displayName })}
        </h2>
        <p className="muted mt-2 text-sm">{t("delete.will")}</p>
        <ul className="muted mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>{t("delete.stop")}</li>
          <li>{t("delete.removeRail")}</li>
          <li>{t("delete.deleteData", { name: profile.name })}</li>
        </ul>
        <label className="muted mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={deleteOfficial}
            onChange={(event) => setDeleteOfficial(event.target.checked)}
          />
          <span>{t("delete.alsoOfficial")}</span>
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost rounded px-3 py-1.5 text-sm" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm text-white"
            style={{ background: "var(--danger)" }}
            onClick={() => onConfirm(deleteOfficial)}
          >
            {t("common.delete")}
          </button>
        </div>
      </Card>
    </Overlay>
  );
}
