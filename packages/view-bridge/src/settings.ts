import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SettingsForms } from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-app-boot";

/** Keep native forms and the native editor, but never import another profile's legacy settings. */
export default class SpaceSettingsForms extends SettingsForms {
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
    if (existsSync(join(home, "settings.yaml"))) {
      throw new Error("Legacy space settings have not completed migration to the profile configuration.");
    }
    // Only SettingsForms gets this context. ConfigEditor still owns the original
    // profile patch; other plugins keep the actual DSH Home.
    super(ctx.extend({ profileContext: { ...profile, home } }));
  }
}
