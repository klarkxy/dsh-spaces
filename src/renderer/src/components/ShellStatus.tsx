import type { DesktopShellPublicState } from "@shared/desktop-shell";
import { useI18n } from "../i18n";
import { Card, Overlay } from "./Overlay";

export function ShellStatus({ state }: { state: DesktopShellPublicState }) {
  const { t } = useI18n();
  const failed = state.phase === "unavailable" || state.phase === "blocked" || state.phase === "workbench-error";
  const title =
    state.phase === "connecting"
      ? t("shell.connecting")
      : state.phase === "workbench-error"
        ? t("shell.workbenchError")
        : state.phase === "blocked"
          ? t("shell.blocked")
          : state.phase === "unavailable"
            ? t("shell.unavailable")
            : t("cli.brand");
  const body =
    state.phase === "tools-ready"
      ? t("shell.startIntro")
      : state.phase === "connecting"
        ? t("shell.connecting")
        : t("shell.prepareHint");
  const details = [state.workbenchError, ...state.reasons].filter((row): row is string => Boolean(row)).join("\n");
  return (
    <Overlay>
      <Card className="w-[480px]">
        <p className="ui-kicker">{t("cli.brand")}</p>
        <h2 className="mt-1 text-xl font-semibold">{title}</h2>
        <p className="muted mt-2 text-sm">{body}</p>
        {details ? (
          <p
            className={`mt-3 rounded-lg px-3 py-2 text-sm leading-6 ${failed ? "bg-red-500/10 text-red-500" : "muted"}`}
            style={failed ? undefined : { background: "var(--bg-input)" }}
          >
            {details}
          </p>
        ) : null}
        {failed && details ? (
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(details)}
            className="btn-ghost mt-4 w-full rounded-lg py-2 text-sm"
          >
            {t("shell.copyLogs")}
          </button>
        ) : null}
      </Card>
    </Overlay>
  );
}
