import React, { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import type { SpacesControlApi } from "../../../../src/shared/spaces-control";
import { MotionRoot } from "../../../../src/shared/ui/motion";
import { SpacesPanelView } from "./components";
import { inferSpacesLocale, type SpacesLocale } from "./i18n";
import { SpacesPanelStore } from "./state";

/**
 * Main-panel occupant registered under the `dsh-spaces` key: binds the
 * framework-free store to React and kicks off the first overview load.
 * Initial render (including SSR) shows the loading state; the load runs in
 * an effect, never during render.
 *
 * The panel root carries its own motion provider, so the reduced-motion
 * preference of the operating system applies to the panel alone.
 *
 * Locale: browser language (`navigator` / `Intl`), then the visible
 * 中文/English switch. Not `ctx.locale` — see i18n.ts.
 */
export function SpacesMainPanel({ remote }: { remote: SpacesControlApi }): ReactElement {
  const store = useMemo(() => new SpacesPanelStore(remote), [remote]);
  const [locale, setLocale] = useState<SpacesLocale>(() => inferSpacesLocale());
  useEffect(() => {
    void store.refresh();
  }, [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <MotionRoot>
      <SpacesPanelView
        snapshot={snapshot}
        locale={locale}
        onLocaleChange={setLocale}
        onRefresh={() => void store.refresh()}
        onSelect={store.select}
        onCreate={(input) => void store.createSpace(input)}
      />
    </MotionRoot>
  );
}
