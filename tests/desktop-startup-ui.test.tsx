import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyAppLocale, t } from "../src/shared/i18n/index.ts";
import type { DesktopShellPhase, DesktopShellPublicState } from "../src/shared/desktop-shell.ts";
import { I18nProvider } from "../src/renderer/src/i18n.tsx";
import { ShellStatus } from "../src/renderer/src/components/ShellStatus.tsx";
import { CliSetup } from "../src/renderer/src/components/CliSetup.tsx";

function state(phase: DesktopShellPhase, patch: Partial<DesktopShellPublicState> = {}): DesktopShellPublicState {
  return {
    seq: 1, phase, serviceStatus: "stopped", reasons: [], workbenchError: null,
    runtime: { node: true, pnpm: true, cli: true }, cli: { state: "ready", message: "" },
    locale: "en", theme: "system", packageSource: "official", canPrepare: false,
    canStart: true, overlay: true, ...patch,
  };
}

function renderStatus(value: DesktopShellPublicState): string {
  return renderToStaticMarkup(<I18nProvider><ShellStatus state={value} onStart={() => {}} /></I18nProvider>);
}

for (const locale of ["en", "zh"] as const) {
  test(`${locale}: a stopped workbench is neutral and has a prominent Start button`, () => {
    applyAppLocale(locale);
    const html = renderStatus(state("tools-ready"));
    assert.ok(html.includes(t("shell.stopped")));
    assert.ok(html.includes(t("shell.startIntro")));
    assert.ok(html.includes(t("shell.startService")));
    assert.match(html, /btn-primary/);
    assert.doesNotMatch(html, /text-red-500|Node|pnpm/);
    assert.ok(!html.includes(t("shell.copyLogs")));
  });

  test(`${locale}: a connecting workbench has no competing Start or install control`, () => {
    applyAppLocale(locale);
    const html = renderStatus(state("connecting", { serviceStatus: "connecting", canStart: false }));
    assert.ok(html.includes(t("shell.connecting")));
    assert.doesNotMatch(html, /btn-primary|text-red-500|Node|pnpm/);
  });

  for (const phase of ["unavailable", "blocked", "workbench-error"] as const) {
    test(`${locale}: ${phase} shows the actual error, not an installation hint or recovery action`, () => {
      applyAppLocale(locale);
      const reason = "The supervisor protocol is not supported.";
      const html = renderStatus(state(phase, { serviceStatus: "unavailable", reasons: [reason] }));
      assert.ok(html.includes(reason));
      assert.ok(html.includes(t("shell.copyLogs")));
      assert.match(html, /text-red-500/);
      assert.doesNotMatch(html, /btn-primary/);
      assert.ok(!html.includes(t("shell.startService")));
      assert.ok(!html.includes(t("shell.prepareHint")));
      assert.doesNotMatch(html, /Node|pnpm/);
    });
  }

  test(`${locale}: setup promises automatic entry only before an installation failure`, () => {
    applyAppLocale(locale);
    const render = (failed: boolean) => renderToStaticMarkup(
      <I18nProvider><CliSetup
        status={{ state: failed ? "error" : "idle", message: failed ? "Download failed" : "" }}
        packageSource="official" locale={locale} onPackageSource={() => {}}
        onLocale={() => {}} onInstall={() => {}}
      /></I18nProvider>,
    );
    assert.ok(render(false).includes(t("shell.prepareHint")));
    const failure = render(true);
    assert.ok(!failure.includes(t("shell.prepareHint")));
    assert.ok(failure.includes("Download failed"));
    assert.doesNotMatch(failure, /btn-primary/);
  });
}

test("a stopped card cannot start when the main process has not permitted it", () => {
  applyAppLocale("en");
  const html = renderStatus(state("tools-ready", { canStart: false }));
  assert.doesNotMatch(html, /btn-primary/);
});
