import React, { type ReactNode } from 'react';
import { refKey } from '../../../../src/core/domain/dashboard/validation.js';
import type { CatalogEntry, DashboardError, InstanceRef, Placement } from '../../../../src/shared/dashboard.js';
import type { DashboardFrame } from '../model.js';
import { BoardGrid } from './board-grid.js';
import { BoardSkeleton } from './board-skeleton.js';
import { CatalogPanel } from './catalog-panel.js';
import { ReadFailurePanel, WriteFailurePanel } from './failure-panel.js';
import { DASHBOARD_CSS } from './styles.js';

export interface DashboardViewProps {
  mode?: 'home' | 'local';
  frame: DashboardFrame | null;
  error?: DashboardError | null;
  writeError?: DashboardError | null;
  busy?: boolean;
  /**
   * Resolves the surface palette. Without it the dashboard follows the host:
   * the workbench publishes `data-theme` on its root, the DSH Web app publishes
   * `data-ds-dark-theme` on its body.
   */
  theme?: 'dark' | 'light' | 'system';
  onPin?(entry: CatalogEntry): void;
  onUnpin?(placementId: string): void;
  onMove?(placementId: string, position: Pick<Placement, 'x' | 'y' | 'w' | 'h'>): void;
  onBoard?(boardId: string): void;
  /** Host router must query navigation and check the current target before opening it. */
  onOpen?(ref: InstanceRef): void;
}

/**
 * The dashboard board.
 *
 * A failed read is a terminal state: the notice is on screen at once and the
 * retained board stays visible, marked as possibly stale.
 */
export function DashboardView({ frame, mode = 'local', error, writeError, busy = false, theme, onPin, onUnpin, onMove, onBoard, onOpen }: DashboardViewProps): ReactNode {
  const views = new Map(frame?.items.map(item => [refKey(item.ref), item]) ?? []);
  const writable = !!frame?.overview.capabilities.layoutWrite && !busy && !error;
  return <section className="dsh-dashboard" data-theme={theme} aria-label="工作首页" aria-busy={busy}>
    <style>{DASHBOARD_CSS}</style>
    <header className="dd-header"><div><small>{(frame?.overview.mode ?? mode) === 'home' ? 'HOME · 多空间' : 'LOCAL · 本空间'}</small><h1>工作首页</h1><p>把正在做的事，放到看得见的地方。</p></div>
      {!!frame?.overview.boards.length && <label>看板<select value={frame.boardId} onChange={event => onBoard?.(event.currentTarget.value)} disabled={busy}>{frame.overview.boards.map(board => <option key={board.id} value={board.id}>{board.title}</option>)}</select></label>}
    </header>
    {error && <ReadFailurePanel error={error} retained={!!frame} />}
    {writeError && <WriteFailurePanel error={writeError} />}
    {!frame && !error && <><p role="status">正在读取看板…</p><BoardSkeleton /></>}
    {frame && <div className="dd-body"><main className="dd-main">
      <div className="dd-section-title"><h2>{frame.board?.title ?? '固定组件'}</h2><span>{frame.board?.placements.length ?? 0} 个组件</span></div>
      {!frame.board?.placements.length && <div className="dd-empty"><h3>首页还没有固定组件</h3><p>从组件目录选择要关注的内容。固定组件不会复制任务，也不会启动空间。</p></div>}
      <BoardGrid placements={frame.board?.placements ?? []} views={views} writable={writable} failed={!!error}
        onUnpin={onUnpin} onOpen={onOpen} onMove={onMove} />
    </main><CatalogPanel frame={frame} writable={writable} onPin={onPin} /></div>}
  </section>;
}
