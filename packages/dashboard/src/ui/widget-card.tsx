import React, { type ReactNode } from 'react';
import { motion, type Variants } from 'motion/react';
import type { InstanceRef, InstanceView, Placement } from '../../../../src/shared/dashboard.js';
import { CardBoundary } from './card-boundary.js';
import { PlacementEditor } from './placement-editor.js';
import { WidgetContentView } from './widget-content.js';

/**
 * Entrance variants for one board card.
 *
 * The board grid is a `StaggerList`, so a card only declares the two states
 * and inherits the stagger delay from its parent.
 */
export const widgetCardVariants: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 340, damping: 30, mass: 0.9 } },
};

export interface WidgetCardProps {
  placement: Placement;
  view: InstanceView | undefined;
  /** Layout writes are refused while a read failed or a write is in flight. */
  writable: boolean;
  /** A read failed: the retained content is stale and must stay visible. */
  failed: boolean;
  onUnpin?(placementId: string): void;
  onOpen?(ref: InstanceRef): void;
  onMove?(placementId: string, position: Pick<Placement, 'x' | 'y' | 'w' | 'h'>): void;
}

/**
 * One pinned widget.
 *
 * `layout` animates the card when a widget is pinned, unpinned or moved.
 * The transform motion writes while that animation runs is safe here: a
 * widget body is text, a progress bar, a list or plain Markdown, never an
 * iframe or a native view whose rectangle is measured.
 *
 * The card declares its two states and inherits `initial` and `animate` from
 * the board grid. A card that sets `initial` itself would stop the grid from
 * driving the entrance, so the grid owns the entrance and the skip.
 */
export function WidgetCard({ placement, view, writable, failed, onUnpin, onOpen, onMove }: WidgetCardProps): ReactNode {
  const present = view?.state === 'present';
  return <motion.article
    className="dd-card"
    layout="position"
    variants={widgetCardVariants}
    style={{ gridColumn: `${placement.x + 1} / span ${placement.w}`, gridRow: `${placement.y + 1} / span ${placement.h}` }}>
    <div className="dd-card-heading"><h3>{present ? view.instance.title : '来源不可用'}</h3>{onUnpin && <button type="button" aria-label="移除固定组件" disabled={!writable} onClick={() => onUnpin(placement.id)}>移除</button>}</div>
    <small className="dd-source">{placement.ref.spaceId} / {placement.ref.providerId}</small>
    {present ? <CardBoundary><WidgetContentView content={view.instance.content} /></CardBoundary> : <p>此处仅保留摆放位置，未启动来源或读取其私有文件。</p>}
    {present && <footer><span>{failed || view.freshness === 'stale' ? '最后记录 · 可能已过时' : '当前记录'}</span><time dateTime={view.receivedAt}>{view.receivedAt}</time>{onOpen && view.instance.sourceTarget && <button type="button" disabled={!!failed || view.sourceState !== 'running'} onClick={() => onOpen(placement.ref)}>打开来源</button>}</footer>}
    {onMove && <PlacementEditor placement={placement} disabled={!writable} onChange={position => onMove(placement.id, position)} />}
  </motion.article>;
}
