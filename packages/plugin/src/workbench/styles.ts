/** Self-contained workbench styles. No desktop Tailwind. */

export const WORKBENCH_CSS = `
.dsh-workbench[data-theme="light"] {
  --wb-rail: #eceef2;
  --wb-rail-border: rgba(0,0,0,0.08);
  --wb-bg: #f6f7f9;
  --wb-panel: #ffffff;
  --wb-text: #16171a;
  --wb-muted: #5c6166;
  --wb-faint: #8a9096;
  --wb-icon: color-mix(in srgb, var(--wb-text) 10%, var(--wb-bg));
  --wb-border: color-mix(in srgb, var(--wb-text) 15%, transparent);
  --wb-input: color-mix(in srgb, var(--wb-text) 5%, var(--wb-bg));
}
@media (prefers-color-scheme: light) {
  .dsh-workbench[data-theme="system"] {
    --wb-rail: #eceef2;
    --wb-rail-border: rgba(0,0,0,0.08);
    --wb-bg: #f6f7f9;
    --wb-panel: #ffffff;
    --wb-text: #16171a;
    --wb-muted: #5c6166;
    --wb-faint: #8a9096;
  }
}
.dsh-workbench {
  --wb-rail: #16171a;
  --wb-rail-border: rgba(255,255,255,0.08);
  --wb-bg: #0f1012;
  --wb-panel: #18191d;
  --wb-text: #f2f3f5;
  --wb-muted: #9aa0a6;
  --wb-faint: #6e7378;
  --wb-accent: #5865f2;
  --wb-accent-ink: #fff;
  --wb-danger: #d1242f;
  --wb-ok: #3ba55d;
  --wb-warn: #c9a227;
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
.dsh-workbench select:focus-visible,
.dsh-workbench textarea:focus-visible {
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
.dsh-wb-global-status { position: absolute; z-index: 3; bottom: 16px; left: 16px; right: 16px; display: grid; gap: 8px; pointer-events: none; }
.dsh-wb-global-status > * { pointer-events: auto; background: var(--wb-panel); }
.dsh-wb-home-frame { z-index: 1; }
.dsh-wb-frames { pointer-events: none; }
.dsh-wb-frames iframe { pointer-events: auto; }
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
  white-space: pre-wrap;
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
.dsh-wb-form.wide { max-width: min(720px, 100%); }
.dsh-wb-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.dsh-wb-field input, .dsh-wb-field select, .dsh-wb-field textarea {
  background: var(--wb-input);
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  padding: 7px 10px;
}
.dsh-wb-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
.dsh-wb-pre {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--wb-input);
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
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
.dsh-wb-dialog.dsh-wb-settings { width: min(1040px, 100%); height: min(86vh, 800px); max-height: 100%; padding: 0; gap: 0; overflow: hidden; }
.dsh-wb-settings-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; border-bottom: 1px solid var(--wb-border); flex: none; }
.dsh-wb-settings-close { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; }
.dsh-wb-settings-close span { font-size: 22px; line-height: 1; }
.dsh-wb-settings-body { display: flex; min-height: 0; flex: 1; }
.dsh-wb-settings-nav { width: 180px; flex: none; overflow-y: auto; padding: 12px; border-right: 1px solid var(--wb-border); display: flex; flex-direction: column; gap: 4px; }
.dsh-wb-settings-nav .dsh-wb-tab { flex: none; text-align: left; padding: 9px 12px; border: 0; border-radius: 6px; }
.dsh-wb-settings-nav .dsh-wb-tab[aria-selected="true"] { color: var(--wb-text); background: var(--wb-icon); font-weight: 600; }
.dsh-wb-settings-content { flex: 1; min-width: 0; overflow: auto; padding: 24px; display: flex; flex-direction: column; align-items: stretch; gap: 20px; }
.dsh-wb-settings-content > * { flex-shrink: 0; }
.dsh-wb-preference-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--wb-border); }
.dsh-wb-lang { flex-shrink: 0; }
.dsh-wb-settings-service { display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--wb-border); padding-top: 24px; }
.dsh-wb-settings-content [data-settings-home] { display: flex; flex-direction: column; gap: 16px; }
@media (max-width: 640px) {
  .dsh-wb-overlay { padding: 8px; }
  .dsh-wb-dialog.dsh-wb-settings { height: 100%; }
  .dsh-wb-settings-nav { width: 124px; padding: 8px; }
  .dsh-wb-settings-nav .dsh-wb-tab { padding: 9px 8px; }
  .dsh-wb-settings-content { padding: 16px; }
  .dsh-wb-preference-row { align-items: flex-start; flex-direction: column; gap: 10px; }
}
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
.dsh-wb-icon-preview {
  width: 48px;
  height: 48px;
  margin-top: 8px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--wb-icon);
  display: flex;
}
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
/* Host resets set width/height:auto !important on button and img. These
   locks keep uploaded icons inside the rail instead of painting at intrinsic size. */
.dsh-workbench {
  display: flex !important;
  height: 100% !important;
  min-height: 0 !important;
  overflow: hidden !important;
}
.dsh-workbench > .dsh-wb-rail {
  flex: 0 0 72px !important;
  width: 72px !important;
  min-width: 72px !important;
  max-width: 72px !important;
  height: 100% !important;
  overflow: hidden !important;
}
.dsh-workbench > .dsh-wb-main {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  height: 100% !important;
  position: relative !important;
  overflow: hidden !important;
}
.dsh-workbench .dsh-wb-rail-list {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  width: 100% !important;
  min-height: 0 !important;
  overflow-x: hidden !important;
  overflow-y: auto !important;
}
.dsh-workbench .dsh-wb-rail-btn {
  width: 48px !important;
  height: 48px !important;
  min-width: 48px !important;
  max-width: 48px !important;
  min-height: 48px !important;
  max-height: 48px !important;
  flex: none !important;
  overflow: hidden !important;
  padding: 0 !important;
}
.dsh-workbench .dsh-wb-rail-btn.tool {
  width: 40px !important;
  height: 40px !important;
  min-width: 40px !important;
  max-width: 40px !important;
  min-height: 40px !important;
  max-height: 40px !important;
}
.dsh-workbench .dsh-wb-rail-btn .dsh-wb-glyph {
  width: 22px !important;
  height: 22px !important;
  max-width: 22px !important;
  max-height: 22px !important;
  flex: none !important;
}
.dsh-workbench img.dsh-wb-glyph-img {
  width: 100% !important;
  height: 100% !important;
  min-width: 0 !important;
  min-height: 0 !important;
  max-width: 100% !important;
  max-height: 100% !important;
  object-fit: cover !important;
  display: block !important;
}
.dsh-workbench .dsh-wb-space-row > img.dsh-wb-glyph-img,
.dsh-workbench .dsh-wb-icon-preview,
.dsh-workbench .dsh-wb-icon-preview > img.dsh-wb-glyph-img {
  width: 48px !important;
  height: 48px !important;
  min-width: 48px !important;
  max-width: 48px !important;
  min-height: 48px !important;
  max-height: 48px !important;
  flex: none !important;
}
.dsh-workbench .dsh-wb-sr {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  overflow: hidden !important;
  clip: rect(0 0 0 0) !important;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-workbench * { transition: none !important; animation: none !important; }
}
`;
