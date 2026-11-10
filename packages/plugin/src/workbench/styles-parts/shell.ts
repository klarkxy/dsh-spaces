/**
 * Workbench shell rules.
 *
 * Rail, rail buttons, indicator, status dots, main stage, frames, boot and
 * idle states, banner, global status, overlays and dialogs, menu, settings
 * page and dialog, tabs, jobs and the host-reset `!important` lock block.
 *
 * The material is layered: the rail and the stage carry their own depth, the
 * overlays are glass, and the dialogs sit on an elevated panel.
 */
import { CREATION_RING_CSS } from "../../../../../src/shared/ui/creation-ring";

export const WORKBENCH_SHELL_CSS = `
.dsh-wb-settings-page{position:absolute;inset:0;z-index:4;background:var(--wb-panel);display:flex;min-width:0;min-height:0}
.dsh-wb-settings-page>.dsh-wb-dialog.dsh-wb-settings{width:100%;height:100%;max-width:none;max-height:none;border:0;border-radius:0;box-shadow:none}
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
  background-image: linear-gradient(180deg, var(--wb-rail-sheen), transparent 30%);
  border-right: 1px solid var(--wb-rail-border);
  box-shadow: var(--wb-elev-sm);
}
.dsh-wb-rail-list {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  overflow-y: auto;
}
.dsh-wb-rail-slot {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border-radius: 16px;
  animation: dsh-wb-rail-in var(--wb-dur-slow) var(--wb-ease-emphasized) both;
  animation-delay: var(--dsh-wb-rail-delay, 0ms);
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
  transition: border-radius var(--wb-dur-base) var(--wb-ease-spring),
    transform var(--wb-dur-fast) var(--wb-ease-standard),
    background-color var(--wb-dur-base) var(--wb-ease-standard),
    box-shadow var(--wb-dur-base) var(--wb-ease-standard),
    color var(--wb-dur-base) var(--wb-ease-standard);
}
.dsh-wb-rail-btn[aria-current="true"] {
  border-radius: 16px;
  background: var(--wb-accent);
  background-image: var(--wb-accent-gradient);
  color: var(--wb-accent-ink);
  box-shadow: var(--wb-elev-glow);
}
.dsh-wb-rail-btn:hover { border-radius: 16px; transform: translateY(-1px); }
.dsh-wb-rail-btn:active { transform: scale(0.94); }
.dsh-wb-rail-btn.tool { width: 40px; height: 40px; background: transparent; }
.dsh-wb-rail-indicator {
  position: absolute;
  inset: -4px;
  z-index: 1;
  border-radius: 16px;
  border: 2px solid var(--wb-accent);
  box-shadow: var(--wb-elev-glow);
  pointer-events: none;
}
.dsh-wb-status {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  z-index: 2;
  border: 2px solid var(--wb-rail);
  background: var(--wb-faint);
  transition: background-color var(--wb-dur-base) var(--wb-ease-standard);
}
.dsh-wb-status[data-status="running"] { background: var(--wb-ok); }
.dsh-wb-status[data-status="starting"],
.dsh-wb-status[data-status="stopping"] {
  background: var(--wb-warn);
  animation: dsh-ui-pulse 1.8s var(--wb-ease-standard) infinite;
}
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
  background-image: radial-gradient(120% 80% at 50% -10%, color-mix(in srgb, var(--wb-accent) 9%, transparent), transparent 62%);
}
.dsh-wb-stage { flex: 1; min-height: 0; position: relative; overflow: hidden; }
.dsh-wb-global-status { position: absolute; z-index: 3; bottom: 16px; left: 16px; right: 16px; display: grid; gap: 8px; pointer-events: none; }
.dsh-wb-global-status > * { pointer-events: auto; }
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
  overflow: hidden;
}
.dsh-wb-boot::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 320px;
  height: 320px;
  margin: -160px 0 0 -160px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--wb-accent) 24%, transparent), transparent 68%);
  animation: dsh-ui-glow-breathe 2.6s var(--wb-ease-standard) infinite;
  pointer-events: none;
}
.dsh-wb-boot::after {
  content: "";
  position: absolute;
  left: 50%;
  top: calc(50% + 58px);
  width: 180px;
  height: 6px;
  margin-left: -90px;
  border-radius: 999px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--wb-text) 18%, transparent), transparent);
  background-size: 200% 100%;
  animation: dsh-wb-sheen 1.6s linear infinite;
  pointer-events: none;
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
  padding: 12px 14px;
  border-radius: var(--wb-radius-md);
  background-color: var(--wb-veil);
  background-image: linear-gradient(180deg, var(--wb-sheen), transparent 55%);
  backdrop-filter: var(--wb-glass-blur);
  border: 1px solid var(--wb-hairline);
  box-shadow: var(--wb-elev-lg);
  animation: dsh-wb-lift var(--wb-dur-slow) var(--wb-ease-emphasized) both;
}
.dsh-wb-card, .dsh-wb-recovery {
  height: 100%;
  overflow: auto;
  padding: 20px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dsh-wb-tabs { display: flex; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--wb-hairline); }
.dsh-wb-tab {
  position: relative;
  background: none;
  border: 0;
  padding: 8px 0;
  cursor: pointer;
  color: var(--wb-muted);
  border-bottom: 2px solid transparent;
  transition: color var(--wb-dur-fast) var(--wb-ease-standard), border-color var(--wb-dur-base) var(--wb-ease-standard);
}
.dsh-wb-tab[aria-selected="true"] { color: var(--wb-text); border-bottom-color: var(--wb-accent); }
.dsh-wb-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
/* The dim lives in a pseudo element so that the backdrop can fade in without
   the panel above it ever losing its opacity. The negative z-index keeps the
   dim below every child, whether that child is positioned or not. */
.dsh-wb-overlay::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background: var(--wb-overlay);
  backdrop-filter: blur(10px) saturate(130%);
  animation: dsh-ui-fade-in var(--wb-dur-base) var(--wb-ease-standard) both;
}
.dsh-wb-overlay-menu::before { backdrop-filter: blur(6px) saturate(120%); }
.dsh-wb-dialog {
  position: relative;
  z-index: 1;
  width: min(560px, 100%);
  max-height: min(86vh, 720px);
  overflow: auto;
  background-color: var(--wb-panel);
  background-image: linear-gradient(180deg, var(--wb-sheen), transparent 42%);
  border: 1px solid var(--wb-hairline);
  border-radius: var(--wb-radius-md);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--wb-elev-lg);
}
.dsh-wb-dialog.wide { width: min(720px, 100%); }
.dsh-wb-dialog.dsh-wb-settings { width: min(1040px, 100%); height: min(86vh, 800px); max-height: 100%; padding: 0; gap: 0; overflow: hidden; }
.dsh-wb-settings-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; border-bottom: 1px solid var(--wb-hairline); flex: none; background: var(--wb-panel-2); }
.dsh-wb-settings-close { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; }
.dsh-wb-settings-close span { font-size: 22px; line-height: 1; }
.dsh-wb-settings-body { display: flex; min-height: 0; flex: 1; }
.dsh-wb-settings-nav { width: 180px; flex: none; overflow-y: auto; padding: 12px; border-right: 1px solid var(--wb-hairline); display: flex; flex-direction: column; gap: 4px; }
.dsh-wb-settings-tablist { display: flex; flex-direction: column; gap: 4px; }
.dsh-wb-settings-tablist[hidden] { display: none; }
.dsh-wb-settings-group-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 9px 12px;
  border: 0;
  border-top: 1px solid var(--wb-hairline);
  border-radius: 6px;
  background: none;
  color: var(--wb-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: color var(--wb-dur-fast) var(--wb-ease-standard), background-color var(--wb-dur-fast) var(--wb-ease-standard);
}
.dsh-wb-settings-group-toggle:hover { color: var(--wb-text); background-color: color-mix(in srgb, var(--wb-text) 6%, transparent); }
.dsh-wb-settings-group-caret { font-size: 11px; line-height: 1; }
.dsh-wb-settings-nav .dsh-wb-tab { flex: none; text-align: left; padding: 9px 12px; border: 0; border-radius: 6px; }
.dsh-wb-settings-nav .dsh-wb-tab[aria-selected="true"] { color: var(--wb-text); background: var(--wb-icon); font-weight: 600; }
.dsh-wb-settings-tab-indicator {
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--wb-accent);
  background-image: var(--wb-accent-gradient);
  box-shadow: var(--wb-elev-glow);
  pointer-events: none;
}
.dsh-wb-settings-content { flex: 1; min-width: 0; overflow: auto; padding: 24px; display: flex; flex-direction: column; align-items: stretch; gap: 20px; }
.dsh-wb-settings-content > * { flex-shrink: 0; }
.dsh-wb-preference-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--wb-hairline); }
.dsh-wb-settings-service { display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--wb-hairline); padding-top: 24px; }
.dsh-wb-danger-zone {
  border: 1px solid color-mix(in srgb, var(--wb-danger) 42%, transparent);
  border-radius: var(--wb-radius-md);
  background-color: color-mix(in srgb, var(--wb-danger) 7%, transparent);
  padding: 16px;
}
.dsh-wb-space-detail { display: flex; flex-direction: column; gap: 16px; }
.dsh-wb-space-detail-header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.dsh-wb-space-detail-header > .dsh-wb-actions { margin-left: auto; }
.dsh-wb-detail-icon { width: 40px; height: 40px; flex: none; display: grid; place-items: center; }
.dsh-wb-detail-icon > * { width: 40px; height: 40px; }
.dsh-wb-detail-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-wb-detail-id .dsh-wb-title { margin: 0; }
.dsh-wb-detail-id > span { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsh-wb-detail-tabs { display: flex; flex-direction: row; gap: 16px; border-bottom: 1px solid var(--wb-hairline); }
.dsh-wb-detail-tabs[hidden] { display: none; }
.dsh-wb-space-detail [data-space-tab] { display: flex; flex-direction: column; gap: 16px; }
.dsh-wb-space-detail [data-space-tab][hidden] { display: none; }
.dsh-wb-space-detail-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--wb-hairline);
  border-radius: var(--wb-radius-md);
  background-color: color-mix(in srgb, var(--wb-text) 3%, transparent);
  box-shadow: var(--wb-elev-sm);
}
.dsh-wb-space-detail-card h3, .dsh-wb-space-detail-card h4 { margin: 0; }
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
  background-color: var(--wb-veil);
  background-image: linear-gradient(180deg, var(--wb-sheen), transparent 45%);
  backdrop-filter: var(--wb-glass-blur);
  border: 1px solid var(--wb-hairline);
  border-radius: var(--wb-radius-md);
  padding: 6px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--wb-elev-lg);
  transform-origin: top left;
}
.dsh-wb-menu button {
  text-align: left;
  background: none;
  border: 0;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color var(--wb-dur-fast) var(--wb-ease-standard);
}
.dsh-wb-menu button:hover:not(:disabled),
.dsh-wb-menu button[data-active="true"] { background: color-mix(in srgb, var(--wb-text) 10%, transparent); }
.dsh-wb-menu button:disabled { opacity: 0.4; cursor: default; }
.dsh-wb-job {
  border: 1px solid var(--wb-hairline);
  border-radius: var(--wb-radius-md);
  padding: 10px 12px;
  background-color: color-mix(in srgb, var(--wb-text) 3%, transparent);
  box-shadow: var(--wb-elev-sm);
}
.dsh-wb-job[data-status="failed"] { border-color: color-mix(in srgb, var(--wb-danger) 60%, transparent); }
.dsh-wb-job[data-status="succeeded"] { border-color: color-mix(in srgb, var(--wb-ok) 55%, transparent); }
.dsh-wb-glyphs { display: flex; flex-wrap: wrap; gap: 8px; }
.dsh-wb-avatars { display: grid; grid-template-columns: repeat(auto-fit, 48px); gap: 10px; max-width: 280px; }

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
${CREATION_RING_CSS}
`;
