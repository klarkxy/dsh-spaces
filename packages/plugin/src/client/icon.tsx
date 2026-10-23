import React, { type ReactElement } from "react";
import { SpacesBrandMark } from "./branding";

/** Owner share supplied by the sidebar panel row (sidebar.panellist contract). */
export interface SpacesPanelIconProps {
  /** Requested square edge in pixels. */
  size: number;
  /** Whether this panel is selected in the main column. */
  active: boolean;
}

/** The row button carries the accessible name. */
export function SpacesPanelIcon({ size, active }: SpacesPanelIconProps): ReactElement {
  return (
    <span
      className="dsh-spaces-panel-icon"
      data-active={active || undefined}
      style={{
        display: "inline-flex",
        borderRadius: "22%",
        transform: active ? "scale(1.06)" : "none",
        filter: active ? "drop-shadow(0 0 8px rgba(88, 101, 242, 0.55))" : "none",
        transition: "transform 160ms cubic-bezier(0.34, 1.56, 0.64, 1), filter 160ms linear",
      }}
    >
      <SpacesBrandMark size={size} />
    </span>
  );
}
