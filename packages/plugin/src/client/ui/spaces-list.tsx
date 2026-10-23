import React, { type ReactElement } from "react";
import type { SpaceSummary } from "../../../../../src/shared/spaces-control";
import { LayoutIndicator, StaggerItem, StaggerList } from "../../../../../src/shared/ui/motion";
import { t, type SpacesLocale } from "../i18n";
import { statusLabel } from "./labels";

/**
 * The space list of the Spaces panel.
 *
 * The rows enter as a staggered list, the selected row carries a sliding
 * selection pill, and a status dot pulses while the row is in a transitional
 * state (its detail is loading, or the overview is refreshing).
 */

/** Props of the space list. */
export interface SpaceListProps {
  locale: SpacesLocale;
  spaces: SpaceSummary[];
  /** Currently selected space id, if any. */
  selectedId: string | null;
  /** Space whose detail is currently loading, if any. */
  transitionalId: string | null;
  /** True while the overview refreshes on top of visible data. */
  refreshing: boolean;
  onSelect: (id: string) => void;
}

/** Shared layout id of the selection pill. */
const SELECTION_LAYOUT_ID = "dsh-spaces-selection";

export function SpaceList({
  locale,
  spaces,
  selectedId,
  transitionalId,
  refreshing,
  onSelect,
}: SpaceListProps): ReactElement {
  return (
    <StaggerList as="ul" className="dsh-spaces-list" aria-label={t(locale, "list.label")} step={0.035}>
      {spaces.map((space) => {
        const selected = space.id === selectedId;
        const transitional = space.id === transitionalId || refreshing;
        return (
          <StaggerItem as="li" key={space.id} className="dsh-spaces-row">
            <button
              type="button"
              className="dsh-spaces-item"
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(space.id)}
            >
              {selected && (
                <LayoutIndicator
                  layoutId={SELECTION_LAYOUT_ID}
                  className="dsh-spaces-selection"
                  aria-hidden="true"
                />
              )}
              <span
                className="dsh-spaces-status"
                data-status={space.status}
                data-transitional={transitional ? "true" : undefined}
                aria-hidden="true"
              />
              <span className="dsh-spaces-item-name">{space.displayName}</span>
              {space.isHost && (
                <span className="dsh-spaces-badge" data-tone="host">
                  {t(locale, "list.host")}
                </span>
              )}
              <span className="dsh-spaces-sr-only">{statusLabel(locale, space.status)}</span>
            </button>
          </StaggerItem>
        );
      })}
    </StaggerList>
  );
}
