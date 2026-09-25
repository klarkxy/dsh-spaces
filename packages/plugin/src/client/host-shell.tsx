import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { HostShellController } from "./host-shell-state";
import { attachHostLayout } from "./host-layout";
import { inferSpacesLocale } from "./i18n";
export const HOST_SHELL_CSS = `
[data-spaces-host-rail] > [data-spaces-host-covered] { visibility: hidden !important; pointer-events: none !important; }
.dsh-host-dock { position:absolute; inset:0; pointer-events:none; font:14px/1.5 system-ui; color:var(--dsw-alias-label-primary,#202127); }
.dsh-host-rail { pointer-events:auto; position:absolute; top:var(--dsh-frame-top-clearance,0px); bottom:0; left:0; width:72px; box-sizing:border-box; padding:10px 8px; display:flex; gap:8px; flex-direction:column; align-items:center; background:var(--dsw-alias-app-bg,#f0f1f5); border-right:1px solid var(--dsw-alias-border-primary,#d6d8de); }
.dsh-host-rail-list { flex:1; min-height:0; overflow-y:auto; width:100%; display:flex; flex-direction:column; align-items:center; gap:8px; }
.dsh-host-rail button { flex-shrink:0; width:48px; height:48px; border:1px solid transparent; border-radius:14px; background:transparent; color:inherit; font:inherit; cursor:pointer; overflow:hidden; }
.dsh-host-rail button:hover { background:color-mix(in srgb,currentColor 10%,transparent); }
.dsh-host-rail button[aria-current=true] { border-color:currentColor; background:color-mix(in srgb,currentColor 12%,transparent); }
.dsh-host-rail button:focus-visible { outline:2px solid currentColor; outline-offset:1px; }
.dsh-host-surface { position:absolute; top:var(--dsh-frame-top-clearance,0px); bottom:0; left:72px; right:0; pointer-events:auto; background:var(--dsw-alias-app-bg,#fff); }
iframe.dsh-host-surface { width:calc(100% - 72px); height:calc(100% - var(--dsh-frame-top-clearance,0px)); border:0; }
.dsh-host-surface[hidden] { display:none !important; }
.dsh-host-guide { padding:24px; box-sizing:border-box; overflow:auto; }
.dsh-host-guide button { padding:8px 14px; margin:8px 8px 8px 0; border:1px solid currentColor; border-radius:8px; background:transparent; color:inherit; cursor:pointer; }
.dsh-host-loading { position:absolute; bottom:12px; left:84px; padding:6px 12px; background:var(--dsw-alias-app-bg,#fff); pointer-events:none; }
`;
const texts = {
  zh: { current:"当前应用", home:"Spaces 首页", title:"空间", initialize:"初始化 Spaces", connecting:"正在连接空间服务", loading:"正在打开空间", manage:"打开空间管理", stopped:"该空间尚未运行。请在空间管理中明确启动。", unsupported:"当前宿主尚未提供兼容的嵌入通道。本版内置通道需要 http://127.0.0.1；没有启动或修改宿主。", unavailable:"空间服务或宿主身份不可用。当前应用仍可继续使用。", entry:"空间视图未能完成认证或握手。该次操作已失败，未自动重连。", initBody:"在当前应用中使用空间栏。初始化只准备 Spaces 的独立管理服务，不接管当前应用。" },
  en: { current:"Current application", home:"Spaces Home", title:"Spaces", initialize:"Initialize Spaces", connecting:"Connecting to the space service", loading:"Opening space", manage:"Open space management", stopped:"This space is not running. Start it explicitly in space management.", unsupported:"This host has no compatible embedding transport. The bundled transport requires http://127.0.0.1. No host was started or modified.", unavailable:"The space service or host identity is unavailable. The current application remains usable.", entry:"The space view could not authenticate or complete its handshake. This operation failed; it was not reconnected automatically.", initBody:"Use the space rail in this application. Initialization prepares the independent Spaces manager; it does not take over this application." },
};
export function HostShellPanel({ controller }: { controller: HostShellController }): ReactElement {
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const t = texts[inferSpacesLocale()];
  return <section className="dsh-host-guide" data-spaces-host-guide={ui.phase} data-dsh-spaces-guide={ui.phase}>
    <h2>{t.title}</h2>
    {ui.error ? <p role="alert" data-dsh-spaces-error={ui.error}>{t[ui.error]}</p> : <p>{ui.phase === "loading" || ui.phase === "connecting" ? t.connecting : t.initBody}</p>}
    {ui.phase === "initialize" && <button type="button" data-dsh-spaces-action="initialize" onClick={() => void controller.initialize()}>{t.initialize}</button>}
    {ui.phase === "ready" && <button type="button" data-dsh-spaces-action="enter" onClick={() => controller.select(null)}>{t.manage}</button>}
    <button type="button" onClick={controller.showCurrent}>{t.current}</button>
  </section>;
}
/** Additive shell-overlay occupant. The host's root and document are never replaced. */
export function PortableHostShell({ controller }: { controller: HostShellController }): ReactElement {
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const anchor = useRef<HTMLDivElement>(null), layout = useRef<ReturnType<typeof attachHostLayout> | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  const t = texts[inferSpacesLocale()];
  useLayoutEffect(() => {
    if (!anchor.current) return;
    try { layout.current = attachHostLayout(anchor.current); }
    catch { setLayoutError(true); return; }
    return () => { layout.current?.dispose(); layout.current = null; };
  }, []);
  useLayoutEffect(() => { layout.current?.cover(ui.visible !== "current"); }, [ui.visible]);
  useEffect(() => {
    if (layoutError || !layout.current) return;
    controller.start();
    const listen = (event: MessageEvent) => controller.handleMessage(event);
    window.addEventListener("message", listen);
    return () => { window.removeEventListener("message", listen); controller.stop(); };
  }, [controller, layoutError]);
  const spaces = ui.inventory?.spaces.filter(s => s.id !== ui.inventory?.managerId && s.id !== ui.role?.profileId) ?? [];
  return <div ref={anchor} className="dsh-host-dock" data-spaces-host-dock="true" data-spaces-host-phase={ui.phase} data-spaces-host-error={ui.error ?? undefined}>
    <nav className="dsh-host-rail" aria-label={t.title}>
      <button type="button" title={t.current} aria-label={t.current} aria-current={ui.visible === "current" ? "true" : undefined} onClick={controller.showCurrent}>DSH</button>
      <button type="button" title={t.home} aria-label={t.home} aria-current={ui.visible === "portal" && ui.selected === null ? "true" : undefined} onClick={() => controller.select(null)}>⌂</button>
      <div className="dsh-host-rail-list">{spaces.map(space => <button key={space.id} type="button" title={space.displayName} aria-label={space.displayName}
        data-space-status={space.status} aria-current={ui.visible === "portal" && ui.selected === space.id ? "true" : undefined}
        onClick={() => controller.select(space.id)}>{Array.from(space.displayName || space.id).slice(0,2).join("")}</button>)}</div>
      <button type="button" title={t.manage} aria-label={t.manage} onClick={controller.showGuide}>⋯</button>
    </nav>
    {ui.portal && <iframe className="dsh-host-surface" title="Spaces surface" data-spaces-host-surface="true" src={ui.portal.src}
      ref={element => controller.registerFrame(element?.contentWindow ?? null)} referrerPolicy="no-referrer" allow="clipboard-write"
      hidden={ui.visible !== "portal"} />}
    {(ui.visible === "guide" || layoutError) && <div className="dsh-host-surface">{layoutError ? <section className="dsh-host-guide" role="alert">{t.unsupported}</section> : <HostShellPanel controller={controller} />}</div>}
    {ui.pending !== null && <div className="dsh-host-loading" role="status">{t.loading}</div>}
  </div>;
}
