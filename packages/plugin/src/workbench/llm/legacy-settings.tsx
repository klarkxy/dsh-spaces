import React, { useState, type ReactElement, type ReactNode } from "react";
import { t, type WorkbenchLocale } from "../i18n";

/** Load compatibility controls on demand; folding them keeps unsaved edits. */
export function LegacyConnectionSettings({ locale, children }: {
  locale: WorkbenchLocale;
  children: ReactNode;
}): ReactElement {
  const [activated, setActivated] = useState(false);
  return (
    <details data-llm-legacy-settings="true" onToggle={(event) => {
      if (event.currentTarget.open) setActivated(true);
    }}>
      <summary>{t(locale, "llm.legacySettings")}</summary>
      <p className="dsh-wb-muted">{t(locale, "llm.legacyHint")}</p>
      {activated ? children : null}
    </details>
  );
}
