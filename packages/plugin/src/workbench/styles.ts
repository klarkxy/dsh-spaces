/** Self-contained workbench styles. No desktop Tailwind. */

export const WORKBENCH_CSS = `
.dsh-workbench[data-theme="light"] {
  --wb-rail: var(--dsw-specific-sidebar-fill, #eceef2);
  --wb-rail-border: var(--dsw-alias-border-l3, rgba(0,0,0,0.08));
  --wb-bg: var(--dsw-alias-bg-base, #f6f7f9);
  --wb-panel: var(--dsw-alias-bg-base, #ffffff);
  --wb-text: var(--dsw-alias-label-primary, #16171a);
  --wb-muted: var(--dsw-alias-label-secondary, #5c6166);
  --wb-faint: var(--dsw-alias-label-tertiary, #8a9096);
  --wb-icon: color-mix(in srgb, var(--wb-text) 10%, var(--wb-bg));
  --wb-border: color-mix(in srgb, var(--wb-text) 15%, transparent);
  --wb-input: color-mix(in srgb, var(--wb-text) 5%, var(--wb-bg));
}
@media (prefers-color-scheme: light) {
  .dsh-workbench[data-theme="system"] {
    --wb-rail: var(--dsw-specific-sidebar-fill, #eceef2);
    --wb-rail-border: var(--dsw-alias-border-l3, rgba(0,0,0,0.08));
    --wb-bg: var(--dsw-alias-bg-base, #f6f7f9);
    --wb-panel: var(--dsw-alias-bg-base, #ffffff);
    --wb-text: var(--dsw-alias-label-primary, #16171a);
    --wb-muted: var(--dsw-alias-label-secondary, #5c6166);
    --wb-faint: var(--dsw-alias-label-tertiary, #8a9096);
  }
}
.dsh-workbench {
  --wb-rail: var(--dsw-specific-sidebar-fill, #16171a);
  --wb-rail-border: var(--dsw-alias-border-l3, rgba(255,255,255,0.08));
  --wb-bg: var(--dsw-alias-bg-base, #0f1012);
  --wb-panel: var(--dsw-alias-bg-base, #18191d);
  --wb-text: var(--dsw-alias-label-primary, #f2f3f5);
  --wb-muted: var(--dsw-alias-label-secondary, #9aa0a6);
  --wb-faint: var(--dsw-alias-label-tertiary, #6e7378);
  --wb-accent: var(--dsw-alias-interactive-primary, #5865f2);
  --wb-accent-ink: #fff;
  --wb-danger: var(--dsw-alias-danger, #d1242f);
  --wb-ok: var(--dsw-alias-success, #3ba55d);
  --wb-warn: var(--dsw-alias-warning, #c9a227);
  --wb-icon: color-mix(in srgb, var(--wb-text) 10%, var(--wb-bg));
  --wb-border: color-mix(in srgb, var(--wb-text) 15%, transparent);
  --wb-input: color-mix(in srgb, var(--wb-text) 5%, var(--wb-bg));
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  display: flex;
  color: var(--wb-text);
  background: var(--wb-bg);
  font: 14px/1.45 system-ui, "Segoe UI", sans-serif;
  overflow: hidden;
}
.dsh-workbench *, .dsh-workbench *::before, .dsh-workbench *::after { box-sizing: inherit; }
.dsh-workbench button, .dsh-workbench input, .dsh-workbench select, .dsh-workbench textarea {
  font: inherit;
  color: inherit;
}
.dsh-workbench button:focus-visible,
.dsh-workbench input:focus-visible,
.dsh-workbench select:focus-visible {
  outline: 2px solid var(--wb-text);
  outline-offset: 2px;
}

.dsh-wb-rail {
  flex: none;
  width: 72px;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
  background: var(--wb-rail);
  border-right: 1px solid var(--wb-rail-border);
}
.dsh-wb-rail-list {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  overflow-y: auto;
}
.dsh-wb-rail-btn {
  position: relative;
  width: 48px;
  height: 48px;
  border: 0;
  padding: 0;
  border-radius: 50%;
  background: var(--wb-icon);
  color: var(--wb-text);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.dsh-wb-rail-btn[aria-current="true"] {
  border-radius: 16px;
  background: var(--wb-accent);
  color: var(--wb-accent-ink);
}
.dsh-wb-rail-btn:hover { border-radius: 16px; }
.dsh-wb-rail-btn.tool { width: 40px; height: 40px; background: transparent; }
.dsh-wb-rail-indicator {
  position: absolute;
  left: -12px;
  width: 4px;
  height: 36px;
  border-radius: 0 4px 4px 0;
  background: var(--wb-accent);
}
.dsh-wb-status {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--wb-rail);
  background: var(--wb-faint);
}
.dsh-wb-status[data-status="running"] { background: var(--wb-ok); }
.dsh-wb-status[data-status="starting"],
.dsh-wb-status[data-status="stopping"] { background: var(--wb-warn); }
.dsh-wb-status[data-status="crashed"] { background: var(--wb-danger); }
.dsh-wb-glyph { width: 22px; height: 22px; fill: currentColor; }
.dsh-wb-glyph-img { width: 100%; height: 100%; object-fit: cover; }

.dsh-wb-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--wb-bg);
}
.dsh-wb-stage { flex: 1; min-height: 0; position: relative; overflow: hidden; }
.dsh-wb-frames { position: absolute; inset: 0; z-index: 1; }
.dsh-wb-idle {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
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
.dsh-wb-boot {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--wb-bg);
}
.dsh-wb-frame {
  position: absolute;
  inset: 0;
  border: 0;
  width: 100%;
  height: 100%;
  background: #fff;
}
.dsh-wb-frame[hidden] { display: none !important; }
.dsh-wb-banner {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 16px;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--wb-panel);
  border: 1px solid var(--wb-border);
}
.dsh-wb-card, .dsh-wb-recovery {
  height: 100%;
  overflow: auto;
  padding: 20px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dsh-wb-tabs { display: flex; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--wb-border); }
.dsh-wb-tab {
  background: none;
  border: 0;
  padding: 8px 0;
  cursor: pointer;
  color: var(--wb-muted);
  border-bottom: 2px solid transparent;
}
.dsh-wb-tab[aria-selected="true"] { color: var(--wb-text); border-bottom-color: var(--wb-accent); }
.dsh-wb-kicker { margin: 0; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--wb-faint); }
.dsh-wb-title { margin: 0; font-size: 18px; font-weight: 600; }
.dsh-wb-muted { margin: 0; color: var(--wb-muted); }
.dsh-wb-alert {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--wb-danger);
  color: var(--wb-danger);
}
.dsh-wb-notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--wb-border);
  color: var(--wb-muted);
}
.dsh-wb-row, .dsh-wb-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dsh-wb-space-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--wb-border);
}
.dsh-wb-space-row > span { flex: 1; min-width: 0; }
.dsh-wb-form { display: flex; flex-direction: column; gap: 10px; max-width: 420px; }
.dsh-wb-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.dsh-wb-field input, .dsh-wb-field select, .dsh-wb-field textarea {
  background: var(--wb-input);
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  padding: 7px 10px;
}
.dsh-wb-btn {
  cursor: pointer;
  border: 1px solid var(--wb-border);
  background: transparent;
  border-radius: 8px;
  padding: 6px 12px;
}
.dsh-wb-btn:hover:not(:disabled) { background: rgba(255,255,255,0.06); }
.dsh-wb-btn:disabled { opacity: 0.45; cursor: default; }
.dsh-wb-btn.primary { background: var(--wb-accent); color: var(--wb-accent-ink); border-color: transparent; }
.dsh-wb-btn.danger { color: var(--wb-danger); border-color: var(--wb-danger); }
.dsh-wb-lang { display: inline-flex; border: 1px solid var(--wb-border); border-radius: 8px; overflow: hidden; }
.dsh-wb-lang button { border: 0; background: transparent; padding: 4px 10px; cursor: pointer; }
.dsh-wb-lang button[aria-pressed="true"] { background: rgba(255,255,255,0.12); font-weight: 600; }
.dsh-wb-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.dsh-wb-dialog {
  width: min(560px, 100%);
  max-height: min(86vh, 720px);
  overflow: auto;
  background: var(--wb-panel);
  border: 1px solid var(--wb-border);
  border-radius: 12px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dsh-wb-dialog.wide { width: min(720px, 100%); }
.dsh-wb-menu {
  position: absolute;
  z-index: 6;
  min-width: 200px;
  background: var(--wb-panel);
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  padding: 6px;
  display: flex;
  flex-direction: column;
}
.dsh-wb-menu button {
  text-align: left;
  background: none;
  border: 0;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.dsh-wb-menu button:hover:not(:disabled),
.dsh-wb-menu button[data-active="true"] { background: rgba(255,255,255,0.08); }
.dsh-wb-menu button:disabled { opacity: 0.4; cursor: default; }
.dsh-wb-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dsh-wb-table th, .dsh-wb-table td { text-align: left; padding: 6px 8px 6px 0; vertical-align: top; }
.dsh-wb-table th { color: var(--wb-muted); font-weight: 500; }
.dsh-wb-job { border: 1px solid var(--wb-border); border-radius: 8px; padding: 8px 10px; }
.dsh-wb-job[data-status="failed"] { border-color: var(--wb-danger); }
.dsh-wb-job[data-status="succeeded"] { border-color: var(--wb-ok); }
.dsh-wb-job[data-status="succeeded"][data-phase="handoff-pending"] { border-color: var(--wb-warn); }
.dsh-wb-glyphs { display: flex; flex-wrap: wrap; gap: 8px; }
.dsh-wb-glyphs button[aria-pressed="true"] { outline: 2px solid var(--wb-accent); }
.dsh-wb-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--wb-muted); }
.dsh-wb-dl { margin: 0; display: grid; grid-template-columns: auto minmax(0,1fr); gap: 4px 12px; }
.dsh-wb-dl dt { color: var(--wb-muted); }
.dsh-wb-dl dd { margin: 0; overflow-wrap: anywhere; }
.dsh-wb-sr {
  position: absolute;
  width: 1px; height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
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
@media (prefers-reduced-motion: reduce) {
  .dsh-workbench * { transition: none !important; animation: none !important; }
}
`;
