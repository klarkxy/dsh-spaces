import { useEffect, useRef, useState } from "react";
import type { DesktopShellPublicState } from "@shared/desktop-shell";
import type { LocalePreference, PackageSource } from "@shared/types";
import { visibleError } from "@shared/i18n";
import { CliSetup } from "./components/CliSetup";
import { ShellStatus } from "./components/ShellStatus";
import { TitleBar } from "./components/TitleBar";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";

export default function App() {
  const { t, preference, setPreference } = useI18n();
  const { setPreference: setThemePreference } = useTheme();
  const [state, setState] = useState<DesktopShellPublicState | null>(null);
  const [error, setError] = useState("");
  const aliveRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const apply = (next: DesktopShellPublicState) => {
      if (cancelled || !aliveRef.current) return;
      if (next.seq < seqRef.current) return;
      seqRef.current = next.seq;
      setState(next);
      setPreference(next.locale);
      setThemePreference(next.theme);
      if (next.workbenchError) setError(next.workbenchError);
    };
    void window.dshSpaces.getState().then(apply).catch((err: unknown) => {
      if (cancelled || !aliveRef.current) return;
      setError(visibleError(err instanceof Error ? err.message : String(err)));
    });
    const off = window.dshSpaces.onState(apply);
    return () => {
      cancelled = true;
      off();
    };
  }, [setPreference, setThemePreference]);

  const busy =
    state?.phase === "connecting"
      ? t("shell.connecting")
      : state?.cli.state === "installing"
        ? t("cli.titleInstalling")
        : undefined;
  const showSetup = state?.phase === "needs-tools";
  const showStatus =
    state !== null &&
    (state.phase === "tools-ready" ||
      state.phase === "connecting" ||
      state.phase === "unavailable" ||
      state.phase === "blocked" ||
      state.phase === "workbench-error");

  const onLocale = (locale: LocalePreference) => {
    setPreference(locale);
    void window.dshSpaces.setPreference({ locale }).catch((err: unknown) => {
      if (!aliveRef.current) return;
      setError(visibleError(err instanceof Error ? err.message : String(err)));
    });
  };

  const onPackageSource = (packageSource: PackageSource) => {
    void window.dshSpaces.setPreference({ packageSource }).catch((err: unknown) => {
      if (!aliveRef.current) return;
      setError(visibleError(err instanceof Error ? err.message : String(err)));
    });
  };

  const onInstall = (packageSource: PackageSource) => {
    void (async () => {
      if (aliveRef.current) setError("");
      await window.dshSpaces.setPreference({ packageSource });
      await window.dshSpaces.prepareEnvironment();
    })().catch((err: unknown) => {
      if (!aliveRef.current) return;
      setError(visibleError(err instanceof Error ? err.message : String(err)));
    });
  };

  const onPrepare = () => {
    void window.dshSpaces.prepareEnvironment().catch((err: unknown) => {
      if (!aliveRef.current) return;
      setError(visibleError(err instanceof Error ? err.message : String(err)));
    });
  };

  const onStart = () => {
    if (aliveRef.current) setError("");
    void window.dshSpaces.startService().catch((err: unknown) => {
      if (!aliveRef.current) return;
      setError(visibleError(err instanceof Error ? err.message : String(err)));
    });
  };

  return (
    <div className="relative flex h-full flex-col">
      <TitleBar
        busy={busy}
        error={error || undefined}
        onDismissError={() => setError("")}
        canPrepare={state?.canPrepare === true}
        canStart={state?.canStart === true}
        onPrepare={onPrepare}
        onStart={onStart}
      />
      <main className="relative min-h-0 flex-1 overflow-hidden" style={{ background: "var(--bg-main)" }}>
        <div className="ui-grid" aria-hidden />
        {showSetup && state ? (
          <CliSetup
            status={state.cli}
            packageSource={state.packageSource}
            locale={preference}
            onPackageSource={onPackageSource}
            onLocale={onLocale}
            onInstall={onInstall}
          />
        ) : showStatus && state ? (
          <ShellStatus state={state} />
        ) : null}
      </main>
    </div>
  );
}
