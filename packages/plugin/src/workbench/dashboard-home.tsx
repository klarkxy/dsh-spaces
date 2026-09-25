import React, { useEffect, useRef, useState, type ReactElement } from 'react';
import type { DashboardBackend, DashboardError, PublicationPolicy } from '../../../../src/shared/dashboard';
import type { WorkbenchApi } from '../../../../src/shared/workbench';
import type { DashboardReadBackend } from '../../../dashboard/src/model';
import { DashboardApp } from '../../../dashboard/src/view';
import { DashboardFault, publicError } from '../../../../src/core/domain/dashboard/errors';
import { connectWorkbenchDashboard, publicationInput, readPublicationPolicies } from './dashboard-client';
import type { WorkbenchController, WorkbenchUiState } from './store';

type Mode = 'dashboard' | 'chat' | 'publications';
interface Props { api: WorkbenchApi; ui: WorkbenchUiState; controller: WorkbenchController; chatAvailable: boolean; onChat(active: boolean): void }
const failureCode = (error: unknown): DashboardError => {
  if (error instanceof DashboardFault) return publicError(error);
  return { code: 'dashboard/unavailable', message: 'dashboard/unavailable' };
};

/** This surface lives for the workbench lifetime. Switching views does not reopen
 * a failed data session, recreate the native chat iframe, or start source spaces. */
export function WorkbenchHome({ api, ui, controller, chatAvailable, onChat }: Props): ReactElement {
  const [mode, setMode] = useState<Mode>('dashboard');
  const [backend, setBackend] = useState<DashboardReadBackend | null>(null);
  const [error, setError] = useState<DashboardError | null>(null);
  const state = ui.state, managerId = state?.managerId ?? null;
  const manager = state?.spaces.find(s => s.id === managerId);
  const epoch = state?.serviceEpoch, generation = manager?.generation;
  const en = ui.locale === 'en';
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!managerId || !epoch || generation === undefined || typeof window === 'undefined') return;
    let active = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    setBackend(null); setError(null);
    void Promise.race([
      connectWorkbenchDashboard(api, { managerId, epoch, generation, pageOrigin: window.location.origin }),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new DashboardFault('dashboard/unavailable')), 5000); }),
    ]).then(connected => {
      if (!active) return;
      // Propagate authentication loss across BOTH dashboard and authorization views.
      async function checked<T>(operation: () => Promise<T>): Promise<T> {
        try { return await operation(); }
        catch (caught) {
          const failure = failureCode(caught);
          if (active && mounted.current && ['dashboard/unauthenticated', 'dashboard/forbidden', 'dashboard/stale-epoch', 'dashboard/unsupported-operation'].includes(failure.code)) setError(failure);
          throw caught;
        }
      }
      setBackend({ query: (req, signal) => checked(() => connected.query(req, signal)), mutate: req => checked(() => connected.mutate(req)) });
    }, caught => { if (active) setError(failureCode(caught)); }).finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
    return () => { active = false; if (timeout !== undefined) clearTimeout(timeout); };
  }, [api, managerId, epoch, generation]);
  const change = (next: Mode) => { setMode(next); onChat(next === 'chat'); };
  const spaces = controller.workspaceSpaces();
  return <div className="dsh-wb-home-page" data-home-mode={mode}>
    <style>{HOME_CSS}</style>
    <nav className="dsh-wb-home-nav" aria-label={en ? 'Home views' : '首页视图'}>
      <span className="dsh-wb-home-wordmark">SPACES <small>HOME</small></span>
      <div>
        <button type="button" aria-current={mode === 'dashboard' ? 'page' : undefined} onClick={() => change('dashboard')}>{en ? 'Dashboard' : '看板'}</button>
        {chatAvailable && <button type="button" aria-current={mode === 'chat' ? 'page' : undefined} onClick={() => change('chat')}>{en ? 'Chat' : '聊天'}</button>}
        <button type="button" aria-current={mode === 'publications' ? 'page' : undefined} onClick={() => change('publications')}>{en ? 'Publishing permissions' : '发布授权'}</button>
      </div>
    </nav>
    <div className="dsh-wb-home-body" hidden={mode === 'chat'}>
      {error ? <div className="dsh-wb-home-unavailable" role="alert"><h1>{en ? 'Dashboard unavailable' : '看板暂不可用'}</h1>
        <p>{error.code === 'dashboard/unsupported-operation' ? (en ? 'This platform does not support Home publishing yet.' : '此平台尚未支持 Home 看板能力。') : (en ? 'This read session has stopped. No requests have been resent.' : '本次读取已经停止，没有重新发送失败请求。')}</p><code>{error.code}</code></div>
        : !backend ? <p role="status" className="dsh-wb-home-unavailable">{en ? 'Connecting to the Home owner…' : '正在连接 Home 管理服务…'}</p>
        : <>
          <section hidden={mode !== 'dashboard'} aria-label={en ? 'Home dashboard' : 'Home 看板'}>
            <div className="dsh-wb-home-summary">
              <div><strong>{spaces.length}</strong><span>{en ? 'managed spaces' : '个工作空间'}</span></div>
              <div><strong>{spaces.filter(s => s.status === 'running').length}</strong><span>{en ? 'running' : '正在运行'}</span></div>
              <p>{en ? 'Pin results across spaces. Chat and source tasks stay where they belong.' : '把多个空间的工作结果放在一起。会话和任务仍留在各自的空间。'}</p>
            </div>
            <DashboardApp backend={backend} />
          </section>
          <section hidden={mode !== 'publications'}>
            <PublicationEditor backend={backend} ui={ui} controller={controller} />
          </section>
        </>}
    </div>
  </div>;
}

/** Policies are read only when the user chooses a space or the management revision
 * changes. Failed reads are terminal for this mounted page, not a retry loop. */
function PublicationEditor({ backend, ui, controller }: { backend: DashboardReadBackend; ui: WorkbenchUiState; controller: WorkbenchController }): ReactElement {
  const en = ui.locale === 'en', spaces = controller.workspaceSpaces();
  const [spaceId, setSpace] = useState('');
  const [policies, setPolicies] = useState<PublicationPolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DashboardError | null>(null);
  const [inputError, setInputError] = useState(false);
  const failed = useRef(false), sequence = useRef(0);
  const [providerId, setProvider] = useState('');
  const [mode, setMode] = useState<'disabled' | 'selected' | 'all'>('disabled');
  const [ids, setIds] = useState('');
  const [baseRevision, setBase] = useState('absent');
  const revision = ui.state?.revision, epoch = ui.state?.serviceEpoch;
  useEffect(() => {
    if (!spaceId || !epoch || failed.current) return;
    let active = true;
    const request = ++sequence.current;
    setLoading(true);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      backend.query({ kind: 'publications', spaceId }, abort.signal),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DashboardFault('dashboard/unavailable')), 5000); }),
    ]).then(response => {
      if (!active || request !== sequence.current) return;
      setPolicies(readPublicationPolicies(response, epoch, spaceId)); setLoading(false);
    }).catch(caught => {
      if (!active || request !== sequence.current) return;
      failed.current = true; setPolicies([]); setError(failureCode(caught)); setLoading(false);
    }).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    return () => { active = false; abort.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [backend, spaceId, revision, epoch]);
  const choose = (id: string) => {
    const p = policies.find(p => p.providerId === id);
    setProvider(id); setBase(p?.revision ?? 'absent'); setInputError(false);
    setMode(p?.selection?.kind ?? 'disabled'); setIds(p?.selection?.kind === 'selected' ? p.selection.instanceIds.join('\n') : '');
  };
  const current = policies.find(p => p.providerId === providerId);
  const outdated = (current?.revision ?? 'absent') !== baseRevision;
  const blocked = loading || !!error || !spaceId || !providerId || !controller.canMutate() || controller.isBusy() || outdated ||
    !spaces.some(s => s.id === spaceId && s.managed && !s.isHost);
  return <div className="dsh-wb-publications">
    <h1>{en ? 'Publishing permissions' : '发布授权'}</h1>
    <p className="dsh-wb-muted">{en ? 'Choose what a space may show on Home. This does not install plugins, start a space or approve business actions.' : '选择空间允许展示到 Home 的内容。授权不会安装插件、启动空间，也不会批准业务操作。'}</p>
    <label>{en ? 'Source space' : '来源空间'}<select aria-label={en ? 'Source space' : '来源空间'} value={spaceId} disabled={loading || !!error} onChange={e => {
      sequence.current++; setSpace(e.currentTarget.value); setPolicies([]); setProvider(''); setBase('absent'); setMode('disabled'); setIds(''); setInputError(false);
    }}><option value="">{en ? 'Choose a space' : '选择一个空间'}</option>{spaces.map(s => <option key={s.id} value={s.id}>{s.displayName} ({s.id})</option>)}</select></label>
    {loading && <p role="status">{en ? 'Reading current policy…' : '正在读取当前授权…'}</p>}
    {error && <p role="alert">{en ? 'Policy read stopped: ' : '授权读取已停止：'}<code>{error.code}</code></p>}
    {spaceId && !loading && !error && <>
      <div className="dsh-wb-publication-records" aria-label={en ? 'Current policies' : '当前授权'}>
        {!policies.length && <p>{en ? 'No publishing grants. All providers are disabled by default.' : '尚无发布授权。所有插件默认不向 Home 发布。'}</p>}
        {policies.map(p => <div key={p.providerId}><div><strong>{p.providerId}</strong><span>{!p.selection ? (en ? 'Disabled' : '已停用') : p.selection.kind === 'all' ? (en ? 'All instances, including future instances' : '全部实例（含未来新增）') : (en ? `${p.selection.instanceIds.length} selected instances` : `${p.selection.instanceIds.length} 个指定实例`)}</span>
          {p.pendingStart && <small>{en ? 'Applies on the next normal start. No restart was requested.' : '下次正常启动时生效，未请求重启。'}</small>}</div><button type="button" className="dsh-wb-btn" onClick={() => choose(p.providerId)}>{en ? 'Edit' : '编辑'}</button></div>)}
      </div>
      <form onSubmit={event => {
        event.preventDefault(); if (blocked) return;
        try { const input = publicationInput(spaceId, providerId, baseRevision, mode, ids); setInputError(false); controller.preview(input); }
        catch { setInputError(true); }
      }}>
        <label>{en ? 'Provider ID' : '发布插件标识'}<input value={providerId} maxLength={128} required onChange={e => choose(e.currentTarget.value)} placeholder="example-provider" /></label>
        <p className="dsh-wb-muted">{en ? 'Use the provider ID documented by the plugin. This is not necessarily its npm package name. Unpublished private data is not scanned.' : '填写插件文档提供的 providerId，不一定等于 npm 包名。这里不会扫描尚未授权的业务内容。'}</p>
        <fieldset disabled={!controller.canMutate()}><legend>{en ? 'Publication scope' : '发布范围'}</legend>
          <label><input type="radio" name="dashboard-publication-mode" checked={mode === 'disabled'} onChange={() => setMode('disabled')} />{en ? 'Disable publishing / revoke permission' : '停用发布 / 撤销授权'}</label>
          <label><input type="radio" name="dashboard-publication-mode" checked={mode === 'selected'} onChange={() => setMode('selected')} />{en ? 'Only the specified instances' : '仅指定实例'}</label>
          <label><input type="radio" name="dashboard-publication-mode" checked={mode === 'all'} onChange={() => setMode('all')} />{en ? 'All instances, including future instances' : '全部实例，包括未来新增实例'}</label>
        </fieldset>
        {mode === 'selected' && <label>{en ? 'Instance IDs, one per line' : '实例标识，每行一个'}<textarea rows={4} maxLength={12900} value={ids} onChange={e => setIds(e.currentTarget.value)} required /></label>}
        <p>{mode === 'disabled' ? (en ? 'Revocation hides existing published content. It does not delete source tasks.' : '撤销后会隐藏已发布内容，不删除来源任务。') : (en ? 'A new grant is available only on the next normal start; current processes are not silently upgraded.' : '新授权仅在下次正常启动时分配，不会静默提升当前进程的权限。')}</p>
        {outdated && <p role="status">{en ? 'The saved policy changed. Your draft was not overwritten.' : '服务端授权已变化，未覆盖你的编辑内容。'} <button type="button" className="dsh-wb-btn" onClick={() => choose(providerId)}>{en ? 'Use current policy' : '使用当前配置'}</button></p>}
        {inputError && <p role="alert">{en ? 'Check the identifiers. Blank or duplicate instance IDs are not accepted.' : '请检查标识：不接受空白或重复的实例标识。'}</p>}
        <button type="submit" className="dsh-wb-btn primary" disabled={blocked}>{en ? 'Preview permission change' : '预览授权变更'}</button>
      </form>
    </>}
  </div>;
}
const HOME_CSS = `
.dsh-wb-home-surface{position:absolute;inset:0;z-index:2;pointer-events:none;min-width:0;min-height:0}.dsh-wb-home-surface[hidden]{display:none}.dsh-wb-home-page{height:100%;color:var(--wb-text)}.dsh-wb-home-page [hidden]{display:none!important}.dsh-wb-home-nav{pointer-events:auto;display:flex;align-items:center;justify-content:space-between;gap:12px;height:52px;padding:0 20px;border-bottom:1px solid var(--wb-border);background:var(--wb-panel)}.dsh-wb-home-wordmark{font-weight:700;letter-spacing:.08em}.dsh-wb-home-wordmark small{font-weight:400;font-size:10px;color:var(--wb-muted)}.dsh-wb-home-nav button{border:0;border-radius:7px;background:transparent;cursor:pointer;padding:7px 12px;font-size:13px;white-space:nowrap}.dsh-wb-home-nav button[aria-current]{background:var(--wb-input);color:var(--wb-text)}.dsh-wb-home-body{height:calc(100% - 52px);overflow:auto;background:var(--wb-bg);pointer-events:auto}.dsh-wb-home-summary{margin:28px 32px 0;display:flex;gap:28px;align-items:center}.dsh-wb-home-summary>div{display:grid;min-width:75px}.dsh-wb-home-summary strong{font-size:28px;font-weight:600}.dsh-wb-home-summary span,.dsh-wb-home-summary p{font-size:12px;color:var(--wb-muted)}.dsh-wb-home-summary p{margin-left:auto;max-width:380px}.dsh-wb-home-body .dd-card{background:var(--wb-panel)}.dsh-wb-home-unavailable{padding:32px}.dsh-wb-publications{padding:32px;max-width:920px;margin:auto}.dsh-wb-publications h1{font-size:26px;margin:0 0 8px}.dsh-wb-publications label{display:grid;gap:8px;margin:14px 0}.dsh-wb-publications input:not([type=radio]),.dsh-wb-publications select,.dsh-wb-publications textarea{font:inherit;border:1px solid var(--wb-border);border-radius:8px;padding:10px;background:var(--wb-panel);width:100%;color:var(--wb-text)}.dsh-wb-publications fieldset{border:1px solid var(--wb-border);border-radius:10px;padding:12px 18px}.dsh-wb-publications fieldset label{display:flex;align-items:center;gap:8px}.dsh-wb-publication-records>div{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:14px 0;border-bottom:1px solid var(--wb-border)}.dsh-wb-publication-records span,.dsh-wb-publication-records small{display:block;color:var(--wb-muted);margin-top:5px}.dsh-wb-home-page button:focus-visible,.dsh-wb-home-page input:focus-visible,.dsh-wb-home-page select:focus-visible{outline:2px solid var(--wb-accent);outline-offset:2px}@media(max-width:600px){.dsh-wb-home-nav{padding:0 8px;gap:4px}.dsh-wb-home-wordmark{display:none}.dsh-wb-home-nav button{padding:7px 9px}.dsh-wb-home-summary{margin:16px;gap:20px;flex-wrap:wrap}.dsh-wb-home-summary p{margin:0;max-width:none}.dsh-wb-publications{padding:18px}}
`;
