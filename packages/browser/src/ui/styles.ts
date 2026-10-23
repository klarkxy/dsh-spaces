/**
 * Browser space surface styles.
 *
 * One self-contained CSS string inlined by the Browser client root. The
 * Browser space is a standalone page, so the stylesheet cannot rely on
 * another surface having inlined its own material.
 *
 * Colours use `light-dark()` against the element's `color-scheme`. The
 * Browser space follows the DSH Web app, which publishes
 * `data-ds-dark-theme` on its body; dark is the default.
 */
export const BROWSER_CSS = `
.dsh-spaces-browser{
  --dsh-browser-bg:light-dark(#f6f7f9,#0f1012);
  --dsh-browser-surface:light-dark(#ffffff,#18191d);
  --dsh-browser-surface-2:light-dark(#e9ebef,#1f2025);
  --dsh-browser-text:light-dark(#20242a,#f2f3f5);
  --dsh-browser-muted:light-dark(#5f6874,#9aa0a6);
  --dsh-browser-line:light-dark(#d9dce2,rgba(255,255,255,.14));
  --dsh-browser-accent:light-dark(#5865f2,#7b83f7);
  --dsh-browser-accent-2:light-dark(#7c3aed,#a78bfa);
  --dsh-browser-danger:light-dark(#a11223,#f87171);
  --dsh-browser-shadow:light-dark(rgba(16,17,26,.16),rgba(0,0,0,.55));
  --dsh-browser-radius:10px;
  --dsh-browser-dur:200ms;
  --dsh-browser-ease:cubic-bezier(.2,0,0,1);
  color-scheme:dark;
  position:relative;
  display:flex;
  flex-direction:column;
  height:100vh;
  width:100%;
  background:var(--dsh-browser-bg);
  color:var(--dsh-browser-text);
  font:14px system-ui,sans-serif;
}
:where(body:not([data-ds-dark-theme])) .dsh-spaces-browser{color-scheme:light}
.dsh-spaces-browser *{box-sizing:border-box}
.dsh-browser-tabs{display:flex;gap:4px;padding:8px 10px 2px;overflow-x:auto;flex-shrink:0;background:var(--dsh-browser-surface);border-bottom:1px solid var(--dsh-browser-line)}
.dsh-browser-tab{position:relative;border:1px solid var(--dsh-browser-line);border-bottom:0;background:var(--dsh-browser-surface-2);color:var(--dsh-browser-text);font:inherit;border-radius:8px 8px 0 0;padding:8px 12px;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:background-color var(--dsh-browser-dur) var(--dsh-browser-ease),color var(--dsh-browser-dur) var(--dsh-browser-ease)}
.dsh-browser-tab:hover{background:color-mix(in srgb,var(--dsh-browser-accent) 12%,var(--dsh-browser-surface-2))}
.dsh-browser-tab[aria-current="page"]{background:var(--dsh-browser-surface);color:var(--dsh-browser-text)}
.dsh-browser-tab-indicator{position:absolute;left:8px;right:8px;bottom:0;height:2px;border-radius:2px;background:linear-gradient(90deg,var(--dsh-browser-accent),var(--dsh-browser-accent-2));box-shadow:0 0 12px -2px var(--dsh-browser-accent)}
.dsh-browser-address{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px;background:var(--dsh-browser-surface);border-bottom:1px solid var(--dsh-browser-line);flex-shrink:0;transition:box-shadow var(--dsh-browser-dur) var(--dsh-browser-ease)}
.dsh-browser-address:focus-within{box-shadow:0 0 0 1px var(--dsh-browser-accent),0 0 18px -6px color-mix(in srgb,var(--dsh-browser-accent) 70%,transparent)}
.dsh-browser-address input{flex:1;min-width:0;padding:8px 10px;color:var(--dsh-browser-text);background:var(--dsh-browser-bg);border:1px solid var(--dsh-browser-line);border-radius:8px;font:inherit;transition:border-color var(--dsh-browser-dur) var(--dsh-browser-ease),box-shadow var(--dsh-browser-dur) var(--dsh-browser-ease)}
.dsh-browser-address input:focus{outline:none;border-color:var(--dsh-browser-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsh-browser-accent) 30%,transparent)}
.dsh-browser-button{color:var(--dsh-browser-text);background:var(--dsh-browser-surface-2);border:1px solid var(--dsh-browser-line);border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer;transition:background-color var(--dsh-browser-dur) var(--dsh-browser-ease),scale var(--dsh-browser-dur) var(--dsh-browser-ease)}
.dsh-browser-button:hover{background:color-mix(in srgb,var(--dsh-browser-accent) 12%,var(--dsh-browser-surface-2))}
.dsh-browser-button:active{scale:.97}
.dsh-browser-link{color:var(--dsh-browser-accent);text-decoration:none}
.dsh-browser-link:hover{text-decoration:underline}
.dsh-browser-progress{position:absolute;left:0;right:0;bottom:-1px;height:2px;overflow:hidden;background:color-mix(in srgb,var(--dsh-browser-accent) 18%,transparent)}
.dsh-browser-progress-bar{position:absolute;top:0;bottom:0;left:0;width:40%;border-radius:inherit;background:linear-gradient(90deg,var(--dsh-browser-accent),var(--dsh-browser-accent-2));animation:dsh-browser-progress 1.1s var(--dsh-browser-ease) infinite}
@keyframes dsh-browser-progress{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
.dsh-browser-failure{color:var(--dsh-browser-danger);margin:6px 10px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsh-browser-danger) 45%,var(--dsh-browser-line));border-radius:8px;background:color-mix(in srgb,var(--dsh-browser-danger) 10%,transparent);line-height:1.5}
.dsh-browser-hint{color:var(--dsh-browser-muted);font-size:12px;margin:6px 10px;line-height:1.5;flex-shrink:0}
.dsh-browser-page{position:relative;flex:1;min-height:0;background:var(--dsh-browser-surface)}
.dsh-browser-frame{border:0;width:100%;height:100%;background:#fff}
.dsh-browser-home{padding:32px;text-align:center;color:var(--dsh-browser-muted)}
@media (prefers-reduced-motion: reduce){
  .dsh-spaces-browser,.dsh-spaces-browser *{animation:none!important;transition:none!important}
}
`;
