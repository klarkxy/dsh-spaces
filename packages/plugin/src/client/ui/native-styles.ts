/**
 * Styles of the desktop (Electron) host shell.
 *
 * The native guest is a child of `.dsh-native-container`, and the container is
 * measured by the host to place the native view. Nothing in this file may
 * transform, filter or resize the container or its ancestors: the motion
 * lives on the rail, on the guide and on the loading notice, all of them
 * siblings of the container.
 */
import { CREATION_RING_CSS } from "../../../../../src/shared/ui/creation-ring";
import { ATTENTION_RING_CSS } from "../../../../../src/shared/ui/attention-ring";

export const NATIVE_HOST_CSS = `
.dsh-native-confirm-backdrop{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:#0006;padding:24px;pointer-events:auto}
.dsh-native-confirm{width:min(520px,100%);max-height:85vh;overflow:auto;padding:24px;border-radius:16px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 16px 60px #0004;line-height:1.6}
.dsh-native-confirm-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:20px}
.dsh-native-confirm .dsh-host-action.danger{border-color:var(--host-danger,#d1242f);color:var(--host-danger,#d1242f)}
.dsh-native-confirm .dsh-host-action.danger:hover:not(:disabled){background:color-mix(in srgb,var(--host-danger,#d1242f) 12%,transparent)}
.dsh-native-operation-notice{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 110px);padding:12px 18px;border-radius:12px;z-index:1200;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 4px 20px #0002;border:1px solid var(--dsw-alias-border-l3,#ddd)}
[data-windows-titlebar] .dsh-host-dock[data-spaces-native] { --dsh-frame-top-clearance: var(--dsh-windows-titlebar-height); }
html[data-windows-titlebar] body:has(.dsh-host-dock[data-spaces-native]) {
  background-image: linear-gradient(var(--host-rail-bg, var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f0f1f5))), var(--host-rail-bg, var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f0f1f5))));
  background-repeat: no-repeat;
  background-position: 0 0;
  background-size: var(--dsh-spaces-rail-width, 72px) var(--dsh-windows-titlebar-height);
}
/* Windows caption: our rail toggle sits at left:12px; the official caption
   controls are offset by the rail width (72px), or by just the toggle (36px)
   while the rail is hidden. */
html[data-windows-titlebar]:has(.dsh-host-dock[data-spaces-native]) {
  --dsh-spaces-caption-offset: 72px;
  --dsh-windows-menu-start: calc(48px + var(--dsh-spaces-caption-offset));
}
html[data-windows-titlebar]:has(.dsh-host-dock[data-spaces-native][data-rail-collapsed]) {
  --dsh-spaces-rail-width: 0px;
  --dsh-spaces-caption-offset: 36px;
}
html[data-windows-titlebar]:has(.dsh-host-dock[data-spaces-native]):has([data-spaces-host-rail][data-sidebar-collapsed] > div:first-of-type:not([data-spaces-host-covered])) {
  --dsh-windows-menu-start: calc(84px + var(--dsh-spaces-caption-offset));
}
html[data-windows-titlebar] .dsh-host-dock[data-spaces-native][data-rail-collapsed] .dsh-host-rail { display: none; }
.dsh-native-rail-toggle { display: none; }
html[data-windows-titlebar] .dsh-native-rail-toggle {
  display: inline-flex;
  position: fixed;
  left: 12px;
  top: calc((var(--dsh-windows-titlebar-height) - 28px) / 2);
  width: 28px;
  height: 28px;
  z-index: 30;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, currentColor);
  cursor: pointer;
}
html[data-windows-titlebar] .dsh-native-rail-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 10%, transparent)); }
html[data-windows-titlebar] .dsh-native-rail-toggle:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
html[data-windows-titlebar] [data-spaces-host-rail]:not([data-sidebar-collapsed]) > div:first-of-type [data-window-drag] > button:last-of-type { position: static !important; }
html[data-windows-titlebar] [data-spaces-host-rail][data-sidebar-collapsed] > div:first-of-type [data-window-drag] > button:last-of-type { left: calc(12px + var(--dsh-spaces-caption-offset)) !important; }
html[data-windows-titlebar] [data-spaces-host-rail][data-sidebar-collapsed] > div:first-of-type [data-window-drag] + button { left: calc(48px + var(--dsh-spaces-caption-offset)) !important; }
.dsh-host-dock[data-spaces-native] .dsh-host-rail {
  background: var(--host-rail-bg, var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f0f1f5)));
  border-color: var(--host-border, var(--dsw-alias-border-l3, #d6d8de));
}
.dsh-host-dock[data-spaces-native] .dsh-host-rail > .dsh-native-startup-status {
  align-self: stretch;
  box-sizing: border-box;
  flex: 0 0 auto;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  margin: 0;
  padding: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: normal;
  text-align: center;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--dsw-alias-label-primary, var(--host-text, currentColor));
}
.dsh-native-container { overflow: hidden; display: flex; }
.dsh-native-container[hidden] { display: none; }
.dsh-native-guest { display: flex; width: 100%; height: 100%; border: 0; }
.dsh-host-rail-btn > .dsh-native-space-status { position:absolute; z-index:4; right:3px; bottom:3px; box-sizing:border-box; width:11px; height:11px; border:2px solid var(--host-rail-bg,#202127); border-radius:50%; background:#939ba8; pointer-events:none; }
.dsh-native-space-status[data-status="running"] { background:#39bf83; }
.dsh-native-space-status[data-status="crashed"], .dsh-native-space-status[data-status="failed"] { background:#ff7878; }
.dsh-native-space-status[data-status="starting"], .dsh-native-space-status[data-status="stopping"], .dsh-native-space-status[data-status="opening"] { background:#edb95e; }
.dsh-native-space-menu { position:fixed; z-index:20; pointer-events:auto; min-width:176px; max-width:calc(100vw - 16px); padding:4px; border:0.5px solid var(--host-border,#666); border-radius:8px; background:var(--host-bg,#202127); color:var(--host-text,#fff); box-shadow:0 8px 24px #0004; }
.dsh-native-space-menu-title { padding:6px 10px 10px; overflow-wrap:anywhere; }
.dsh-native-space-menu-title small { display:block; opacity:.7; }
.dsh-native-space-menu button { display:block; width:100%; text-align:left; padding:7px 10px; font-size:13px; border:0; border-radius:6px; background:transparent; color:inherit; font:inherit; cursor:pointer; }
.dsh-native-space-menu button:hover:not(:disabled), .dsh-native-space-menu button:focus-visible { background:var(--host-hover,color-mix(in srgb,currentColor 8%,transparent)); outline:none; }
.dsh-native-space-menu button:disabled { opacity:.4; cursor:default; }
.dsh-native-operation-error { position:absolute; z-index:21; pointer-events:auto; top:calc(var(--dsh-frame-top-clearance,0px) + 12px); left:calc(var(--dsh-spaces-rail-width, 72px) + 12px); right:12px; padding:10px 36px 10px 12px; border:1px solid var(--host-danger,#d1242f); border-radius:8px; background:var(--host-bg,#202127); color:var(--host-danger,#d1242f); overflow-wrap:anywhere; }
.dsh-native-operation-error button { position:absolute; right:6px; top:6px; background:transparent; border:0; color:inherit; font-size:20px; cursor:pointer; }
.dsh-host-rail button[aria-current="page"] { border-color: transparent; background: var(--dsw-alias-interactive-bg-active, color-mix(in srgb, currentColor 10%, transparent)); }
.dsh-host-dock[data-spaces-native] .dsh-host-rail-btn[aria-current="page"] { border-color: transparent; background: transparent; }
.dsh-host-dock[data-spaces-native] .dsh-native-service-error { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--host-danger, #d1242f); color: #fff; font: bold 12px/16px system-ui; text-align: center; }
${CREATION_RING_CSS}
${ATTENTION_RING_CSS}
`;

/** Styles of the official Browser tab inside a native space. */
export const NATIVE_BROWSER_CSS = `
.dsh-native-browser-tab { position: absolute; display: flex; border: 0; background: #fff; z-index: 1; }
.dsh-native-browser-tab[hidden] { display: none; }
`;
