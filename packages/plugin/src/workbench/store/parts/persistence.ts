/**
 * The persistence glue of the workbench client.
 *
 * This part owns what survives a reload: the locale, the theme and the
 * selected space. The code moves unchanged from `workbench/store.ts`.
 */

import type { LocalePreference, ThemePreference } from "../../../../../../src/shared/types";
import type { WorkbenchLocale } from "../../i18n";
import { homeSelectionId, writePersist } from "../../persistence";
import { mapLocale } from "../errors";
import { StatePart } from "./state";

export abstract class PersistencePart extends StatePart {
  setLocale = (locale: WorkbenchLocale): void => {
    this.patch({ locale });
    this.writePersist();
  };

  setTheme = (theme: ThemePreference): void => {
    this.patch({ theme });
    this.writePersist();
  };

  protected writePersist(): void {
    this.persistEmpty = false;
    writePersist(this.env.storage, {
      selectedId: this.ui.selected === "home" ? homeSelectionId() : this.ui.selected,
      locale: this.ui.locale,
      theme: this.ui.theme,
    });
  }

  protected applyClientDefaults(defaults: { locale: LocalePreference; theme: ThemePreference }): void {
    if (this.appliedClientDefaults || !this.persistEmpty) return;
    this.appliedClientDefaults = true;
    this.patch({
      locale: mapLocale(defaults.locale),
      theme: defaults.theme,
    });
    this.writePersist();
  }
}
