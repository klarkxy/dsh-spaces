/**
 * Workbench feature rules.
 *
 * Home, LLM and log rules that exist today, plus the material of the feature
 * surfaces: blueprint cards, product steps, the LLM connection rows, the
 * loading shimmer and the status badges.
 *
 * The rules use the `--wb-*` variables of the workbench, which the shared
 * `--dsh-ui-*` token layer feeds. Every fall back to a plain value, so the
 * surface stays usable before the token layer is applied.
 */

export const WORKBENCH_FEATURES_CSS = `
.dsh-wb-home {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: auto;
  padding: 20px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: var(--wb-bg);
}
.dsh-wb-llm, .dsh-wb-llm-editor, .dsh-wb-llm-spaces { display: flex; flex-direction: column; gap: 12px; }
.dsh-wb-llm table { font-size: 12px; }
.dsh-wb-llm fieldset { border: 1px solid var(--wb-border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.dsh-wb-log {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--wb-input);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* --- Shared feature primitives -------------------------------------------
   The spinner and the pulse badge report a state that is still running. They
   are decorative: the text next to them carries the meaning. */
.dsh-wb-status-line { margin: 0; display: flex; align-items: center; gap: 8px; color: var(--wb-muted, #9aa0a6); }
.dsh-wb-spin {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: 50%;
  border: 2px solid var(--wb-border, rgba(255,255,255,0.15));
  border-top-color: var(--wb-accent, #5865f2);
  animation: dsh-wb-spin 0.9s linear infinite;
}
@keyframes dsh-wb-spin { to { transform: rotate(360deg); } }
.dsh-wb-pulse-dot {
  width: 8px;
  height: 8px;
  flex: none;
  display: inline-block;
  border-radius: 50%;
  background: var(--wb-accent, #5865f2);
  animation: dsh-wb-pulse 1.6s ease-out infinite;
}
@keyframes dsh-wb-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--wb-accent, #5865f2) 55%, transparent); }
  70% { box-shadow: 0 0 0 7px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

/* --- Blueprint ------------------------------------------------------------ */
.dsh-wb-blueprint-inspect,
.dsh-wb-blueprint-preview,
.dsh-wb-blueprint-output,
.dsh-wb-blueprint-inputs { display: flex; flex-direction: column; gap: 10px; }
.dsh-wb-blueprint-cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
}
.dsh-wb-blueprint-card-row { display: block; }
.dsh-wb-blueprint-card {
  padding: 10px 12px;
  border-radius: var(--wb-radius-sm, 8px);
  border: 1px solid var(--wb-border, rgba(255,255,255,0.15));
  background: var(--wb-panel, #18191d);
  box-shadow: var(--wb-elev-sm, 0 1px 2px rgba(0,0,0,0.32));
  transition: transform var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), box-shadow var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), border-color var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-blueprint-card-row:hover .dsh-wb-blueprint-card {
  transform: translateY(-2px);
  box-shadow: var(--wb-elev-md, 0 6px 18px -8px rgba(0,0,0,0.55)), 0 0 22px -14px var(--wb-accent, #5865f2);
  border-color: color-mix(in srgb, var(--wb-accent, #5865f2) 45%, var(--wb-border, transparent));
}
.dsh-wb-blueprint-input-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-wb-blueprint-diagnostics { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dsh-wb-blueprint-diagnostic {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 10px;
  border-radius: var(--wb-radius-sm, 8px);
  border: 1px solid var(--wb-border, rgba(255,255,255,0.15));
  background: var(--wb-panel, #18191d);
}
.dsh-wb-blueprint-dot {
  width: 8px;
  height: 8px;
  flex: none;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--wb-faint, #6e7378);
}
.dsh-wb-blueprint-dot[data-severity="error"],
.dsh-wb-blueprint-dot[data-status="failed"] { background: var(--wb-danger, #d1242f); box-shadow: 0 0 10px -2px var(--wb-danger, #d1242f); }
.dsh-wb-blueprint-dot[data-severity="warning"],
.dsh-wb-blueprint-dot[data-status="not-run"] { background: var(--wb-warn, #c9a227); }
.dsh-wb-blueprint-dot[data-severity="info"],
.dsh-wb-blueprint-dot[data-status="succeeded"] { background: var(--wb-ok, #3ba55d); }
.dsh-wb-dl dd[data-blueprint-stage] { display: flex; gap: 8px; align-items: flex-start; }
.dsh-wb-blueprint-apply { gap: 6px 12px; }
.dsh-wb-blueprint-create { display: flex; flex-direction: column; gap: 10px; }
.dsh-wb-blueprint-notes { display: flex; flex-direction: column; gap: 6px; }
.dsh-wb-blueprint-package-list { display: flex; flex-direction: column; gap: 6px; }
.dsh-wb-blueprint-binding-list { display: flex; flex-direction: column; gap: 10px; }
.dsh-wb-blueprint-package {
  padding: 8px 10px;
  border-radius: var(--wb-radius-sm, 8px);
  border: 1px solid var(--wb-border, rgba(255,255,255,0.15));
  background: var(--wb-panel, #18191d);
  transition: transform var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), box-shadow var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), border-color var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-blueprint-package:hover {
  transform: translateY(-1px);
  box-shadow: var(--wb-elev-sm, 0 1px 2px rgba(0,0,0,0.32));
  border-color: color-mix(in srgb, var(--wb-accent, #5865f2) 40%, var(--wb-border, transparent));
}
.dsh-wb-blueprint-tab { position: relative; }
.dsh-wb-blueprint-tab[aria-selected="true"] { border-bottom-color: transparent; }
.dsh-wb-blueprint-tab-indicator {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--wb-accent-gradient, linear-gradient(135deg, #5865f2 0%, #8b5cf6 100%));
  box-shadow: 0 0 16px -4px var(--wb-accent, #5865f2);
}
@supports selector(::details-content) {
  details.dsh-wb-form::details-content,
  [data-blueprint-inspect="true"] details::details-content {
    block-size: auto;
    overflow: clip;
    opacity: 1;
    transition: block-size var(--wb-dur-slow, 360ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), opacity var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), content-visibility var(--wb-dur-slow, 360ms) allow-discrete;
  }
  details.dsh-wb-form:not([open])::details-content,
  [data-blueprint-inspect="true"] details:not([open])::details-content { opacity: 0; }
}

/* --- Space templates ------------------------------------------------------
   The unified template page: a section switch, a card grid and a glass drop
   zone. The cards lift on hover, the drop zone glows while a file is over it. */
.dsh-wb-templates { display: flex; flex-direction: column; gap: 16px; }
.dsh-wb-templates-section { display: flex; flex-direction: column; gap: 12px; }
.dsh-wb-template-tabs { gap: 18px; }
.dsh-wb-template-tab { position: relative; }
.dsh-wb-template-tab[aria-selected="true"] { border-bottom-color: transparent; }
.dsh-wb-template-tab-indicator {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--wb-accent-gradient, linear-gradient(135deg, #5865f2 0%, #8b5cf6 100%));
  box-shadow: 0 0 16px -4px var(--wb-accent, #5865f2);
}
.dsh-wb-template-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}
.dsh-wb-template-item { display: block; }
.dsh-wb-template-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--wb-radius-md, 12px);
  border: 1px solid var(--wb-border, rgba(255,255,255,0.15));
  background: var(--wb-panel, #18191d);
  box-shadow: var(--wb-elev-sm, 0 1px 2px rgba(0,0,0,0.32));
  transition: transform var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), box-shadow var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), border-color var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-template-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--wb-elev-md, 0 6px 18px -8px rgba(0,0,0,0.55));
  border-color: color-mix(in srgb, var(--wb-accent, #5865f2) 40%, var(--wb-border, transparent));
}
.dsh-wb-template-card[data-selected="true"] {
  border-color: color-mix(in srgb, var(--wb-accent, #5865f2) 65%, var(--wb-border, transparent));
  box-shadow: var(--wb-elev-md, 0 6px 18px -8px rgba(0,0,0,0.55)), 0 0 22px -14px var(--wb-accent, #5865f2);
}
.dsh-wb-template-card-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-wb-template-card-body p { margin: 0; }
.dsh-wb-template-cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); align-items: start; }
.dsh-wb-template-cards .dsh-wb-template-card { flex-direction: column; align-items: stretch; }
.dsh-wb-template-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: var(--wb-radius-md, 12px);
  border: 1px solid var(--wb-border, rgba(255,255,255,0.15));
  background: var(--wb-panel, #18191d);
  box-shadow: var(--wb-elev-sm, 0 1px 2px rgba(0,0,0,0.32));
}
.dsh-wb-template-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 16px;
  border-radius: var(--wb-radius-md, 12px);
  border: 1px dashed var(--wb-border, rgba(255,255,255,0.15));
}
.dsh-wb-dropzone {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 22px 20px;
  border-radius: var(--wb-radius-md, 12px);
  border: 1px dashed color-mix(in srgb, var(--wb-accent, #5865f2) 40%, var(--wb-border, transparent));
  background: var(--wb-glass-bg, rgba(24,25,29,0.72));
  backdrop-filter: var(--wb-glass-blur, blur(18px) saturate(140%));
  -webkit-backdrop-filter: var(--wb-glass-blur, blur(18px) saturate(140%));
  transition: border-color var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), box-shadow var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), background var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-dropzone:hover {
  border-color: color-mix(in srgb, var(--wb-accent, #5865f2) 70%, var(--wb-border, transparent));
  box-shadow: 0 0 26px -14px var(--wb-accent, #5865f2);
}
.dsh-wb-dropzone[data-drag-over="true"] {
  border-color: var(--wb-accent, #5865f2);
  border-style: solid;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--wb-accent, #5865f2) 45%, transparent), 0 0 34px -10px var(--wb-accent, #5865f2);
}
.dsh-wb-dropzone-title { margin: 0; font-weight: 600; }
.dsh-wb-dropzone p { margin: 0; }
.dsh-wb-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* --- Product -------------------------------------------------------------- */
.dsh-wb-product-step {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: var(--wb-radius-md, 12px);
  border: 1px solid var(--wb-border, rgba(255,255,255,0.15));
  background: var(--wb-panel, #18191d);
  box-shadow: var(--wb-elev-sm, 0 1px 2px rgba(0,0,0,0.32));
}
.dsh-wb-product-list { display: flex; flex-direction: column; gap: 8px; }
.dsh-wb-space-row.dsh-wb-product-card {
  border: 1px solid var(--wb-border, rgba(255,255,255,0.15));
  border-radius: var(--wb-radius-sm, 8px);
  padding: 10px 12px;
  background: var(--wb-panel, #18191d);
  transition: transform var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), box-shadow var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), border-color var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-space-row.dsh-wb-product-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--wb-elev-md, 0 6px 18px -8px rgba(0,0,0,0.55));
  border-color: color-mix(in srgb, var(--wb-accent, #5865f2) 40%, var(--wb-border, transparent));
}
.dsh-wb-space-row.dsh-wb-product-card[data-selected="true"] {
  border-color: var(--wb-accent, #5865f2);
  box-shadow: inset 0 0 0 1px var(--wb-accent, #5865f2), var(--wb-elev-sm, 0 1px 2px rgba(0,0,0,0.32));
}
.dsh-wb-glass {
  background: var(--wb-glass-bg, rgba(24,25,29,0.72));
  backdrop-filter: var(--wb-glass-blur, blur(18px) saturate(140%));
  -webkit-backdrop-filter: var(--wb-glass-blur, blur(18px) saturate(140%));
}

/* --- LLM ------------------------------------------------------------------ */
.dsh-wb-llm-editor-shell, .dsh-wb-llm-delete-shell { display: flex; flex-direction: column; gap: 12px; }
.dsh-wb-llm-step { display: flex; flex-direction: column; gap: 10px; }
.dsh-wb-llm-connection-list { display: flex; flex-direction: column; gap: 6px; }
.dsh-wb-llm-connection-row {
  position: relative;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 8px 14px;
  border-radius: var(--wb-radius-sm, 8px);
  border: 1px solid var(--wb-border, rgba(255,255,255,0.15));
  background: var(--wb-panel, #18191d);
  transition: border-color var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-llm-connection-row:hover { border-color: color-mix(in srgb, var(--wb-accent, #5865f2) 40%, var(--wb-border, transparent)); }
.dsh-wb-llm-connection-indicator {
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--wb-accent, #5865f2);
  box-shadow: 0 0 12px -2px var(--wb-accent, #5865f2);
}
.dsh-wb-llm-map-list { display: flex; flex-direction: column; gap: 10px; }
.dsh-wb-llm tbody tr { transition: background var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)); }
.dsh-wb-llm tbody tr:hover { background: color-mix(in srgb, var(--wb-text, #f2f3f5) 4%, transparent); }
.dsh-wb-lang button { position: relative; }
.dsh-wb-lang-indicator {
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--wb-accent, #5865f2);
  box-shadow: 0 0 12px -3px var(--wb-accent, #5865f2);
}

@media (prefers-reduced-motion: reduce) {
  .dsh-wb-spin, .dsh-wb-pulse-dot { animation: none !important; }
  .dsh-wb-blueprint-card-row:hover .dsh-wb-blueprint-card,
  .dsh-wb-space-row.dsh-wb-product-card:hover,
  .dsh-wb-template-card:hover,
  .dsh-wb-blueprint-package:hover { transform: none !important; }
}
`;
