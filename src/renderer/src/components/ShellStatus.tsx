import type { DesktopShellPublicState, DesktopStartupStage } from "@shared/desktop-shell";
import { DESKTOP_STARTUP_STAGE_PROGRESS } from "@shared/desktop-shell";
import type { MessageKey } from "@shared/i18n";
import { useI18n } from "../i18n";
import { Card, Overlay } from "./Overlay";

const STAGE_LABEL_KEY: Record<DesktopStartupStage, MessageKey> = {
  attach: "shell.stage.attach",
  prepare: "shell.stage.prepare",
  launch: "shell.stage.launch",
  connect: "shell.stage.connect",
  "load-workbench": "shell.stage.load-workbench",
  ready: "shell.stage.ready",
};

export function ShellStatus({ state, onStart }: {
  state: DesktopShellPublicState;
  onStart?: () => void;
}) {
  const { t } = useI18n();
  const failed = state.phase === "unavailable" || state.phase === "blocked" || state.phase === "workbench-error";
  const stage = state.phase === "connecting" ? state.startupStage ?? null : null;
  const percent = stage ? DESKTOP_STARTUP_STAGE_PROGRESS[stage] : null;
  const title =
    stage
      ? t(STAGE_LABEL_KEY[stage])
      : state.phase === "connecting"
        ? t("shell.connecting")
        : state.phase === "workbench-error"
          ? t("shell.workbenchError")
          : state.phase === "blocked"
            ? t("shell.blocked")
            : state.phase === "unavailable"
              ? t("shell.unavailable")
              : t("shell.stopped");
  const body =
    stage
      ? null
      : state.phase === "tools-ready"
        ? t("shell.startIntro")
        : state.phase === "connecting"
          ? t("shell.connecting")
          : null;
  const details = [state.workbenchError, ...state.reasons].filter((row): row is string => Boolean(row)).join("\n");
  return (
    <Overlay>
      <Card className="w-[480px]">
        <p className="ui-kicker">{t("cli.brand")}</p>
        <h2 className="mt-1 text-xl font-semibold">{title}</h2>
        {body ? <p className="muted mt-2 text-sm">{body}</p> : null}
        {stage && percent !== null ? (
          <div className="mt-4">
            <div
              className="h-1.5 overflow-hidden rounded-full"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              style={{ background: "var(--bg-input)" }}
            >
              <div
                className="h-full rounded-full transition-[width] duration-300 ease-out"
                style={{ width: `${percent}%`, background: "var(--accent)" }}
              />
            </div>
            <p className="muted mt-2 text-right text-sm">{percent}%</p>
          </div>
        ) : null}
        {details ? (
          <p
            className={`mt-3 rounded-lg px-3 py-2 text-sm leading-6 ${failed ? "bg-red-500/10 text-red-500" : "muted"}`}
            style={failed ? undefined : { background: "var(--bg-input)" }}
          >
            {details}
          </p>
        ) : null}
        {state.phase === "tools-ready" && state.canStart && onStart ? (
          <button
            type="button"
            onClick={onStart}
            className="btn-primary mt-4 w-full rounded-lg py-2 text-sm font-medium"
          >
            {t("shell.startService")}
          </button>
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
