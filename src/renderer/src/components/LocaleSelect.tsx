import type { LocalePreference } from "@shared/types";
import { useI18n } from "../i18n";

export function LocaleSelect({
  value,
  onChange,
  disabled,
}: {
  value: LocalePreference;
  onChange: (value: LocalePreference) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <label className="block text-xs" style={{ color: "var(--text-label)" }}>
      {t("settings.language")}
      <select
        className="field mt-1"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as LocalePreference)}
      >
        <option value="system">{t("settings.languageSystem")}</option>
        <option value="zh">{t("settings.languageZh")}</option>
        <option value="en">{t("settings.languageEn")}</option>
      </select>
    </label>
  );
}
