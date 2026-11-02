import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import { writeWelcomeNotice } from "../../../../src/adapters/node/home/welcome-notice";
import type { WorkbenchHostRuntime } from "./runtime";

export function shareWelcomeNotice(ctx: Context, runtime: WorkbenchHostRuntime) {
  const identity = runtime.identity;
  if (!identity.confirmed || identity.profileId !== "desktop" || !identity.home || typeof ctx.inject !== "function") return;
  const home = identity.home;
  ctx.inject(["settings"], ready => {
    const copy = () => {
      const value = ready.settings.describe({ redactSecrets: true }).find(row => row.ns === "ui-settings-general")?.value;
      if (value && typeof value === "object") writeWelcomeNotice(home, (value as Record<string, unknown>).welcomeNoticeVersion);
    };
    copy();
    ready.on("settings/document-updated", ns => { if (ns === "ui-settings-general") copy(); });
  });
}
