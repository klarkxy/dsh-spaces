import React, { type ReactNode } from 'react';
import { StaggerList } from '../../../../src/shared/ui/index.js';
import { refKey } from '../../../../src/core/domain/dashboard/validation.js';
import type { InstanceRef, InstanceView, Placement } from '../../../../src/shared/dashboard.js';
import { WidgetCard } from './widget-card.js';

export interface BoardGridProps {
  placements: readonly Placement[];
  views: Map<string, InstanceView>;
  writable: boolean;
  /** A read failed: the retained board stays visible without an entrance. */
  failed: boolean;
  onUnpin?(placementId: string): void;
  onOpen?(ref: InstanceRef): void;
  onMove?(placementId: string, position: Pick<Placement, 'x' | 'y' | 'w' | 'h'>): void;
}

/**
 * The board grid.
 *
 * The grid itself staggers its cards in. After a read failure the entrance is
 * skipped, so the retained content is on screen at once instead of fading in
 * behind a failure notice.
 */
export function BoardGrid({ placements, views, writable, failed, onUnpin, onOpen, onMove }: BoardGridProps): ReactNode {
  return <StaggerList className="dd-grid" appear={!failed} step={0.06} delayChildren={0.04}>
    {placements.map(placement => <WidgetCard
      key={placement.id}
      placement={placement}
      view={views.get(refKey(placement.ref))}
      writable={writable}
      failed={failed}
      onUnpin={onUnpin}
      onOpen={onOpen}
      onMove={onMove} />)}
  </StaggerList>;
}
