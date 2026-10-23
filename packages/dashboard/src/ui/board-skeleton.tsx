import React, { type ReactNode } from 'react';

/**
 * Placeholder board shown while the first frame is still being read.
 *
 * Decorative only: the accessible state is the `role="status"` line next to
 * it, so the skeleton is hidden from assistive technology.
 */
export function BoardSkeleton(): ReactNode {
  return <div className="dd-skeleton" aria-hidden="true">
    <div className="dd-skeleton-card" />
    <div className="dd-skeleton-card" />
    <div className="dd-skeleton-card" />
  </div>;
}
