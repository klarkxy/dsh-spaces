/**
 * Dashboard surface styles.
 *
 * One self-contained CSS string, inlined by the dashboard view. The plugin
 * client also mounts it as the static `dashboard.css` stylesheet, so it must
 * not depend on another stylesheet being present.
 *
 * Material notes:
 *
 * - Colours use `light-dark()` against the element's `color-scheme`. The
 *   dashboard resolves its scheme from the host (the workbench publishes
 *   `data-theme` on its root, the DSH Web app publishes
 *   `data-ds-dark-theme` on its body) and falls back to dark.
 * - `translate` is used for the hover lift, never `transform`. Motion writes
 *   `transform` while a layout animation runs, and the two compose, so a
 *   card can be laid out and hovered at the same time.
 * - The shimmer keyframe reuses the shared `dsh-ui-shimmer` name so a host
 *   that already inlines the shared token layer keeps the same animation.
 */
export const DASHBOARD_CSS = `
.dsh-dashboard{
  --dd-line:color-mix(in srgb,currentColor 16%,transparent);
  --dd-surface:light-dark(#ffffff,#18191d);
  --dd-surface-2:light-dark(#eceef2,#1f2025);
  --dd-text:light-dark(#16171a,#f2f3f5);
  --dd-muted:light-dark(#5c6166,#9aa0a6);
  --dd-faint:light-dark(#8a9096,#6e7378);
  --dd-accent:light-dark(#4f5bd5,#7b83f7);
  --dd-accent-2:light-dark(#6d28d9,#a78bfa);
  --dd-accent-ink:#ffffff;
  --dd-danger:light-dark(#b42318,#f87171);
  --dd-ok:light-dark(#1f7a45,#4ade80);
  --dd-warn:light-dark(#8a6d0b,#fbbf24);
  --dd-shadow-color:light-dark(rgba(16,17,26,.18),rgba(0,0,0,.55));
  --dd-shadow-color-strong:light-dark(rgba(16,17,26,.30),rgba(0,0,0,.70));
  --dd-glass:light-dark(rgba(255,255,255,.72),rgba(24,25,29,.72));
  --dd-skeleton:light-dark(#eceef2,#222329);
  --dd-skeleton-sheen:light-dark(rgba(255,255,255,.85),rgba(255,255,255,.07));
  --dd-radius:14px;
  --dd-dur-fast:120ms;
  --dd-dur:200ms;
  --dd-dur-slow:360ms;
  --dd-ease:cubic-bezier(.2,0,0,1);
  --dd-elev-sm:0 1px 2px var(--dd-shadow-color);
  --dd-elev-md:0 10px 24px -12px var(--dd-shadow-color);
  --dd-elev-lg:0 24px 56px -20px var(--dd-shadow-color-strong);
  --dd-accent-soft:color-mix(in srgb,var(--dd-accent) 38%,transparent);
  --dd-accent-glow:0 0 0 1px var(--dd-accent-soft),0 0 24px -6px var(--dd-accent-soft);
  color-scheme:dark;
  font-family:system-ui,sans-serif;
  color:var(--dd-text);
  box-sizing:border-box;
  max-width:1600px;
  margin:auto;
  padding:32px;
  line-height:1.5;
}
:where(body:not([data-ds-dark-theme])) .dsh-dashboard{color-scheme:light}
:where([data-theme="light"]) .dsh-dashboard{color-scheme:light}
@media (prefers-color-scheme:light){:where([data-theme="system"]) .dsh-dashboard{color-scheme:light}}
@media (prefers-color-scheme:dark){:where([data-theme="system"]) .dsh-dashboard{color-scheme:dark}}
:where([data-theme="dark"]) .dsh-dashboard{color-scheme:dark}
.dsh-dashboard[data-theme="light"]{color-scheme:light}
.dsh-dashboard[data-theme="dark"]{color-scheme:dark}
@media (prefers-color-scheme:light){.dsh-dashboard[data-theme="system"]{color-scheme:light}}
.dsh-dashboard *{box-sizing:border-box}
.dsh-dashboard button,.dsh-dashboard input,.dsh-dashboard select{font:inherit;color:inherit;background:transparent;border:1px solid var(--dd-line);border-radius:8px;padding:6px 10px;transition:border-color var(--dd-dur) var(--dd-ease),background-color var(--dd-dur) var(--dd-ease),box-shadow var(--dd-dur) var(--dd-ease),scale var(--dd-dur-fast) var(--dd-ease)}
.dsh-dashboard button{cursor:pointer;white-space:nowrap}
.dsh-dashboard button:disabled{opacity:.45;cursor:default}
.dsh-dashboard button:not(:disabled):hover{border-color:var(--dd-accent-soft);background:color-mix(in srgb,var(--dd-accent) 10%,transparent)}
.dsh-dashboard button:not(:disabled):active{scale:.97}
.dsh-dashboard button:focus-visible,.dsh-dashboard input:focus-visible,.dsh-dashboard select:focus-visible,.dsh-dashboard summary:focus-visible{outline:2px solid currentColor;outline-offset:3px}
.dd-header{display:flex;justify-content:space-between;gap:20px;margin-bottom:28px}
.dd-header h1{font-size:32px;margin:4px 0}
.dd-header p{margin:0;opacity:.65}
.dd-header small{letter-spacing:.12em;opacity:.65}
.dd-header label{align-self:center;display:grid;gap:6px;min-width:0}
.dd-header select{max-width:100%}
.dd-body{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:24px;align-items:start}
.dd-main{min-width:0}
.dd-section-title{display:flex;justify-content:space-between;align-items:center}
.dd-section-title h2,.dd-catalog h2{font-size:18px}
.dd-section-title span,.dd-source,.dd-catalog p{opacity:.65;font-size:13px}
.dd-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-rows:minmax(90px,auto);gap:12px}
.dd-card{min-width:0;border:1px solid var(--dd-line);border-radius:var(--dd-radius);padding:18px;overflow:auto;background:var(--dd-surface);box-shadow:var(--dd-elev-sm);transition:translate var(--dd-dur) var(--dd-ease),box-shadow var(--dd-dur) var(--dd-ease),border-color var(--dd-dur) var(--dd-ease)}
.dd-card:hover{translate:0 -3px;border-color:var(--dd-accent-soft);box-shadow:var(--dd-elev-md)}
.dd-card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dd-card h3{font-size:16px;margin:0;overflow-wrap:anywhere}
.dd-card-heading button{font-size:12px}
.dd-source{display:block;overflow-wrap:anywhere}
.dd-card footer{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:16px;font-size:11px;opacity:.7}
.dd-progress{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:18px 0}
.dd-progress progress{width:100%;height:8px}
.dd-progress span{font-size:12px;opacity:.65}
.dd-metric strong{font-size:38px;font-weight:600}
.dd-list{padding:0;list-style:none}
.dd-list li{display:flex;gap:14px;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--dd-line);overflow-wrap:anywhere}
.dd-list small{white-space:nowrap;opacity:.65}
.dd-markdown{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px}
.dd-catalog{position:sticky;top:24px;align-self:start;max-height:calc(100vh - 48px);overflow:auto;border:1px solid var(--dd-line);border-radius:var(--dd-radius);padding:16px;background:var(--dd-glass);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);box-shadow:var(--dd-elev-md)}
.dd-catalog-entry{display:flex;justify-content:space-between;gap:10px;padding:14px 0;border-bottom:1px solid var(--dd-line)}
.dd-catalog-entry strong{display:block;font-size:14px;overflow-wrap:anywhere}
.dd-catalog-entry small{display:block;font-size:11px;opacity:.65;overflow-wrap:anywhere}
.dd-empty{padding:40px 24px;text-align:center;border:1px dashed var(--dd-line);border-radius:var(--dd-radius);opacity:.7}
.dd-error{border:1px solid color-mix(in srgb,var(--dd-danger) 45%,var(--dd-line));padding:16px;border-radius:10px;margin:12px 0;background:color-mix(in srgb,var(--dd-danger) 8%,var(--dd-surface));box-shadow:var(--dd-elev-sm)}
.dd-error strong{color:var(--dd-danger)}
.dd-error p{margin:6px 0}
.dd-error code{font:inherit;font-size:12px;opacity:.85}
.dd-placement{font-size:12px;margin-top:12px}
.dd-placement form{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.dd-placement label{display:grid;gap:3px}
.dd-placement input{width:64px}
.dd-skeleton{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-rows:minmax(90px,auto);gap:12px;margin-top:16px}
.dd-skeleton-card{grid-column:span 4;min-height:130px;border:1px solid var(--dd-line);border-radius:var(--dd-radius);background:linear-gradient(100deg,var(--dd-skeleton) 30%,var(--dd-skeleton-sheen) 50%,var(--dd-skeleton) 70%);background-size:200% 100%;animation:dsh-ui-shimmer 1.4s linear infinite}
.dd-skeleton-card:nth-child(2){grid-column:span 5}
.dd-skeleton-card:nth-child(3){grid-column:span 3}
@keyframes dsh-ui-shimmer{from{background-position:-200% 0}to{background-position:200% 0}}
@media (prefers-reduced-motion: reduce){
  .dsh-dashboard,.dsh-dashboard *{animation:none!important;transition:none!important}
  .dd-card:hover{translate:none}
}
@media(max-width:850px){.dsh-dashboard{padding:16px}.dd-body{grid-template-columns:1fr}.dd-catalog{position:static;max-height:none;border-left:0;border-top:1px solid var(--dd-line);padding:12px 0;background:none;backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:none}.dd-header{flex-wrap:wrap}.dd-header h1{font-size:26px}.dd-grid,.dd-skeleton{display:flex;flex-direction:column}.dd-card{min-height:180px}.dd-skeleton-card{min-height:120px}}
`;
