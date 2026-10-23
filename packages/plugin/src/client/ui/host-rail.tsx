import React, { type ReactElement, type ReactNode } from "react";
import { LayoutIndicator } from "../../../../../src/shared/ui/motion";

/**
 * The space dock rail.
 *
 * The rail is a sibling of the surfaces it drives, never an ancestor of a
 * native view, so it may carry a hover morph and a sliding selection pill.
 * The pill is a shared-layout indicator: it travels from the previously
 * selected entry to the new one instead of blinking.
 */

/** Props of the rail itself. */
export interface HostRailProps {
  /** Accessible name of the rail. */
  label: string;
  /** Shared layout id of the selection pill; unique per rail. */
  layoutId: string;
  /** True while the dock waits for a response. */
  busy?: boolean;
  children: ReactNode;
}

/** The rail of the space dock. */
export function HostRail({ label, layoutId, busy = false, children }: HostRailProps): ReactElement {
  return (
    <nav className="dsh-host-rail" aria-label={label} data-dsh-host-rail={layoutId} data-busy={busy ? "true" : undefined}>
      {children}
    </nav>
  );
}

/** Separator between the pinned main space and the switchable spaces. */
export function HostRailDivider(): ReactElement {
  return <div className="dsh-host-rail-divider" role="separator" aria-orientation="horizontal" />;
}

/** The scrollable middle section of the rail. */
export function HostRailList({ children }: { children: ReactNode }): ReactElement {
  return <div className="dsh-host-rail-list">{children}</div>;
}

/** Props of one rail entry. */
export interface HostRailButtonProps {
  /** Shared layout id of the selection pill. */
  layoutId: string;
  /** Accessible name and tooltip of the entry. */
  label: string;
  /** Tooltip of the entry; defaults to the accessible name. */
  title?: string;
  /** The entry content rendered inside the button: a glyph, an icon or a sign. */
  children?: ReactNode;
  /** Whether this entry is the selected one. */
  current?: boolean;
  /**
   * Value written to `aria-current`. The portable host marks the current
   * entry with "true", the desktop host with "page".
   */
  currentValue?: "true" | "page";
  /** True while the entry is in a transitional state. */
  transitional?: boolean;
  /** Status of the space behind the entry, if any. */
  status?: string;
  /** Pinned entries stay at the top of the rail. */
  pinned?: boolean;
  /** True while the entry is waiting for a response. */
  busy?: boolean;
  disabled?: boolean;
  /** Identifier of the space behind the entry, if any. */
  spaceId?: string;
  onSelect: () => void;
}

/** One entry of the space dock rail. */
export function HostRailButton({
  layoutId,
  label,
  title,
  children,
  current = false,
  currentValue = "true",
  transitional = false,
  status,
  pinned = false,
  busy = false,
  disabled = false,
  spaceId,
  onSelect,
}: HostRailButtonProps): ReactElement {
  return (
    <button
      type="button"
      className="dsh-host-rail-btn"
      title={title ?? label}
      aria-label={label}
      aria-current={current ? currentValue : undefined}
      aria-busy={busy || undefined}
      data-pinned={pinned ? "true" : undefined}
      data-space-id={spaceId}
      data-space-status={status}
      data-transitional={transitional ? "true" : undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      {current && (
        <LayoutIndicator layoutId={layoutId} className="dsh-host-rail-pill" aria-hidden="true" />
      )}
      {children}
    </button>
  );
}
