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
    <span data-active={active || undefined} style={{ display: "inline-flex" }}>
      <SpacesBrandMark size={size} />
    </span>
  );
}
