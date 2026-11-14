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
.dsh-wb-llm fieldset { border: 0; border-top: 0.5px solid var(--wb-hairline); border-radius: 0; padding: 10px 0 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.dsh-wb-log {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--wb-radius-xs, 6px);
  border: 0.5px solid var(--wb-hairline);
  background: var(--wb-input);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.dsh-wb-log-list { display: flex; flex-direction: column; gap: 8px; }

/* --- Shared feature primitives -------------------------------------------
   The spinner and the pulse badge report a state that is still running. They
   are decorative: the text next to them carries the meaning. */
.dsh-wb-status-line { margin: 0; display: flex; align-items: center; gap: 8px; color: var(--wb-muted, #989ea8); }
.dsh-wb-spin {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: 50%;
  border: 2px solid var(--wb-border, rgba(255,255,255,0.12));
  border-top-color: var(--wb-accent, #4c8dff);
  animation: dsh-wb-spin 0.9s linear infinite;
}
@keyframes dsh-wb-spin { to { transform: rotate(360deg); } }
.dsh-wb-pulse-dot {
  width: 8px;
  height: 8px;
  flex: none;
  display: inline-block;
  border-radius: 50%;
  background: var(--wb-accent, #4c8dff);
  animation: dsh-wb-pulse 1.6s ease-out infinite;
}
@keyframes dsh-wb-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--wb-accent, #4c8dff) 45%, transparent); }
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
  display: flex;
  flex-direction: column;
}
.dsh-wb-blueprint-card-row { display: block; }
.dsh-wb-blueprint-card {
  padding: 10px 0;
  border: 0;
  border-bottom: 0.5px solid var(--wb-hairline, rgba(255,255,255,0.08));
  border-radius: 0;
  background: transparent;
  transition: background-color var(--wb-dur-fast, 120ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-blueprint-card-row:hover .dsh-wb-blueprint-card {
  background: var(--wb-hover, rgba(255,255,255,0.04));
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
  padding: 8px 0;
  border: 0;
  border-bottom: 0.5px solid var(--wb-hairline, rgba(255,255,255,0.08));
  border-radius: 0;
  background: transparent;
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
.dsh-wb-blueprint-dot[data-status="failed"] { background: var(--wb-danger, #e05252); }
.dsh-wb-blueprint-dot[data-severity="warning"],
.dsh-wb-blueprint-dot[data-status="not-run"] { background: var(--wb-warn, #d9a441); }
.dsh-wb-blueprint-dot[data-severity="info"],
.dsh-wb-blueprint-dot[data-status="succeeded"] { background: var(--wb-ok, #39bf83); }
.dsh-wb-dl dd[data-blueprint-stage] { display: flex; gap: 8px; align-items: flex-start; }
.dsh-wb-blueprint-apply { gap: 6px 12px; }
.dsh-wb-blueprint-create { display: flex; flex-direction: column; gap: 10px; }
.dsh-wb-blueprint-notes { display: flex; flex-direction: column; gap: 6px; }
.dsh-wb-blueprint-package-list { display: flex; flex-direction: column; gap: 6px; }
.dsh-wb-blueprint-binding-list { display: flex; flex-direction: column; gap: 10px; }
.dsh-wb-blueprint-package {
  padding: 8px 0;
  border: 0;
  border-bottom: 0.5px solid var(--wb-hairline, rgba(255,255,255,0.08));
  border-radius: 0;
  background: transparent;
}
.dsh-wb-blueprint-package:hover {
  background: var(--wb-hover, rgba(255,255,255,0.04));
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
  background: var(--wb-accent, #4c8dff);
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
  background: var(--wb-accent, #4c8dff);
}
.dsh-wb-template-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.dsh-wb-template-item { display: block; }
.dsh-wb-template-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border: 0;
  border-bottom: 0.5px solid var(--wb-hairline, rgba(255,255,255,0.08));
  border-radius: 0;
  background: transparent;
  transition: background-color var(--wb-dur-fast, 120ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-template-card:hover {
  background: var(--wb-hover, rgba(255,255,255,0.04));
}
.dsh-wb-template-card[data-selected="true"] {
  background: var(--wb-active, rgba(255,255,255,0.07));
}
.dsh-wb-template-card-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-wb-template-card-body p { margin: 0; }
.dsh-wb-template-cards { display: flex; flex-direction: column; }
.dsh-wb-template-cards .dsh-wb-template-card { flex-direction: column; align-items: stretch; }
.dsh-wb-template-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 0;
  border: 0;
  border-top: 0.5px solid var(--wb-hairline, rgba(255,255,255,0.08));
  border-radius: 0;
  background: transparent;
}
.dsh-wb-template-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 0;
  color: var(--wb-muted);
}
.dsh-wb-dropzone {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  padding: 18px 16px;
  border-radius: var(--wb-radius-sm, 8px);
  border: 1px dashed var(--wb-border, rgba(255,255,255,0.15));
  background: var(--wb-input, rgba(255,255,255,0.03));
  transition: border-color var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)), background var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-dropzone:hover {
  border-color: color-mix(in srgb, var(--wb-accent, #4c8dff) 55%, var(--wb-border, transparent));
  background: var(--wb-hover, rgba(255,255,255,0.05));
}
.dsh-wb-dropzone[data-drag-over="true"] {
  border-color: var(--wb-accent, #4c8dff);
  border-style: solid;
  background: var(--wb-active, rgba(255,255,255,0.08));
}
.dsh-wb-dropzone-title { margin: 0; font-weight: 500; }
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
  padding: 12px 0;
  border: 0;
  border-bottom: 0.5px solid var(--wb-hairline, rgba(255,255,255,0.08));
  border-radius: 0;
  background: transparent;
}
.dsh-wb-product-list { display: flex; flex-direction: column; }
.dsh-wb-space-row.dsh-wb-product-card {
  border: 0;
  border-bottom: 0.5px solid var(--wb-hairline, rgba(255,255,255,0.08));
  border-radius: 0;
  padding: 10px 4px;
  background: transparent;
  transition: background-color var(--wb-dur-fast, 120ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-space-row.dsh-wb-product-card:hover {
  background: var(--wb-hover, rgba(255,255,255,0.04));
}
.dsh-wb-space-row.dsh-wb-product-card[data-selected="true"] {
  background: var(--wb-active, rgba(255,255,255,0.08));
}
.dsh-wb-plugin-group { display: flex; flex-direction: column; }
.dsh-wb-plugin-category {
  margin: 10px 0 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--wb-muted);
}
.dsh-wb-plugin-card {
  border: 0;
  border-bottom: 0.5px solid var(--wb-hairline, rgba(255,255,255,0.08));
  border-radius: 0;
  padding: 10px 0;
  background: transparent;
  transition: background-color var(--wb-dur-fast, 120ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-plugin-card:hover {
  background: var(--wb-hover, rgba(255,255,255,0.04));
}
.dsh-wb-plugin-card[data-selected="true"] {
  background: var(--wb-active, rgba(255,255,255,0.08));
}
.dsh-wb-plugin-card > .dsh-wb-space-row {
  padding: 0;
  border-bottom: 0;
  background: transparent;
}
.dsh-wb-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: var(--wb-radius-xs, 6px);
  font-size: 11px;
  font-weight: 500;
  background: color-mix(in srgb, var(--wb-ok, #39bf83) 14%, transparent);
  color: var(--wb-ok, #39bf83);
  border: 0.5px solid color-mix(in srgb, var(--wb-ok, #39bf83) 32%, transparent);
  vertical-align: middle;
}
.dsh-wb-plugin-inline {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 0.5px solid var(--wb-hairline, rgba(255,255,255,0.08));
}
.dsh-wb-create-advanced {
  border: 0;
  border-top: 0.5px solid var(--wb-hairline, rgba(255,255,255,0.08));
  border-radius: 0;
  padding: 12px 0 0;
}
.dsh-wb-create-advanced > summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-muted);
}
.dsh-wb-create-advanced[open] > summary {
  margin-bottom: 10px;
  color: var(--wb-text);
}
.dsh-wb-create-advanced-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dsh-wb-glass {
  background: var(--wb-panel, #18191d);
}

/* --- LLM ------------------------------------------------------------------ */
.dsh-wb-llm-editor-shell, .dsh-wb-llm-delete-shell { display: flex; flex-direction: column; gap: 12px; }
.dsh-wb-llm-step { display: flex; flex-direction: column; gap: 10px; }
.dsh-wb-llm-connection-list { display: flex; flex-direction: column; }
.dsh-wb-llm-connection-row {
  position: relative;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 10px 8px 10px 12px;
  border: 0;
  border-bottom: 0.5px solid var(--wb-hairline, rgba(255,255,255,0.08));
  border-radius: 0;
  background: transparent;
  transition: background-color var(--wb-dur-fast, 120ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1));
}
.dsh-wb-llm-connection-row:hover { background: var(--wb-hover, rgba(255,255,255,0.04)); }
.dsh-wb-llm-connection-indicator {
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: var(--wb-accent, #4c8dff);
}
.dsh-wb-llm-map-list { display: flex; flex-direction: column; gap: 10px; }
.dsh-wb-llm tbody tr { transition: background var(--wb-dur-base, 200ms) var(--wb-ease-standard, cubic-bezier(0.2,0,0,1)); }
.dsh-wb-llm tbody tr:hover { background: var(--wb-hover, rgba(255,255,255,0.04)); }
.dsh-wb-lang button { position: relative; }
.dsh-wb-lang-indicator {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  .dsh-wb-spin, .dsh-wb-pulse-dot { animation: none !important; }
}
`;
