/**
 * Workbench theme tokens.
 *
 * Owns the light/dark workbench variables and the mapping onto the shared
 * `--dsh-ui-*` token layer. The root `.dsh-workbench` rule lives here
 * because it declares the workbench variables; base.ts owns the remaining
 * root-level rules (contained layout, resets, focus).
 *
 * The material is layered: every surface picks a base colour, a hairline and
 * an elevation from the shared tokens, so the dark and the light theme stay
 * in step.
 */

import { uiTokenMixin } from "../../../../../src/shared/ui/tokens";

/**
 * Mapping from the workbench variables onto the shared `--dsh-ui-*` layer.
 *
 * The mapping only adds new properties, so no existing rule has to change.
 * The fallbacks keep the workbench usable before the surface root carries the
 * `dsh-ui` class.
 */
export const WORKBENCH_UI_TOKEN_CSS = uiTokenMixin(".dsh-workbench", {
  "--wb-elev-sm": "var(--dsh-ui-shadow-sm, 0 1px 2px rgba(0,0,0,0.18))",
  "--wb-elev-md": "var(--dsh-ui-shadow-md, 0 4px 14px -6px rgba(0,0,0,0.36))",
  "--wb-elev-lg": "var(--dsh-ui-shadow-lg, 0 12px 32px -12px rgba(0,0,0,0.48))",
  "--wb-elev-glow": "none",
  "--wb-radius-xs": "var(--dsh-ui-radius-xs, 6px)",
  "--wb-radius-sm": "var(--dsh-ui-radius-sm, 8px)",
  "--wb-radius-md": "var(--dsh-ui-radius-md, 12px)",
  "--wb-radius-lg": "var(--dsh-ui-radius-lg, 16px)",
  "--wb-radius-pill": "var(--dsh-ui-radius-pill, 999px)",
  "--wb-space-1": "var(--dsh-ui-space-1, 4px)",
  "--wb-space-2": "var(--dsh-ui-space-2, 8px)",
  "--wb-space-3": "var(--dsh-ui-space-3, 12px)",
  "--wb-space-4": "var(--dsh-ui-space-4, 16px)",
  "--wb-space-5": "var(--dsh-ui-space-5, 24px)",
  "--wb-space-6": "var(--dsh-ui-space-6, 32px)",
  "--wb-glass-bg": "var(--dsh-ui-glass-bg, var(--wb-panel))",
  "--wb-glass-blur": "none",
  "--wb-accent-gradient": "none",
  "--wb-focus-ring": "var(--dsh-ui-focus-ring, 0 0 0 2px color-mix(in srgb, var(--wb-accent) 28%, transparent))",
  "--wb-dur-fast": "var(--dsh-ui-dur-fast, 120ms)",
  "--wb-dur-base": "var(--dsh-ui-dur-base, 200ms)",
  "--wb-dur-slow": "var(--dsh-ui-dur-slow, 360ms)",
  "--wb-ease-standard": "var(--dsh-ui-ease-standard, cubic-bezier(0.2, 0, 0, 1))",
  "--wb-ease-emphasized": "var(--dsh-ui-ease-emphasized, cubic-bezier(0.32, 0.72, 0, 1))",
  "--wb-ease-spring": "var(--dsh-ui-ease-spring, cubic-bezier(0.34, 1.56, 0.64, 1))",
  /** Rail activity glow colours: green while working, yellow when waiting on the user. */
  "--dsh-spaces-working": "var(--wb-ok, var(--dsh-ui-ok, #39bf83))",
  "--dsh-spaces-attention": "var(--wb-warn, var(--dsh-ui-warn, #d9a441))",
});

export const WORKBENCH_THEME_CSS = `
.dsh-workbench[data-theme="light"] {
  --wb-rail: #f0f1f5;
  --wb-rail-border: rgba(0,0,0,0.08);
  --wb-bg: #f7f8fa;
  --wb-panel: #ffffff;
  --wb-panel-2: #f2f3f6;
  --wb-text: #1f2329;
  --wb-muted: #646a73;
  --wb-faint: #8f959e;
  --wb-accent: #356dda;
  --wb-accent-2: #2b5bb8;
  --wb-accent-ink: #ffffff;
  --wb-btn-primary-bg: #1f2329;
  --wb-btn-primary-hover: #323842;
  --wb-btn-primary-ink: #ffffff;
  --wb-danger: #d1242f;
  --wb-ok: #2f8f52;
  --wb-warn: #a9821c;
  --wb-icon: rgba(31,35,41,0.07);
  --wb-hover: rgba(31,35,41,0.05);
  --wb-active: rgba(31,35,41,0.08);
  --wb-border: rgba(31,35,41,0.12);
  --wb-input: #f2f3f6;
  --wb-hairline: rgba(31,35,41,0.09);
  --wb-overlay: rgba(16,17,26,0.32);
  --wb-veil: #ffffff;
  --wb-sheen: transparent;
  --wb-rail-sheen: transparent;
}
.dsh-workbench[data-theme="system"] {
  --wb-rail: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #16171a));
  --wb-rail-border: var(--dsw-alias-border-l2, rgba(255,255,255,0.08));
  --wb-bg: var(--dsw-alias-bg-base, #141518);
  --wb-panel: var(--dsw-alias-bg-base, #18191d);
  --wb-panel-2: var(--dsw-alias-bg-layer-2, #1f2025);
  --wb-text: var(--dsw-alias-label-primary, #eceef2);
  --wb-muted: var(--dsw-alias-label-secondary, #989ea8);
  --wb-faint: var(--dsw-alias-label-tertiary, #6b717b);
  --wb-accent: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #4c8dff));
  --wb-accent-2: #3b76e6;
  --wb-accent-ink: #ffffff;
  --wb-btn-primary-bg: var(--dsw-alias-button-primary-fill, #eceef2);
  --wb-btn-primary-hover: var(--dsw-alias-button-primary-hover, #ffffff);
  --wb-btn-primary-ink: var(--dsw-alias-label-primary-foreground, #141518);
  --wb-danger: var(--dsw-alias-label-error, var(--dsw-alias-state-error-primary, #e05252));
  --wb-ok: var(--dsw-alias-state-success-primary, #39bf83);
  --wb-warn: var(--dsw-alias-state-warn-primary, #d9a441);
  --wb-icon: var(--dsw-alias-interactive-bg-active, color-mix(in srgb, var(--wb-text) 8%, transparent));
  --wb-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--wb-text) 5%, transparent));
  --wb-active: var(--dsw-alias-interactive-bg-active, color-mix(in srgb, var(--wb-text) 8%, transparent));
  --wb-border: var(--dsw-alias-border-l3, color-mix(in srgb, var(--wb-text) 12%, transparent));
  --wb-input: var(--dsw-alias-bg-layer-3, color-mix(in srgb, var(--wb-text) 5%, var(--wb-bg)));
  --wb-hairline: var(--dsw-alias-border-l2, color-mix(in srgb, var(--wb-text) 9%, transparent));
  --wb-veil: var(--wb-panel);
}
@media (prefers-color-scheme: light) {
  .dsh-workbench[data-theme="system"] {
    --wb-rail: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f0f1f5));
    --wb-rail-border: var(--dsw-alias-border-l2, rgba(0,0,0,0.08));
    --wb-bg: var(--dsw-alias-bg-base, #f7f8fa);
    --wb-panel: var(--dsw-alias-bg-base, #ffffff);
    --wb-panel-2: var(--dsw-alias-bg-layer-2, #f2f3f6);
    --wb-text: var(--dsw-alias-label-primary, #1f2329);
    --wb-muted: var(--dsw-alias-label-secondary, #646a73);
    --wb-faint: var(--dsw-alias-label-tertiary, #8f959e);
    --wb-accent: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #356dda));
    --wb-accent-2: #2b5bb8;
    --wb-accent-ink: #ffffff;
    --wb-btn-primary-bg: var(--dsw-alias-button-primary-fill, #1f2329);
    --wb-btn-primary-hover: var(--dsw-alias-button-primary-hover, #323842);
    --wb-btn-primary-ink: var(--dsw-alias-label-primary-foreground, #ffffff);
    --wb-danger: var(--dsw-alias-label-error, var(--dsw-alias-state-error-primary, #d1242f));
    --wb-ok: var(--dsw-alias-state-success-primary, #2f8f52);
    --wb-warn: var(--dsw-alias-state-warn-primary, #a9821c);
    --wb-icon: var(--dsw-alias-interactive-bg-active, rgba(31,35,41,0.07));
    --wb-hover: var(--dsw-alias-interactive-bg-hover, rgba(31,35,41,0.05));
    --wb-active: var(--dsw-alias-interactive-bg-active, rgba(31,35,41,0.08));
    --wb-border: var(--dsw-alias-border-l3, rgba(31,35,41,0.12));
    --wb-input: var(--dsw-alias-bg-layer-3, #f2f3f6);
    --wb-hairline: var(--dsw-alias-border-l2, rgba(31,35,41,0.09));
    --wb-overlay: rgba(16,17,26,0.32);
    --wb-veil: var(--wb-panel);
    --wb-sheen: transparent;
    --wb-rail-sheen: transparent;
  }
}
.dsh-workbench {
  --wb-rail: #16171a;
  --wb-rail-border: rgba(255,255,255,0.08);
  --wb-bg: #141518;
  --wb-panel: #18191d;
  --wb-panel-2: #1f2025;
  --wb-text: #eceef2;
  --wb-muted: #989ea8;
  --wb-faint: #6b717b;
  --wb-accent: #4c8dff;
  --wb-accent-2: #3b76e6;
  --wb-accent-ink: #ffffff;
  --wb-btn-primary-bg: #eceef2;
  --wb-btn-primary-hover: #ffffff;
  --wb-btn-primary-ink: #141518;
  --wb-danger: #e05252;
  --wb-ok: #39bf83;
  --wb-warn: #d9a441;
  --wb-icon: rgba(255,255,255,0.08);
  --wb-hover: rgba(255,255,255,0.05);
  --wb-active: rgba(255,255,255,0.08);
  --wb-border: rgba(255,255,255,0.11);
  --wb-input: rgba(255,255,255,0.04);
  --wb-hairline: rgba(255,255,255,0.08);
  --wb-overlay: rgba(5,6,10,0.54);
  --wb-veil: #18191d;
  --wb-sheen: transparent;
  --wb-rail-sheen: transparent;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  display: flex;
  color: var(--wb-text);
  background: var(--wb-bg);
  font: 14px/22px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  overflow: hidden;
}
`;

export const WORKBENCH_TOKENS_CSS = `${WORKBENCH_THEME_CSS}${WORKBENCH_UI_TOKEN_CSS}`;
