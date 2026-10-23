import React, { type ReactNode } from 'react';
import { VisibleScale } from '../../../../src/shared/ui/index.js';
import { refKey } from '../../../../src/core/domain/dashboard/validation.js';
import type { CatalogEntry } from '../../../../src/shared/dashboard.js';
import type { DashboardFrame } from '../model.js';

export interface CatalogPanelProps {
  frame: DashboardFrame;
  writable: boolean;
  onPin?(entry: CatalogEntry): void;
}

/**
 * The catalog picker.
 *
 * A glass panel over the board, scaled in once. Pinning is refused while a
 * read failed or a write is in flight; the reason is already on screen.
 */
export function CatalogPanel({ frame, writable, onPin }: CatalogPanelProps): ReactNode {
  return <VisibleScale as="aside" className="dd-catalog" aria-label="组件目录">
    <h2>添加组件</h2>
    <p>来自已接入的插件</p>
    {!frame.catalog.length && <p>当前没有可用组件。业务插件发布结果后会显示在这里。</p>}
    {frame.catalog.map(entry => <div className="dd-catalog-entry" key={refKey(entry.ref)}><div><strong>{entry.title}</strong><small>{entry.ref.spaceId} / {entry.ref.providerId} · {entry.kind}</small></div><button type="button" disabled={!writable || !onPin} onClick={() => onPin?.(entry)} aria-label={`固定 ${entry.title}`}>固定</button></div>)}
    {frame.moreCatalog && <p role="status">这里只显示前 100 个组件；完整目录分页界面尚未接入。</p>}
  </VisibleScale>;
}
