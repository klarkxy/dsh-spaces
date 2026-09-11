import type { CliEnsureStatus, LocalePreference, PackageSource } from "@shared/types";
import { useI18n } from "../i18n";
import { LocaleSelect } from "./LocaleSelect";
import { Card, Overlay } from "./Overlay";

export function CliSetup({
  status,
  packageSource,
  locale,
  onPackageSource,
  onLocale,
  onInstall,
}: {
  status: CliEnsureStatus;
  packageSource: PackageSource;
  locale: LocalePreference;
  onPackageSource: (source: PackageSource) => void;
  onLocale: (locale: LocalePreference) => void;
  onInstall: (source: PackageSource) => void;
}) {
  const { t } = useI18n();
  const failed = status.state === "error";
  const busy = status.state === "installing" || status.state === "checking";
  const waiting = status.state === "idle" || failed;
  const title = failed
    ? t("cli.titleFailed")
    : busy
      ? t("cli.titleInstalling")
      : t("cli.titleSetup");
  const stepLabel =
    status.step === "node"
      ? t("cli.stepNode")
      : status.step === "pnpm"
        ? t("cli.stepPnpm")
        : status.step === "cli"
          ? t("cli.stepCli")
          : "";
  const fallbackMessage = failed
    ? t("cli.installFailed")
    : status.state === "idle"
      ? t("cli.idleMessage")
      : t("cli.readyWhen");
  return (
    <Overlay>
      <Card className="w-[480px]">
        <p className="ui-kicker">{t("cli.brand")}</p>
        <h2 className="mt-1 text-xl font-semibold">{title}</h2>
        <p className="muted mt-2 text-sm">{t("cli.intro")}</p>
        <div className="mt-4">
          <LocaleSelect value={locale} onChange={onLocale} disabled={busy} />
        </div>
        <label className="label mt-4 block text-xs">{t("cli.packageSource")}</label>
        <select
          className="field mt-1"
          value={packageSource}
          disabled={busy}
          onChange={(event) => onPackageSource(event.target.value as PackageSource)}
        >
          <option value="china">{t("cli.sourceChina")}</option>
          <option value="official">{t("cli.sourceOfficial")}</option>
        </select>
        <p className="faint mt-1 text-xs">
          {packageSource === "china" ? t("cli.hintChina") : t("cli.hintOfficial")}
        </p>
        {status.step ? (
          <p className="ui-kicker mt-3">
            {t("cli.step", { step: stepLabel })}
          </p>
        ) : null}
        <p
          className={`mt-3 rounded-lg px-3 py-2 text-sm leading-6 ${failed ? "bg-red-500/10 text-red-500" : "muted"}`}
          style={failed ? undefined : { background: "var(--bg-input)" }}
        >
          {status.message || fallbackMessage}
        </p>
        {waiting ? (
          <button
            type="button"
            onClick={() => onInstall(packageSource)}
            className="btn-primary mt-4 w-full rounded-lg py-2 text-sm font-medium"
          >
            {failed ? t("common.retry") : t("cli.install")}
          </button>
        ) : null}
      </Card>
    </Overlay>
  );
}
