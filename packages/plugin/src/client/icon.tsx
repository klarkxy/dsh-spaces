import React, { type ReactElement } from "react";

/** Owner share supplied by the sidebar panel row (sidebar.panellist contract). */
export interface SpacesPanelIconProps {
  /** Requested square edge in pixels. */
  size: number;
  /** Whether this panel is selected in the main column. */
  active: boolean;
}

/** Sidebar glyph: stacked squares, one per space. The row button carries the accessible name. */
export function SpacesPanelIcon({ size, active }: SpacesPanelIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-active={active || undefined}
    >
      <rect x="1.5" y="1.5" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8.5" y="1.5" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="8.5" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <rect
        x="8.5"
        y="8.5"
        width="6"
        height="6"
        rx="1.5"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}
