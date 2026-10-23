/**
 * The space context menu.
 *
 * The menu scales from the click origin and stays a plain, keyboard reachable
 * list of menu items.
 */

import React, { type ReactElement } from "react";
import { PanelScale } from "./motion";
import { t } from "../i18n";
import type { WorkbenchViewProps } from "./shared";

export function SpaceMenu({
  ui,
  controller,
  spaceId,
  x,
  y,
}: WorkbenchViewProps & { spaceId: string; x: number; y: number }): ReactElement {
  const locale = ui.locale;
  const space = controller.space(spaceId);
  const writable = controller.canMutate();
  const managed = Boolean(space?.managed);
  const running = space?.status === "running";
  const starting = space?.status === "starting";
  const crashed = space?.status === "crashed";
  const manager = controller.isManagerId(spaceId);
  return (
    <div className="dsh-wb-overlay dsh-wb-overlay-menu" onClick={controller.closeOverlay}>
      <PanelScale
        className="dsh-wb-menu"
        role="menu"
        aria-label={t(locale, "app.menu")}
        style={{ left: x, top: y }}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          disabled={!writable || !managed || running || starting}
          onClick={() => {
            controller.closeOverlay();
            controller.startSpace(spaceId);
          }}
        >
          {running || starting ? t(locale, "app.alreadyRunning") : t(locale, "app.start")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!writable || !managed || (!running && !crashed)}
          onClick={() => {
            controller.closeOverlay();
            controller.preview({ kind: "space.restart", spaceId });
          }}
        >
          {t(locale, "app.restart")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!writable || !managed || (!running && !starting)}
          onClick={() => {
            controller.closeOverlay();
            controller.preview({ kind: "space.stop", spaceId });
          }}
        >
          {t(locale, "app.stop")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!writable}
          onClick={() => controller.openRename(spaceId)}
        >
          {t(locale, "app.rename")}
        </button>
        <button type="button" role="menuitem" disabled={!writable} onClick={() => controller.openIcon(spaceId)}>
          {t(locale, "app.changeIcon")}
        </button>
        <button type="button" role="menuitem" onClick={() => controller.openDetail(spaceId)}>
          {t(locale, "detail.manage")}
        </button>
        <button type="button" role="menuitem" onClick={() => controller.openDetail(spaceId)}>
          {t(locale, "app.diagnose")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={manager || spaceId === "web"}
          onClick={() => {
            controller.closeOverlay();
            controller.openBlueprintGenerate(spaceId);
          }}
        >
          {t(locale, "blueprints.generate")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!writable || manager}
          onClick={() => {
            controller.closeOverlay();
            controller.preview({ kind: "space.delete", spaceId, removeData: false });
          }}
        >
          {t(locale, "app.delete")}
        </button>
      </PanelScale>
    </div>
  );
}
