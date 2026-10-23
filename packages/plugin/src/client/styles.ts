/**
 * Scoped panel styles. Every rule is namespaced under `.dsh-spaces` so the
 * sheet cannot leak into the host app. Colors prefer the DSH `--dsw` theme
 * tokens (evidence: shipped dsh-client-ui-sidebar stylesheet) with static
 * fallbacks so the panel stays legible if a token is absent; the shared
 * `--dsh-ui-*` material — elevation, glass, glow, radii and motion — is
 * layered on top through the local `--sp-*` variables.
 */
import { UI_TOKENS_CSS } from "../../../../src/shared/ui/tokens";
import { HOST_LIGHT_MATERIAL_CSS, SPACES_UI_TOKEN_CSS } from "./ui/material";

export const SPACES_PANEL_CSS = `${UI_TOKENS_CSS}${SPACES_UI_TOKEN_CSS}${HOST_LIGHT_MATERIAL_CSS}
.dsh-spaces {
  box-sizing: border-box;
  height: 100%;
  display: flex;
  flex-direction: column;
  color: var(--sp-text, var(--dsw-alias-label-primary, #1f2328));
  background: var(--dsw-alias-bg-base, var(--sp-bg, #ffffff));
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
  border-bottom: 1px solid var(--sp-border, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08)));
  background: var(--sp-glass, color-mix(in srgb, var(--sp-bg, #fff) 76%, transparent));
  -webkit-backdrop-filter: var(--sp-glass-blur, blur(16px) saturate(140%));
  backdrop-filter: var(--sp-glass-blur, blur(16px) saturate(140%));
  box-shadow: var(--sp-elev-sm, 0 1px 2px rgba(0, 0, 0, 0.2));
  position: relative;
  z-index: 1;
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
  border: 0.5px solid var(--sp-border, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12)));
  border-radius: var(--sp-radius-sm, 8px);
  overflow: hidden;
  background: var(--sp-surface, var(--dsw-alias-bg-layer-1, transparent));
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
  transition: background-color var(--sp-dur-fast, 120ms) linear, color var(--sp-dur-fast, 120ms) linear;
}
.dsh-spaces-lang-btn[aria-pressed="true"] {
  background: var(--sp-active, var(--dsw-alias-interactive-bg-active, rgba(0, 0, 0, 0.1)));
  font-weight: 500;
}
.dsh-spaces-lang-btn:hover:not([aria-pressed="true"]) {
  background: var(--sp-hover, var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06)));
}
.dsh-spaces-refresh {
  font: inherit;
  cursor: pointer;
  border: 0.5px solid var(--sp-border, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12)));
  background: var(--dsw-alias-button-elevated-fill, transparent);
  color: inherit;
  border-radius: var(--sp-radius-sm, 8px);
  padding: 4px 12px;
  line-height: 22px;
  transition: background-color var(--sp-dur-fast, 120ms) linear, box-shadow var(--sp-dur-base, 200ms) var(--sp-ease-standard, cubic-bezier(0.2, 0, 0, 1));
}
.dsh-spaces-refresh:hover:not(:disabled) {
  background: var(--sp-hover, var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06)));
  box-shadow: var(--sp-elev-sm, 0 1px 2px rgba(0, 0, 0, 0.2));
}
.dsh-spaces-refresh:disabled { opacity: 0.6; cursor: default; }
.dsh-spaces-refresh:focus-visible,
.dsh-spaces button:focus-visible,
.dsh-spaces input:focus-visible {
  outline: 2px solid var(--sp-text, var(--dsw-alias-label-primary, #1f2328));
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
  border-right: 1px solid var(--sp-border, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08)));
  display: flex;
  flex-direction: column;
  gap: 12px;
}
@media (max-width: 720px) {
  .dsh-spaces-sidebar { border-right: none; border-bottom: 1px solid var(--sp-border, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08))); }
}

.dsh-spaces-capabilities {
  border: 0.5px solid var(--sp-border, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12)));
  border-radius: var(--sp-radius-md, 12px);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  background: var(--sp-surface, var(--dsw-alias-bg-layer-1, transparent));
  box-shadow: var(--sp-elev-sm, 0 1px 2px rgba(0, 0, 0, 0.2));
}
.dsh-spaces-mode { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-spaces-version {
  color: var(--sp-muted, var(--dsw-alias-label-secondary, #59636e));
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
}
.dsh-spaces-reasons { margin: 0; padding-left: 18px; color: var(--sp-muted, var(--dsw-alias-label-secondary, #59636e)); }
.dsh-spaces-reasons li { margin: 2px 0; }

.dsh-spaces-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dsh-spaces-row { list-style: none; }
.dsh-spaces-item {
  position: relative;
  width: 100%;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border: none;
  border-radius: var(--sp-radius-sm, 8px);
  background: none;
  color: inherit;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  transition: background-color var(--sp-dur-fast, 120ms) linear, box-shadow var(--sp-dur-base, 200ms) var(--sp-ease-standard, cubic-bezier(0.2, 0, 0, 1));
}
.dsh-spaces-item:hover { background: var(--sp-hover, var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))); }
.dsh-spaces-item[aria-selected="true"],
.dsh-spaces-item[aria-current="true"] {
  font-weight: 500;
}
.dsh-spaces-item > *:not(.dsh-spaces-selection) { position: relative; z-index: 1; }
.dsh-spaces-selection {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  border-radius: inherit;
  background: var(--sp-active, var(--dsw-alias-interactive-bg-active, rgba(0, 0, 0, 0.1)));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sp-accent, #5865f2) 38%, transparent);
}
.dsh-spaces-selection::before {
  content: "";
  position: absolute;
  left: 0;
  top: 18%;
  bottom: 18%;
  width: 3px;
  border-radius: var(--sp-radius-pill, 999px);
  background: var(--sp-accent-gradient, linear-gradient(135deg, #5865f2 0%, #8b5cf6 100%));
}
.dsh-spaces-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-spaces-status {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--sp-muted, var(--dsw-alias-label-secondary, #59636e));
  transition: box-shadow var(--sp-dur-base, 200ms) var(--sp-ease-standard, cubic-bezier(0.2, 0, 0, 1));
}
.dsh-spaces-status[data-status="running"] { background: var(--sp-ok, var(--dsw-alias-state-success-primary, #1a7f37)); }
.dsh-spaces-status[data-status="stopped"] { background: var(--sp-muted, var(--dsw-alias-label-secondary, #59636e)); }
.dsh-spaces-status[data-transitional="true"] {
  animation: dsh-ui-pulse 1.4s ease-in-out infinite;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sp-accent, #5865f2) 22%, transparent);
}

.dsh-spaces-badge {
  flex: none;
  font-size: 11px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: var(--sp-radius-pill, 999px);
  border: 0.5px solid var(--sp-border, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.16)));
  color: var(--sp-muted, var(--dsw-alias-label-secondary, #59636e));
  white-space: nowrap;
}
.dsh-spaces-badge[data-tone="host"] {
  color: var(--sp-accent-ink, var(--dsw-alias-label-primary-inverted, #ffffff));
  background: var(--sp-accent-gradient, linear-gradient(135deg, #5865f2 0%, #8b5cf6 100%));
  border-color: transparent;
}
.dsh-spaces-badge[data-tone="verified"] { color: var(--sp-ok, var(--dsw-alias-state-success-primary, #1a7f37)); }
.dsh-spaces-badge[data-tone="invalid"] { color: var(--sp-danger, var(--dsw-alias-label-error, #d1242f)); }

.dsh-spaces-detail {
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dsh-spaces-detail-body { display: flex; flex-direction: column; gap: 16px; }
.dsh-spaces-detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-spaces-detail-title { margin: 0; font-size: 15px; font-weight: 600; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dsh-spaces-meta { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; font-size: 13px; }
.dsh-spaces-meta dt { color: var(--sp-muted, var(--dsw-alias-label-secondary, #59636e)); margin: 0; }
.dsh-spaces-meta dd { margin: 0; overflow-wrap: anywhere; }
.dsh-spaces-meta dd code { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 12px; }

.dsh-spaces-section-title { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.dsh-spaces-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dsh-spaces-table th, .dsh-spaces-table td { text-align: left; padding: 4px 8px 4px 0; vertical-align: top; }
.dsh-spaces-table th { color: var(--sp-muted, var(--dsw-alias-label-secondary, #59636e)); font-weight: 500; }
.dsh-spaces-table td code { font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 12px; }

.dsh-spaces-diagnostics { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dsh-spaces-diagnostic {
  border: 0.5px solid var(--sp-border, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12)));
  border-radius: var(--sp-radius-sm, 8px);
  padding: 8px 10px;
  font-size: 13px;
  background: var(--sp-surface, var(--dsw-alias-bg-layer-1, transparent));
}
.dsh-spaces-diagnostic[data-level="warning"] { border-color: var(--sp-warn, var(--dsw-alias-state-warn-primary, #9a6700)); }
.dsh-spaces-diagnostic[data-level="error"] { border-color: var(--sp-danger, var(--dsw-alias-label-error, #d1242f)); }
.dsh-spaces-diagnostic-code {
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  color: var(--sp-muted, var(--dsw-alias-label-secondary, #59636e));
  margin-right: 6px;
}

.dsh-spaces-form { display: flex; flex-direction: column; gap: 8px; }
.dsh-spaces-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  padding: 4px 6px;
  margin: -4px -6px;
  border-radius: var(--sp-radius-sm, 8px);
  transition: box-shadow var(--sp-dur-base, 200ms) var(--sp-ease-standard, cubic-bezier(0.2, 0, 0, 1));
}
.dsh-spaces-field:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--sp-accent, #5865f2) 32%, transparent), var(--sp-glow, 0 0 24px -6px rgba(88, 101, 242, 0.6));
}
.dsh-spaces-field input {
  font: inherit;
  color: inherit;
  background: var(--dsw-alias-bg-layer-1, transparent);
  border: 0.5px solid var(--sp-border, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.2)));
  border-radius: var(--sp-radius-sm, 8px);
  padding: 6px 10px;
  transition: border-color var(--sp-dur-fast, 120ms) linear, box-shadow var(--sp-dur-base, 200ms) var(--sp-ease-standard, cubic-bezier(0.2, 0, 0, 1));
}
.dsh-spaces-field input:focus {
  border-color: color-mix(in srgb, var(--sp-accent, #5865f2) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sp-accent, #5865f2) 18%, transparent);
}
.dsh-spaces-submit {
  font: inherit;
  cursor: pointer;
  align-self: flex-start;
  border: none;
  border-radius: var(--sp-radius-sm, 8px);
  padding: 6px 14px;
  color: var(--sp-accent-ink, var(--dsw-alias-label-primary-inverted, #ffffff));
  background: var(--sp-accent-gradient, linear-gradient(135deg, #5865f2 0%, #8b5cf6 100%));
  box-shadow: var(--sp-elev-sm, 0 1px 2px rgba(0, 0, 0, 0.2));
  transition: box-shadow var(--sp-dur-base, 200ms) var(--sp-ease-standard, cubic-bezier(0.2, 0, 0, 1));
}
.dsh-spaces-submit:hover:not(:disabled) { box-shadow: var(--sp-elev-md, 0 10px 26px -14px rgba(0, 0, 0, 0.45)), var(--sp-glow, 0 0 24px -6px rgba(88, 101, 242, 0.6)); }
.dsh-spaces-submit:disabled { opacity: 0.55; cursor: default; }

.dsh-spaces-action {
  font: inherit;
  cursor: pointer;
  border: 0.5px solid var(--sp-border, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12)));
  background: var(--dsw-alias-button-elevated-fill, transparent);
  color: inherit;
  border-radius: var(--sp-radius-sm, 8px);
  padding: 4px 12px;
  transition: background-color var(--sp-dur-fast, 120ms) linear;
}
.dsh-spaces-action:hover:not(:disabled) { background: var(--sp-hover, var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06))); }
.dsh-spaces-action:disabled { opacity: 0.6; cursor: default; }

.dsh-spaces-alert {
  border: 0.5px solid var(--sp-danger, var(--dsw-alias-label-error, #d1242f));
  border-radius: var(--sp-radius-sm, 8px);
  padding: 8px 10px;
  color: var(--sp-danger, var(--dsw-alias-label-error, #d1242f));
  font-size: 13px;
  overflow-wrap: anywhere;
  background: color-mix(in srgb, var(--sp-danger, #d1242f) 8%, transparent);
}
.dsh-spaces-notice {
  border: 0.5px solid var(--sp-border, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12)));
  border-radius: var(--sp-radius-sm, 8px);
  padding: 8px 10px;
  font-size: 13px;
  color: var(--sp-muted, var(--dsw-alias-label-secondary, #59636e));
}
.dsh-spaces-notice[data-tone="ok"] { color: var(--sp-ok, var(--dsw-alias-state-success-primary, #1a7f37)); border-color: var(--sp-ok, var(--dsw-alias-state-success-primary, #1a7f37)); }
.dsh-spaces-muted { color: var(--sp-muted, var(--dsw-alias-label-secondary, #59636e)); margin: 0; }
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
  color: var(--sp-muted, var(--dsw-alias-label-secondary, #59636e));
  text-align: center;
}

.dsh-spaces-skeleton { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
.dsh-spaces-skeleton-line {
  display: block;
  height: 12px;
  border-radius: var(--sp-radius-pill, 999px);
  background-color: color-mix(in srgb, var(--sp-text, #1f2328) 8%, transparent);
  background-image: var(--sp-shimmer, linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.35) 42%, transparent 64%));
  background-size: 200% 100%;
  animation: dsh-ui-shimmer 1.6s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .dsh-spaces * { transition: none; animation: none; }
}
`;
