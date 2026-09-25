import React, { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from 'react';
import type { BoardCommand, BoardMutationReceipt, CatalogEntry, DashboardError, InstanceRef, Placement, WidgetContent } from '../../../src/shared/dashboard.js';
import { DashboardFault, publicError } from '../../../src/core/domain/dashboard/errors.js';
import { DashboardReadSession } from '../../../src/core/domain/dashboard/read-session.js';
import { parseLayoutDocument } from '../../../src/core/domain/dashboard/boards.js';
import { refKey } from '../../../src/core/domain/dashboard/validation.js';
import { moveCommand, pinCommand, readDashboardFrame, unpinCommand, type DashboardFrame, type DashboardReadBackend } from './model.js';

const states: Record<string, string> = { queued: '排队中', running: '进行中', waiting: '等待处理', succeeded: '已完成', failed: '失败', cancelled: '已取消', todo: '待处理', doing: '进行中', done: '已完成', blocked: '受阻' };
export function WidgetContentView({ content }: { content: WidgetContent }): ReactNode {
  switch (content.kind) {
    case 'progress': return <div className="dd-progress"><progress value={content.value} max={content.max} aria-label="进度" /><output>{content.value} / {content.max} {content.unit}</output><span>{states[content.status]}</span></div>;
    case 'metric': return <p className="dd-metric"><strong>{content.value}</strong> <span>{content.unit}</span></p>;
    case 'list': return <ul className="dd-list">{content.items.map(item => <li key={item.id}><span>{item.label}</span><small>{states[item.state]}</small></li>)}</ul>;
    // Deliberately render Markdown as inert text in this first renderer. No raw HTML,
    // link activation, images, URL resolution, scripts or remote resources.
    case 'markdown': return <pre className="dd-markdown" aria-label="Markdown（纯文本）">{content.text}</pre>;
  }
}
class CardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo): void { /* No provider payload or exception text is logged. */ }
  render() { return this.state.failed ? <p role="alert">此组件无法显示。</p> : this.props.children; }
}
function PlacementEditor({ placement, disabled, onChange }: { placement: Placement; disabled: boolean; onChange(position: Pick<Placement, 'x' | 'y' | 'w' | 'h'>): void }) {
  const [position, setPosition] = useState({ x: placement.x, y: placement.y, w: placement.w, h: placement.h });
  useEffect(() => setPosition({ x: placement.x, y: placement.y, w: placement.w, h: placement.h }), [placement.x, placement.y, placement.w, placement.h]);
  return <details className="dd-placement"><summary>调整布局</summary><form onSubmit={event => { event.preventDefault(); onChange(position); }}>
    {(['x', 'y', 'w', 'h'] as const).map(key => <label key={key}>{({ x: '列', y: '行', w: '宽', h: '高' })[key]}<input type="number" step={1} min={key === 'w' || key === 'h' ? 1 : 0} max={key === 'x' ? 11 : key === 'w' ? 12 : key === 'y' ? 9999 : 10000} value={position[key]} disabled={disabled} onChange={event => setPosition({ ...position, [key]: event.currentTarget.valueAsNumber })} /></label>)}
    <button type="submit" disabled={disabled}>保存位置</button>
  </form></details>;
}
export interface DashboardViewProps {
  frame: DashboardFrame | null;
  error?: DashboardError | null;
  writeError?: DashboardError | null;
  busy?: boolean;
  onPin?(entry: CatalogEntry): void;
  onUnpin?(placementId: string): void;
  onMove?(placementId: string, position: Pick<Placement, 'x' | 'y' | 'w' | 'h'>): void;
  onBoard?(boardId: string): void;
  /** Host router must query navigation and check the current target before opening it. */
  onOpen?(ref: InstanceRef): void;
}
export function DashboardView({ frame, error, writeError, busy = false, onPin, onUnpin, onMove, onBoard, onOpen }: DashboardViewProps): ReactNode {
  const views = new Map(frame?.items.map(item => [refKey(item.ref), item]) ?? []);
  const writable = !!frame?.overview.capabilities.layoutWrite && !busy && !error;
  return <section className="dsh-dashboard" aria-label="工作首页" aria-busy={busy}>
    <style>{styles}</style>
    <header className="dd-header"><div><small>{frame?.overview.mode === 'home' ? 'HOME · 多空间' : 'LOCAL · 本空间'}</small><h1>工作首页</h1><p>把正在做的事，放到看得见的地方。</p></div>
      {!!frame?.overview.boards.length && <label>看板<select value={frame.boardId} onChange={event => onBoard?.(event.currentTarget.value)} disabled={busy}>{frame.overview.boards.map(board => <option key={board.id} value={board.id}>{board.title}</option>)}</select></label>}
    </header>
    {error && <div className="dd-error" role="alert"><strong>看板读取已停止</strong><p>{frame ? '下方是上次读取的内容，不代表当前状态。' : '当前内容不可用。'}</p><code>{error.code}</code></div>}
    {writeError && <div className="dd-error" role="alert"><strong>{writeError.code === 'dashboard/unavailable' ? '操作结果无法确认，未重新发送。' : '此操作未确认成功。'}</strong><p><code>{writeError.code}</code></p>{writeError.requestId && <small>请求：{writeError.requestId}</small>}</div>}
    {!frame && !error && <p role="status">正在读取看板…</p>}
    {frame && <div className="dd-body"><main className="dd-main">
      <div className="dd-section-title"><h2>{frame.board?.title ?? '固定组件'}</h2><span>{frame.board?.placements.length ?? 0} 个组件</span></div>
      {!frame.board?.placements.length && <div className="dd-empty"><h3>首页还没有固定组件</h3><p>从组件目录选择要关注的内容。固定组件不会复制任务，也不会启动空间。</p></div>}
      <div className="dd-grid">{frame.board?.placements.map(placement => {
        const view = views.get(refKey(placement.ref));
        return <article key={placement.id} className="dd-card" style={{ gridColumn: `${placement.x + 1} / span ${placement.w}`, gridRow: `${placement.y + 1} / span ${placement.h}` }}>
          <div className="dd-card-heading"><h3>{view?.state === 'present' ? view.instance.title : '来源不可用'}</h3>{onUnpin && <button type="button" aria-label="移除固定组件" disabled={!writable} onClick={() => onUnpin(placement.id)}>移除</button>}</div>
          <small className="dd-source">{placement.ref.spaceId} / {placement.ref.providerId}</small>
          {view?.state === 'present' ? <CardBoundary><WidgetContentView content={view.instance.content} /></CardBoundary> : <p>此处仅保留摆放位置，未启动来源或读取其私有文件。</p>}
          {view?.state === 'present' && <footer><span>{error || view.freshness === 'stale' ? '最后记录 · 可能已过时' : '当前记录'}</span><time dateTime={view.receivedAt}>{view.receivedAt}</time>{onOpen && view.instance.sourceTarget && <button type="button" disabled={!!error || view.sourceState !== 'running'} onClick={() => onOpen(placement.ref)}>打开来源</button>}</footer>}
          {onMove && <PlacementEditor placement={placement} disabled={!writable} onChange={position => onMove(placement.id, position)} />}
        </article>;
      })}</div>
    </main><aside className="dd-catalog" aria-label="组件目录"><h2>添加组件</h2><p>来自已接入的插件</p>
      {!frame.catalog.length && <p>当前没有可用组件。业务插件发布结果后会显示在这里。</p>}
      {frame.catalog.map(entry => <div className="dd-catalog-entry" key={refKey(entry.ref)}><div><strong>{entry.title}</strong><small>{entry.ref.spaceId} / {entry.ref.providerId} · {entry.kind}</small></div><button type="button" disabled={!writable || !onPin} onClick={() => onPin?.(entry)} aria-label={`固定 ${entry.title}`}>固定</button></div>)}
      {frame.moreCatalog && <p role="status">这里只显示前 100 个组件；完整目录分页界面尚未接入。</p>}
    </aside></div>}
  </section>;
}

/** Mount with an authenticated backend supplied by the Host; never creates a manager or discovers a Home. */
export function DashboardApp({ backend, onOpen }: { backend: DashboardReadBackend; onOpen?(ref: InstanceRef): void }): ReactNode {
  const [frame, setFrame] = useState<DashboardFrame | null>(null);
  const [error, setError] = useState<DashboardError | null>(null);
  const [writeError, setWriteError] = useState<DashboardError | null>(null);
  const [busy, setBusy] = useState(false);
  const [boardId, setBoardId] = useState<string>();
  const generation = useRef(0);
  const writing = useRef(false);
  const writeVersion = useRef(0);
  const reader = useRef<DashboardReadSession<{ value: DashboardFrame; writeVersion: number }> | null>(null);
  useEffect(() => {
    generation.current++; writeVersion.current++; setError(null); setWriteError(null); writing.current = false; setBusy(false);
    const session = new DashboardReadSession({
      read: async (signal) => {
        const version = writeVersion.current;
        return { value: await readDashboardFrame(backend, signal, boardId), writeVersion: version };
      },
      onValue: result => {
        // A poll begun before/during a local write must not replace its newer
        // receipt with an older layout. The next normal successful poll reads it.
        if (result.writeVersion === writeVersion.current && !writing.current) setFrame(result.value);
      },
      onFailure: failure => setError(failure), clearSensitive: () => setFrame(null),
    });
    reader.current = session;
    session.start();
    return () => { generation.current++; session.close(); if (reader.current === session) reader.current = null; };
  }, [backend, boardId]);
  async function write(make: (current: DashboardFrame) => BoardCommand): Promise<void> {
    if (!frame || error || writing.current || !frame.overview.capabilities.layoutWrite) return;
    writing.current = true; writeVersion.current++; setBusy(true); setWriteError(null);
    const identity = generation.current;
    let requestId: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      requestId = crypto.randomUUID();
      const command = make(frame);
      const request = { requestId, issuedAt: new Date().toISOString(), backendEpoch: frame.backendEpoch, command };
      const receipt = await Promise.race<BoardMutationReceipt>([
        backend.mutate(request),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new DashboardFault('dashboard/unavailable')), 5000); }),
      ]);
      if (identity !== generation.current) return;
      if (receipt.protocolVersion !== 1 || receipt.requestId !== requestId || receipt.backendEpoch !== frame.backendEpoch) throw new DashboardFault('dashboard/invalid-input');
      if (receipt.result.kind !== 'board.saved') throw new DashboardFault('dashboard/invalid-input');
      const saved = parseLayoutDocument({ schemaVersion: 1, boards: [receipt.result.board], tombstones: [], receipts: [] }).boards[0];
      if (saved.id !== command.boardId) throw new DashboardFault('dashboard/invalid-input');
      setFrame(previous => previous && previous.backendEpoch === receipt.backendEpoch && previous.boardId === saved.id ? { ...previous, board: saved } : previous);
    } catch (failure) {
      if (identity === generation.current) {
        const exposed = publicError(failure);
        if (exposed.code === 'dashboard/unauthenticated' || exposed.code === 'dashboard/forbidden') {
          reader.current?.close();
          setError(exposed);
        }
        setWriteError({ ...exposed, ...(requestId ? { requestId } : {}) });
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (identity === generation.current) { writeVersion.current++; writing.current = false; setBusy(false); }
    }
  }
  return <DashboardView frame={frame} error={error} writeError={writeError} busy={busy} onBoard={setBoardId} onOpen={onOpen}
    onPin={entry => { void write(current => pinCommand(current, entry.ref, crypto.randomUUID())); }}
    onUnpin={id => { void write(current => unpinCommand(current, id)); }}
    onMove={(id, position) => { void write(current => moveCommand(current, id, position)); }} />;
}
const styles = `
.dsh-dashboard{--dd-line:color-mix(in srgb,currentColor 16%,transparent);font-family:system-ui,sans-serif;color:inherit;box-sizing:border-box;max-width:1600px;margin:auto;padding:32px;line-height:1.5}.dsh-dashboard *{box-sizing:border-box}.dsh-dashboard button,.dsh-dashboard input,.dsh-dashboard select{font:inherit;color:inherit;background:transparent;border:1px solid var(--dd-line);border-radius:8px;padding:6px 10px}.dsh-dashboard button{cursor:pointer;white-space:nowrap}.dsh-dashboard button:disabled{opacity:.45;cursor:default}.dsh-dashboard button:focus-visible,.dsh-dashboard input:focus-visible,.dsh-dashboard select:focus-visible,.dsh-dashboard summary:focus-visible{outline:2px solid currentColor;outline-offset:3px}.dd-header{display:flex;justify-content:space-between;gap:20px;margin-bottom:28px}.dd-header h1{font-size:32px;margin:4px 0}.dd-header p{margin:0;opacity:.65}.dd-header small{letter-spacing:.12em;opacity:.65}.dd-header label{align-self:center;display:grid;gap:6px;min-width:0}.dd-header select{max-width:100%}.dd-body{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:24px}.dd-main{min-width:0}.dd-section-title{display:flex;justify-content:space-between;align-items:center}.dd-section-title h2,.dd-catalog h2{font-size:18px}.dd-section-title span,.dd-source,.dd-catalog p{opacity:.65;font-size:13px}.dd-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-rows:minmax(90px,auto);gap:12px}.dd-card{min-width:0;border:1px solid var(--dd-line);border-radius:14px;padding:18px;overflow:auto}.dd-card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dd-card h3{font-size:16px;margin:0;overflow-wrap:anywhere}.dd-card-heading button{font-size:12px}.dd-source{display:block;overflow-wrap:anywhere}.dd-card footer{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:16px;font-size:11px;opacity:.7}.dd-progress{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:18px 0}.dd-progress progress{width:100%;height:8px}.dd-progress span{font-size:12px;opacity:.65}.dd-metric strong{font-size:38px;font-weight:600}.dd-list{padding:0;list-style:none}.dd-list li{display:flex;gap:14px;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--dd-line);overflow-wrap:anywhere}.dd-list small{white-space:nowrap;opacity:.65}.dd-markdown{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px}.dd-catalog{border-left:1px solid var(--dd-line);padding-left:24px}.dd-catalog-entry{display:flex;justify-content:space-between;gap:10px;padding:14px 0;border-bottom:1px solid var(--dd-line)}.dd-catalog-entry strong{display:block;font-size:14px;overflow-wrap:anywhere}.dd-catalog-entry small{display:block;font-size:11px;opacity:.65;overflow-wrap:anywhere}.dd-empty{padding:40px 24px;text-align:center;border:1px dashed var(--dd-line);border-radius:14px;opacity:.7}.dd-error{border:1px solid var(--dd-line);padding:16px;border-radius:10px;margin:12px 0}.dd-error p{margin:6px 0}.dd-placement{font-size:12px;margin-top:12px}.dd-placement form{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.dd-placement label{display:grid;gap:3px}.dd-placement input{width:64px}@media(max-width:850px){.dsh-dashboard{padding:16px}.dd-body{grid-template-columns:1fr}.dd-catalog{border-left:0;border-top:1px solid var(--dd-line);padding:12px 0}.dd-header{flex-wrap:wrap}.dd-header h1{font-size:26px}.dd-grid{display:flex;flex-direction:column}.dd-card{min-height:180px}}
`;
