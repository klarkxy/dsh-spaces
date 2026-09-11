import type { LocalePreference, OnboardingScan } from "@shared/types";
import { useI18n } from "../i18n";
import { LocaleSelect } from "./LocaleSelect";
import { Card, Overlay } from "./Overlay";

export function Onboarding({
  scan,
  busy,
  error,
  locale,
  onLocale,
  onConfirm,
}: {
  scan: OnboardingScan;
  busy: boolean;
  error: string;
  locale: LocalePreference;
  onLocale: (locale: LocalePreference) => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const converting = scan.profiles.filter((p) => p.action === "convert-workbench");
  const actionLabel = (action: OnboardingScan["profiles"][number]["action"]) => {
    switch (action) {
      case "adopt-root":
        return t("onboarding.adoptRoot");
      case "convert-workbench":
        return t("onboarding.convertWorkbench");
      case "already-workbench":
        return t("onboarding.alreadyWorkbench");
      case "hide":
        return t("onboarding.hide");
    }
  };
  return (
    <Overlay>
      <Card className="w-[480px]">
        <p className="ui-kicker">{t("cli.brand")}</p>
        <h2 className="mt-1 text-xl font-semibold">{t("onboarding.title")}</h2>
        <div className="mt-4">
          <LocaleSelect value={locale} onChange={onLocale} disabled={busy} />
        </div>
        <p className="muted mt-3 text-sm">
          {t("onboarding.home")} <code>{scan.dshHome}</code>
        </p>
        <ul className="mt-4 max-h-48 space-y-2 overflow-y-auto text-sm">
          {scan.profiles.map((profile) => (
            <li key={profile.name} className="rounded px-3 py-2" style={{ background: "var(--bg-input)" }}>
              <div className="font-medium">{profile.name}</div>
              <div className="muted">{actionLabel(profile.action)}</div>
            </li>
          ))}
        </ul>
        {converting.length > 0 ? (
          <p className="mt-4 rounded-lg bg-amber-500/15 px-3 py-2 text-sm leading-6" style={{ color: "var(--warn)" }}>
            {t("onboarding.notice")}
          </p>
        ) : (
          <p className="muted mt-4 rounded-lg px-3 py-2 text-sm leading-6" style={{ background: "var(--bg-input)" }}>
            {t("onboarding.notice")}
          </p>
        )}
        {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="btn-primary mt-4 w-full rounded-lg py-2 text-sm font-medium disabled:opacity-60"
        >
          {busy ? t("onboarding.converting") : t("onboarding.confirm")}
        </button>
      </Card>
    </Overlay>
  );
}
