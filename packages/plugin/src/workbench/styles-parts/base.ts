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
.dsh-wb-contained-tools { display:flex; gap:8px; padding:8px 12px; flex:none; border-bottom:1px solid var(--wb-hairline); background:var(--wb-panel); }
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
.dsh-wb-title { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
.dsh-wb-muted { margin: 0; color: var(--wb-muted); }
.dsh-wb-alert {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--wb-radius-sm);
  border: 1px solid color-mix(in srgb, var(--wb-danger) 52%, transparent);
  background-color: color-mix(in srgb, var(--wb-danger) 12%, var(--wb-panel));
  color: var(--wb-danger);
  white-space: pre-wrap;
  box-shadow: var(--wb-elev-sm);
}
.dsh-wb-notice {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--wb-radius-sm);
  border: 1px solid var(--wb-hairline);
  background-color: var(--wb-veil);
  backdrop-filter: var(--wb-glass-blur);
  color: var(--wb-muted);
  box-shadow: var(--wb-elev-sm);
}
.dsh-wb-row, .dsh-wb-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dsh-wb-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 20px;
  border: 1px dashed var(--wb-hairline);
  border-radius: var(--wb-radius-md);
}
.dsh-wb-space-row {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 0;
  border-radius: var(--wb-radius-sm);
  border-bottom: 1px solid var(--wb-border);
  transition: background-color var(--wb-dur-fast) var(--wb-ease-standard);
}
.dsh-wb-space-row:hover { background-color: color-mix(in srgb, var(--wb-text) 4%, transparent); }
.dsh-wb-space-row > span { flex: 1; min-width: 0; }
.dsh-wb-form { display: flex; flex-direction: column; gap: 12px; max-width: 420px; }
.dsh-wb-form.wide { max-width: min(720px, 100%); }
.dsh-wb-field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; }
.dsh-wb-field input, .dsh-wb-field select, .dsh-wb-field textarea {
  background: var(--wb-input);
  border: 1px solid var(--wb-hairline);
  border-radius: var(--wb-radius-sm);
  padding: 8px 11px;
  transition: border-color var(--wb-dur-fast) var(--wb-ease-standard), box-shadow var(--wb-dur-base) var(--wb-ease-standard);
}
.dsh-wb-field input:focus-visible, .dsh-wb-field select:focus-visible, .dsh-wb-field textarea:focus-visible {
  border-color: var(--wb-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--wb-accent) 35%, transparent);
}
.dsh-wb-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
.dsh-wb-pre {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--wb-input);
  border: 1px solid var(--wb-hairline);
  border-radius: var(--wb-radius-sm);
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.dsh-wb-btn {
  cursor: pointer;
  border: 1px solid var(--wb-hairline);
  background-color: transparent;
  border-radius: var(--wb-radius-sm);
  padding: 7px 13px;
  font-weight: 500;
  transition: background-color var(--wb-dur-fast) var(--wb-ease-standard),
    border-color var(--wb-dur-fast) var(--wb-ease-standard),
    color var(--wb-dur-fast) var(--wb-ease-standard),
    box-shadow var(--wb-dur-base) var(--wb-ease-standard),
    transform var(--wb-dur-fast) var(--wb-ease-standard);
}
.dsh-wb-btn:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--wb-text) 8%, transparent);
  border-color: color-mix(in srgb, var(--wb-text) 24%, transparent);
}
.dsh-wb-btn:active:not(:disabled) { transform: scale(0.97); }
.dsh-wb-btn:disabled { opacity: 0.45; cursor: default; }
.dsh-wb-btn.primary {
  background-color: var(--wb-accent);
  background-image: var(--wb-accent-gradient);
  color: var(--wb-accent-ink);
  border-color: transparent;
  box-shadow: var(--wb-elev-sm);
}
.dsh-wb-btn.primary:hover:not(:disabled) {
  background-color: var(--wb-accent);
  border-color: transparent;
  box-shadow: var(--wb-elev-glow);
  filter: brightness(1.07);
}
.dsh-wb-btn.danger { color: var(--wb-danger); border-color: color-mix(in srgb, var(--wb-danger) 55%, transparent); }
.dsh-wb-btn.danger:hover:not(:disabled) { background-color: color-mix(in srgb, var(--wb-danger) 14%, transparent); }
.dsh-wb-lang {
  display: inline-flex;
  border: 1px solid var(--wb-hairline);
  border-radius: var(--wb-radius-pill);
  overflow: hidden;
  background-color: var(--wb-veil);
  backdrop-filter: var(--wb-glass-blur);
  box-shadow: var(--wb-elev-sm);
}
.dsh-wb-lang button {
  border: 0;
  background: transparent;
  padding: 5px 12px;
  cursor: pointer;
  transition: background-color var(--wb-dur-fast) var(--wb-ease-standard), color var(--wb-dur-fast) var(--wb-ease-standard);
}
.dsh-wb-lang button:hover { background-color: color-mix(in srgb, var(--wb-text) 8%, transparent); }
.dsh-wb-lang button[aria-pressed="true"] { background-color: color-mix(in srgb, var(--wb-accent) 26%, transparent); color: var(--wb-text); font-weight: 600; }
.dsh-wb-lang { flex-shrink: 0; }
.dsh-wb-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dsh-wb-table th, .dsh-wb-table td { text-align: left; padding: 7px 10px 7px 0; vertical-align: top; }
.dsh-wb-table th { color: var(--wb-muted); font-weight: 500; }
.dsh-wb-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--wb-muted); }
.dsh-wb-dl { margin: 0; display: grid; grid-template-columns: auto minmax(0,1fr); gap: 6px 14px; }
.dsh-wb-dl dt { color: var(--wb-muted); }
.dsh-wb-dl dd { margin: 0; overflow-wrap: anywhere; }
.dsh-wb-sr {
  position: absolute;
  width: 1px; height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.dsh-wb-job-details { font-size: 12px; color: var(--wb-muted); }
.dsh-wb-job-details summary { cursor: pointer; }
.dsh-wb-job-details .dsh-wb-dl { margin-top: 8px; }
`;
