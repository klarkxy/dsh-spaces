/**
 * The space context menu.
 *
 * The menu scales from the click origin and stays a plain, keyboard reachable
 * list of menu items.
 */

import React, { useRef, type ReactElement } from "react";
import { VisibleScale } from "../../../../../src/shared/ui/motion";
import { SPACES_BLUEPRINT_SEALED } from "../../../../../src/shared/blueprint-sealed";
import { t } from "../i18n";
import { useMenuKeyboard } from "../use-menu-keyboard";
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
  const menu = useRef<HTMLElement>(null);
  const keyboard = useMenuKeyboard(menu, { x, y, onClose: controller.closeOverlay });
  return (
    <div className="dsh-wb-overlay dsh-wb-overlay-menu" onClick={controller.closeOverlay}>
      <VisibleScale
        ref={menu}
        className="dsh-wb-menu"
        role="menu"
        aria-label={t(locale, "app.menu")}
        tabIndex={-1}
        style={{ left: x, top: y }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={keyboard.onKeyDown}
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
        {!SPACES_BLUEPRINT_SEALED ? (
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
        ) : null}
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
      </VisibleScale>
    </div>
  );
}
