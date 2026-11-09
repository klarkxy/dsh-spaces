import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SettingsForms, type SettingsDescribeOptions } from "@deepseek-ai/dsh-settings";
import { readWelcomeNotice } from "../../../src/adapters/node/home/welcome-notice";
import type {} from "@deepseek-ai/dsh-app-boot";

/** Keep native forms and the native editor, but never import another profile's legacy settings. */
export default class SpaceSettingsForms extends SettingsForms {
  private noticeHome?: string;
  override describe(options?: SettingsDescribeOptions) {
    const rows = super.describe(options);
    const version = this.noticeHome && readWelcomeNotice(this.noticeHome);
    if (!version) return rows;
    return rows.map(row => {
      if (row.ns !== "ui-settings-general" || !row.value || typeof row.value !== "object") return row;
      const value = row.value as Record<string, unknown>;
      // An existing per-profile acknowledgement wins. The official UI still
      // compares the exact notice version and shows all future versions.
      return value.welcomeNoticeVersion ? row : { ...row, value: { ...value, welcomeNoticeVersion: version } };
    });
  }
  constructor(ctx: Context) {
    const profile = ctx.profileContext;
    if (profile.name === "web") {
      super(ctx);
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(profile.name)
      || resolve(profile.dir) !== resolve(profile.home, "profiles", profile.name)) {
      throw new Error("Space settings require an independently owned profile directory.");
    }
    const home = join(profile.home, "hub", profile.name);
    // Only SettingsForms gets this context. ConfigEditor still owns the original
    // profile patch; other plugins keep the actual DSH Home.
    super(ctx.extend({ profileContext: { ...profile, home } }));
    this.noticeHome = profile.home;
  }
}
