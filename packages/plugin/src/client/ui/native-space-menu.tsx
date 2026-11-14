import React, { useRef } from "react";
import type { PortalSpace } from "../../../../../src/shared/space-host";
import type { DesktopSpaceAction } from "../../types";
import { useMenuKeyboard } from "../../workbench/use-menu-keyboard";
import { nativeStatusText, nativeTexts } from "./native-texts";

export function NativeSpaceMenu({ space, x, y, busy, supportsSpaceActions = true, onAction, onSettings, onClose }: {
  space: PortalSpace; x: number; y: number; busy: boolean; supportsSpaceActions?: boolean;
  onAction: (action: DesktopSpaceAction["action"]) => void; onSettings?: () => void; onClose: () => void;
}) {
  const texts = nativeTexts();
  const menu = useRef<HTMLDivElement>(null);
  const keyboard = useMenuKeyboard(menu, { x, y, onClose });
  const starting = space.status === "starting", running = space.status === "running";
  const blocked = !supportsSpaceActions || busy || space.status === "unknown" || space.status === "stopping";
  return <div ref={menu} className="dsh-native-space-menu" role="menu" tabIndex={-1} aria-label={`${space.displayName} · ${texts.menuLabel}`}
    style={{ left: x, top: y }} onContextMenu={event => event.preventDefault()}
    onKeyDown={keyboard.onKeyDown}>
    <div className="dsh-native-space-menu-title">{space.displayName}<small>{nativeStatusText(space.status, texts)}</small></div>
    <button role="menuitem" disabled={blocked || running || starting} onClick={() => onAction("start")}>{texts.start}</button>
    <button role="menuitem" disabled={blocked || (!running && !starting)} onClick={() => onAction("stop")}>{texts.stop}</button>
    <button role="menuitem" disabled={blocked || (!running && space.status !== "crashed")} onClick={() => onAction("restart")}>{texts.restart}</button>
    {onSettings ? <button role="menuitem" disabled={busy} onClick={onSettings}>{texts.spaceSettings}</button> : null}
  </div>;
}
