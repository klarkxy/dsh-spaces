import { useEffect, useState } from "react";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES, type CreateProgress, type PresetIcon } from "@shared/types";
import { useI18n } from "../i18n";
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
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [icon, setIcon] = useState<PresetIcon | undefined>();
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    setLocalError("");
  }, [name]);

  const stepLabel = (step: CreateProgress["step"]) => {
    switch (step) {
      case "validate":
        return t("create.stepValidate");
      case "plugin":
        return t("create.stepPlugin");
      case "patch":
        return t("create.stepPatch");
      case "verify":
        return t("create.stepVerify");
      case "meta":
        return t("create.stepMeta");
    }
  };

  const submit = () => {
    const trimmed = name.trim().toLowerCase();
    if (!PROFILE_NAME_RE.test(trimmed)) {
      setLocalError(t("create.nameInvalid"));
      return;
    }
    if ((RESERVED_PROFILE_NAMES as readonly string[]).includes(trimmed)) {
      setLocalError(t("create.nameReserved", { name: trimmed }));
      return;
    }
    onSubmit(trimmed, displayName.trim() || trimmed, icon);
  };

  return (
    <Overlay onBackdrop={busy ? undefined : onCancel}>
      <Card>
        <h2 className="text-lg font-semibold">{t("create.title")}</h2>
        <p className="muted mt-1 text-sm">{t("create.intro")}</p>
        <label className="label mt-4 block text-xs">{t("create.folderName")}</label>
        <input
          autoFocus
          disabled={busy}
          className="field mt-1"
          placeholder="coding"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <label className="label mt-3 block text-xs">{t("create.displayName")}</label>
        <input
          disabled={busy}
          className="field mt-1"
          placeholder="Coding"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <p className="label mt-3 text-xs">{t("create.icon")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PRESET_ICONS.map((id) => (
            <button
              key={id}
              type="button"
              disabled={busy}
              onClick={() => setIcon(id)}
              className="flex h-9 w-9 items-center justify-center rounded-lg"
              style={{
                background: icon === id ? "var(--accent)" : "var(--bg-icon)",
                color: icon === id ? "#fff" : "var(--text)",
              }}
            >
              <SpaceGlyph icon={id} name={id} className="h-4 w-4" />
            </button>
          ))}
        </div>
        {busy && progress ? (
          <ol className="muted mt-4 space-y-1 text-sm">
            {STEPS.map((step) => {
              const active = progress.step === step;
              const done = STEPS.indexOf(progress.step) > STEPS.indexOf(step);
              return (
                <li
                  key={step}
                  style={{
                    color: active ? "var(--warn)" : done ? "var(--ok)" : "var(--text-faint)",
                  }}
                >
                  {done ? "✓" : active ? "●" : "○"} {stepLabel(step)}
                  {active ? ` — ${progress.message}` : ""}
                </li>
              );
            })}
          </ol>
        ) : null}
        {(localError || error) && <p className="mt-3 text-sm text-red-500">{localError || error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="btn-ghost rounded px-3 py-1.5 text-sm"
            onClick={onCancel}
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-primary rounded px-3 py-1.5 text-sm"
            onClick={submit}
            disabled={busy}
          >
            {busy ? t("common.working") : t("common.create")}
          </button>
        </div>
      </Card>
    </Overlay>
  );
}
