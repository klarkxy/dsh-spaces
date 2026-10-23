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
  "--wb-elev-sm": "var(--dsh-ui-shadow-sm, 0 1px 2px rgba(0,0,0,0.32))",
  "--wb-elev-md": "var(--dsh-ui-shadow-md, 0 6px 18px -8px rgba(0,0,0,0.55))",
  "--wb-elev-lg": "var(--dsh-ui-shadow-lg, 0 20px 48px -16px rgba(0,0,0,0.65))",
  "--wb-elev-glow": "var(--dsh-ui-glow, 0 0 24px -6px rgba(88,101,242,0.7))",
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
  "--wb-glass-bg": "var(--dsh-ui-glass-bg, rgba(24,25,29,0.72))",
  "--wb-glass-blur": "var(--dsh-ui-glass-blur, blur(18px) saturate(140%))",
  "--wb-accent-gradient": "var(--dsh-ui-accent-gradient, linear-gradient(135deg, #5865f2 0%, #8b5cf6 100%))",
  "--wb-focus-ring": "var(--dsh-ui-focus-ring, 0 0 0 2px #0f1012, 0 0 0 4px #5865f2)",
  "--wb-dur-fast": "var(--dsh-ui-dur-fast, 120ms)",
  "--wb-dur-base": "var(--dsh-ui-dur-base, 200ms)",
  "--wb-dur-slow": "var(--dsh-ui-dur-slow, 360ms)",
  "--wb-ease-standard": "var(--dsh-ui-ease-standard, cubic-bezier(0.2, 0, 0, 1))",
  "--wb-ease-emphasized": "var(--dsh-ui-ease-emphasized, cubic-bezier(0.32, 0.72, 0, 1))",
  "--wb-ease-spring": "var(--dsh-ui-ease-spring, cubic-bezier(0.34, 1.56, 0.64, 1))",
});

export const WORKBENCH_THEME_CSS = `
.dsh-workbench[data-theme="light"] {
  --wb-rail: #eceef2;
  --wb-rail-border: rgba(0,0,0,0.08);
  --wb-bg: #f6f7f9;
  --wb-panel: #ffffff;
  --wb-panel-2: #f1f3f6;
  --wb-text: #16171a;
  --wb-muted: #5c6166;
  --wb-faint: #8a9096;
  --wb-accent: #5865f2;
  --wb-accent-2: #7c3aed;
  --wb-accent-ink: #fff;
  --wb-danger: #d1242f;
  --wb-ok: #2f8f52;
  --wb-warn: #a9821c;
  --wb-icon: color-mix(in srgb, var(--wb-text) 10%, var(--wb-bg));
  --wb-border: color-mix(in srgb, var(--wb-text) 15%, transparent);
  --wb-input: color-mix(in srgb, var(--wb-text) 5%, var(--wb-bg));
  --wb-hairline: color-mix(in srgb, var(--wb-text) 12%, transparent);
  --wb-overlay: rgba(16,17,26,0.34);
  --wb-veil: color-mix(in srgb, var(--wb-panel) 82%, transparent);
  --wb-sheen: color-mix(in srgb, #ffffff 70%, transparent);
  --wb-rail-sheen: color-mix(in srgb, #ffffff 55%, transparent);
}
@media (prefers-color-scheme: light) {
  .dsh-workbench[data-theme="system"] {
    --wb-rail: #eceef2;
    --wb-rail-border: rgba(0,0,0,0.08);
    --wb-bg: #f6f7f9;
    --wb-panel: #ffffff;
    --wb-panel-2: #f1f3f6;
    --wb-text: #16171a;
    --wb-muted: #5c6166;
    --wb-faint: #8a9096;
    --wb-accent: #5865f2;
    --wb-accent-2: #7c3aed;
    --wb-accent-ink: #fff;
    --wb-danger: #d1242f;
    --wb-ok: #2f8f52;
    --wb-warn: #a9821c;
    --wb-icon: color-mix(in srgb, var(--wb-text) 10%, var(--wb-bg));
    --wb-border: color-mix(in srgb, var(--wb-text) 15%, transparent);
    --wb-input: color-mix(in srgb, var(--wb-text) 5%, var(--wb-bg));
    --wb-hairline: color-mix(in srgb, var(--wb-text) 12%, transparent);
    --wb-overlay: rgba(16,17,26,0.34);
    --wb-veil: color-mix(in srgb, var(--wb-panel) 82%, transparent);
    --wb-sheen: color-mix(in srgb, #ffffff 70%, transparent);
    --wb-rail-sheen: color-mix(in srgb, #ffffff 55%, transparent);
  }
}
.dsh-workbench {
  --wb-rail: #16171a;
  --wb-rail-border: rgba(255,255,255,0.08);
  --wb-bg: #0f1012;
  --wb-panel: #18191d;
  --wb-panel-2: #1f2025;
  --wb-text: #f2f3f5;
  --wb-muted: #9aa0a6;
  --wb-faint: #6e7378;
  --wb-accent: #5865f2;
  --wb-accent-2: #8b5cf6;
  --wb-accent-ink: #fff;
  --wb-danger: #d1242f;
  --wb-ok: #3ba55d;
  --wb-warn: #c9a227;
  --wb-icon: color-mix(in srgb, var(--wb-text) 10%, var(--wb-bg));
  --wb-border: color-mix(in srgb, var(--wb-text) 15%, transparent);
  --wb-input: color-mix(in srgb, var(--wb-text) 5%, var(--wb-bg));
  --wb-hairline: color-mix(in srgb, var(--wb-text) 10%, transparent);
  --wb-overlay: rgba(5,6,10,0.58);
  --wb-veil: color-mix(in srgb, var(--wb-panel) 78%, transparent);
  --wb-sheen: color-mix(in srgb, #ffffff 8%, transparent);
  --wb-rail-sheen: color-mix(in srgb, #ffffff 5%, transparent);
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  display: flex;
  color: var(--wb-text);
  background: var(--wb-bg);
  font: 14px/1.45 system-ui, "Segoe UI", sans-serif;
  overflow: hidden;
}
`;

export const WORKBENCH_TOKENS_CSS = `${WORKBENCH_THEME_CSS}${WORKBENCH_UI_TOKEN_CSS}`;
