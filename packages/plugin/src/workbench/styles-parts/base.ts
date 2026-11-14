/**
 * Workbench base rules.
 *
 * Root-level rules (contained layout, resets, focus), buttons, fields, alerts,
 * notices, tables and the generic utilities. The `.dsh-workbench` rule with
 * the workbench variables lives in tokens.ts.
 *
 * The material is layered: surfaces sit on a translucent veil with a hairline
 * and an elevation shadow, controls react to hover and press, and focus rings
 * come from the shared focus token.
 */

/** A banner lifts into place. The content stays visible the whole time. */
const LIFT = `
@keyframes dsh-wb-lift {
  from { transform: translateY(8px); }
  to { transform: translateY(0); }
}
@keyframes dsh-wb-rail-in {
  from { opacity: 0; transform: translateY(6px) scale(0.94); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes dsh-wb-sheen {
  from { background-position: -160% 0; }
  to { background-position: 160% 0; }
}
`;

export const WORKBENCH_BASE_CSS = `${LIFT}
.dsh-workbench[data-contained="true"] { flex-direction:column; }
.dsh-wb-contained-tools { display:flex; gap:8px; padding:8px 12px; flex:none; border-bottom:0.5px solid var(--wb-hairline); background:var(--wb-panel); }
.dsh-workbench *, .dsh-workbench *::before, .dsh-workbench *::after { box-sizing: inherit; }
.dsh-workbench button, .dsh-workbench input, .dsh-workbench select, .dsh-workbench textarea {
  font: inherit;
  color: inherit;
}
.dsh-workbench button:focus-visible,
.dsh-workbench input:focus-visible,
.dsh-workbench select:focus-visible,
.dsh-workbench textarea:focus-visible {
  outline: none;
  box-shadow: var(--wb-focus-ring);
}

.dsh-wb-kicker { margin: 0; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--wb-faint); }
.dsh-wb-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; letter-spacing: 0; }
h3.dsh-wb-title, h4.dsh-wb-title { font-size: 14px; line-height: 22px; font-weight: 500; }
.dsh-wb-muted { margin: 0; font-size: 13px; line-height: 20px; color: var(--wb-muted); }
.dsh-wb-alert {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--wb-radius-xs);
  border: 0.5px solid color-mix(in srgb, var(--wb-danger) 36%, transparent);
  border-left: 3px solid var(--wb-danger);
  background-color: color-mix(in srgb, var(--wb-danger) 8%, var(--wb-panel));
  color: var(--wb-danger);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
}
.dsh-wb-notice {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--wb-radius-xs);
  border: 0.5px solid var(--wb-hairline);
  border-left: 3px solid var(--wb-accent);
  background-color: var(--wb-panel-2);
  color: var(--wb-muted);
  font-size: 13px;
  line-height: 20px;
}
.dsh-wb-row, .dsh-wb-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dsh-wb-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 0;
  color: var(--wb-muted);
  font-size: 13px;
  line-height: 20px;
}
.dsh-wb-empty p { margin: 0; }
.dsh-wb-space-row {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 0;
  border-radius: 0;
  border-bottom: 0.5px solid var(--wb-hairline);
  transition: background-color var(--wb-dur-fast) var(--wb-ease-standard);
}
.dsh-wb-space-row:hover { background-color: var(--wb-hover); }
.dsh-wb-space-row > span { flex: 1; min-width: 0; }
.dsh-wb-space-row small { color: var(--wb-muted); font-size: 12px; line-height: 18px; }
.dsh-wb-space-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 4px;
  margin: 0;
  border: 0;
  border-radius: var(--wb-radius-xs);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.dsh-wb-space-row-main > span { flex: 1; min-width: 0; }
.dsh-wb-space-row-main > img.dsh-wb-glyph-img { border-radius: 50%; }
.dsh-wb-form { display: flex; flex-direction: column; gap: 12px; max-width: 420px; }
.dsh-wb-form.wide { max-width: min(720px, 100%); }
.dsh-wb-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; line-height: 20px; }
.dsh-wb-field input, .dsh-wb-field select, .dsh-wb-field textarea {
  background: var(--wb-input);
  border: 0.5px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  padding: 6px 10px;
  min-height: 34px;
  font-size: 13px;
  line-height: 20px;
  transition: border-color var(--wb-dur-fast) var(--wb-ease-standard);
}
.dsh-wb-field textarea { min-height: 76px; }
.dsh-wb-field input:focus-visible, .dsh-wb-field select:focus-visible, .dsh-wb-field textarea:focus-visible {
  border-color: var(--wb-accent);
  box-shadow: none;
}
.dsh-wb-check { display: flex; gap: 8px; align-items: center; font-size: 13px; line-height: 20px; }
.dsh-wb-pre {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--wb-input);
  border: 0.5px solid var(--wb-hairline);
  border-radius: var(--wb-radius-sm);
  padding: 8px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
}
.dsh-wb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  align-self: flex-start;
  cursor: pointer;
  min-height: 32px;
  border: 0.5px solid var(--wb-border);
  background-color: transparent;
  border-radius: var(--wb-radius-sm);
  padding: 5px 12px;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  transition: background-color var(--wb-dur-fast) var(--wb-ease-standard),
    border-color var(--wb-dur-fast) var(--wb-ease-standard),
    color var(--wb-dur-fast) var(--wb-ease-standard),
    opacity var(--wb-dur-fast) var(--wb-ease-standard);
}
.dsh-wb-btn:hover:not(:disabled) {
  background-color: var(--wb-hover);
  border-color: color-mix(in srgb, var(--wb-text) 20%, transparent);
}
.dsh-wb-btn:active:not(:disabled) { background-color: var(--wb-active); }
.dsh-wb-btn:disabled { opacity: 0.45; cursor: default; }
.dsh-wb-btn.primary {
  background-color: var(--wb-btn-primary-bg, var(--wb-accent));
  color: var(--wb-btn-primary-ink, var(--wb-accent-ink));
  border-color: transparent;
}
.dsh-wb-btn.primary:hover:not(:disabled) {
  background-color: var(--wb-btn-primary-hover, var(--wb-accent));
  border-color: transparent;
}
.dsh-wb-btn.danger { color: var(--wb-danger); border-color: color-mix(in srgb, var(--wb-danger) 42%, transparent); }
.dsh-wb-btn.danger:hover:not(:disabled) { background-color: color-mix(in srgb, var(--wb-danger) 10%, transparent); border-color: color-mix(in srgb, var(--wb-danger) 60%, transparent); }
.dsh-wb-lang {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  border: 0.5px solid var(--wb-hairline);
  border-radius: var(--wb-radius-sm);
  background-color: var(--wb-panel-2);
  flex-shrink: 0;
}
.dsh-wb-lang button {
  border: 0;
  border-radius: var(--wb-radius-xs);
  background: transparent;
  padding: 4px 10px;
  font-size: 13px;
  line-height: 18px;
  color: var(--wb-muted);
  cursor: pointer;
  transition: background-color var(--wb-dur-fast) var(--wb-ease-standard), color var(--wb-dur-fast) var(--wb-ease-standard);
}
.dsh-wb-lang button:hover { color: var(--wb-text); }
.dsh-wb-lang button[aria-pressed="true"] { background-color: var(--wb-panel); color: var(--wb-text); font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,0.12); }
.dsh-wb-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dsh-wb-table th, .dsh-wb-table td { text-align: left; padding: 8px 10px 8px 0; vertical-align: top; border-bottom: 0.5px solid var(--wb-hairline); }
.dsh-wb-table th { color: var(--wb-muted); font-weight: 500; }
.dsh-wb-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--wb-muted); }
.dsh-wb-dl { margin: 0; display: grid; grid-template-columns: auto minmax(0,1fr); gap: 6px 16px; font-size: 13px; line-height: 20px; }
.dsh-wb-dl dt { color: var(--wb-muted); }
.dsh-wb-dl dd { margin: 0; overflow-wrap: anywhere; }
.dsh-wb-sr {
  position: absolute;
  width: 1px; height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.dsh-wb-job-details { font-size: 12px; line-height: 18px; color: var(--wb-muted); }
.dsh-wb-job-details summary { cursor: pointer; }
.dsh-wb-job-details .dsh-wb-dl { margin-top: 8px; }
`;
