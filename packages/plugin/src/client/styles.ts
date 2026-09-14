/**
 * Scoped panel styles. Every rule is namespaced under `.dsh-spaces` so the
 * sheet cannot leak into the host app. Colors prefer the DSH `--dsw` theme
 * tokens (evidence: shipped dsh-client-ui-sidebar stylesheet) with static
 * fallbacks so the panel stays legible if a token is absent.
 */
export const SPACES_PANEL_CSS = `
.dsh-spaces {
  box-sizing: border-box;
  height: 100%;
  display: flex;
  flex-direction: column;
  color: var(--dsw-alias-label-primary, #1f2328);
  background: var(--dsw-alias-app-bg, var(--dsw-specific-sidebar-fill, #ffffff));
  font-size: 14px;
  line-height: 1.5;
  overflow: hidden;
}
.dsh-spaces *, .dsh-spaces *::before, .dsh-spaces *::after { box-sizing: inherit; }

.dsh-spaces-header {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08));
}
.dsh-spaces-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  flex: 1;
  min-width: 0;
}
.dsh-spaces-lang {
  display: inline-flex;
  flex: none;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  overflow: hidden;
}
.dsh-spaces-lang-btn {
  font: inherit;
  cursor: pointer;
  border: none;
  background: transparent;
  color: inherit;
  padding: 4px 10px;
  line-height: 22px;
  font-size: 13px;
}
.dsh-spaces-lang-btn[aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-active, rgba(0, 0, 0, 0.1));
  font-weight: 500;
}
.dsh-spaces-lang-btn:hover:not([aria-pressed="true"]) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
}
.dsh-spaces-refresh {
  font: inherit;
  cursor: pointer;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  background: var(--dsw-alias-button-elevated-fill, transparent);
  color: inherit;
  border-radius: 8px;
  padding: 4px 12px;
  line-height: 22px;
}
.dsh-spaces-refresh:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
}
.dsh-spaces-refresh:disabled { opacity: 0.6; cursor: default; }
.dsh-spaces-refresh:focus-visible,
.dsh-spaces button:focus-visible,
.dsh-spaces input:focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary, #1f2328);
  outline-offset: 1px;
}

.dsh-spaces-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  overflow: hidden;
}
@media (max-width: 720px) {
  .dsh-spaces-body { grid-template-columns: 1fr; grid-template-rows: minmax(120px, 40%) minmax(0, 1fr); }
}

.dsh-spaces-sidebar {
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  border-right: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08));
  display: flex;
  flex-direction: column;
  gap: 12px;
}
@media (max-width: 720px) {
  .dsh-spaces-sidebar { border-right: none; border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08)); }
}

.dsh-spaces-capabilities {
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
.dsh-spaces-mode { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-spaces-version {
  color: var(--dsw-alias-label-secondary, #59636e);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
}
.dsh-spaces-reasons { margin: 0; padding-left: 18px; color: var(--dsw-alias-label-secondary, #59636e); }
.dsh-spaces-reasons li { margin: 2px 0; }

.dsh-spaces-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dsh-spaces-item {
  width: 100%;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border: none;
  border-radius: 8px;
  background: none;
  color: inherit;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dsh-spaces-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06)); }
.dsh-spaces-item[aria-selected="true"] {
  background: var(--dsw-alias-interactive-bg-active, rgba(0, 0, 0, 0.1));
  font-weight: 500;
}
.dsh-spaces-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-spaces-status {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-label-secondary, #59636e);
}
.dsh-spaces-status[data-status="running"] { background: var(--dsw-alias-success, #1a7f37); }
.dsh-spaces-status[data-status="stopped"] { background: var(--dsw-alias-label-secondary, #59636e); }

.dsh-spaces-badge {
  flex: none;
  font-size: 11px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 4px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.16));
  color: var(--dsw-alias-label-secondary, #59636e);
  white-space: nowrap;
}
.dsh-spaces-badge[data-tone="host"] {
  color: var(--dsw-alias-label-primary-inverted, #ffffff);
  background: var(--dsw-alias-label-primary, #1f2328);
  border-color: transparent;
}
.dsh-spaces-badge[data-tone="verified"] { color: var(--dsw-alias-success, #1a7f37); }
.dsh-spaces-badge[data-tone="invalid"] { color: var(--dsw-alias-danger, #d1242f); }

.dsh-spaces-detail {
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dsh-spaces-detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-spaces-detail-title { margin: 0; font-size: 15px; font-weight: 600; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dsh-spaces-meta { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; font-size: 13px; }
.dsh-spaces-meta dt { color: var(--dsw-alias-label-secondary, #59636e); margin: 0; }
.dsh-spaces-meta dd { margin: 0; overflow-wrap: anywhere; }
.dsh-spaces-meta dd code { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 12px; }

.dsh-spaces-section-title { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.dsh-spaces-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dsh-spaces-table th, .dsh-spaces-table td { text-align: left; padding: 4px 8px 4px 0; vertical-align: top; }
.dsh-spaces-table th { color: var(--dsw-alias-label-secondary, #59636e); font-weight: 500; }
.dsh-spaces-table td code { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 12px; }

.dsh-spaces-diagnostics { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dsh-spaces-diagnostic {
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
}
.dsh-spaces-diagnostic[data-level="warning"] { border-color: var(--dsw-alias-warning, #9a6700); }
.dsh-spaces-diagnostic[data-level="error"] { border-color: var(--dsw-alias-danger, #d1242f); }
.dsh-spaces-diagnostic-code {
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #59636e);
  margin-right: 6px;
}

.dsh-spaces-form { display: flex; flex-direction: column; gap: 8px; }
.dsh-spaces-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.dsh-spaces-field input {
  font: inherit;
  color: inherit;
  background: var(--dsw-alias-input-bg, transparent);
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.2));
  border-radius: 8px;
  padding: 6px 10px;
}
.dsh-spaces-submit {
  font: inherit;
  cursor: pointer;
  align-self: flex-start;
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  color: var(--dsw-alias-label-primary-inverted, #ffffff);
  background: var(--dsw-alias-label-primary, #1f2328);
}
.dsh-spaces-submit:disabled { opacity: 0.55; cursor: default; }

.dsh-spaces-action {
  font: inherit;
  cursor: pointer;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  background: var(--dsw-alias-button-elevated-fill, transparent);
  color: inherit;
  border-radius: 8px;
  padding: 4px 12px;
}
.dsh-spaces-action:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06)); }
.dsh-spaces-action:disabled { opacity: 0.6; cursor: default; }

.dsh-spaces-alert {
  border: 0.5px solid var(--dsw-alias-danger, #d1242f);
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--dsw-alias-danger, #d1242f);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.dsh-spaces-notice {
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #59636e);
}
.dsh-spaces-notice[data-tone="ok"] { color: var(--dsw-alias-success, #1a7f37); border-color: var(--dsw-alias-success, #1a7f37); }
.dsh-spaces-muted { color: var(--dsw-alias-label-secondary, #59636e); margin: 0; }
.dsh-spaces-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.dsh-spaces-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--dsw-alias-label-secondary, #59636e);
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .dsh-spaces * { transition: none; animation: none; }
}
`;
