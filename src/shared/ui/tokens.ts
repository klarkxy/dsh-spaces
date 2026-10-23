/**
 * Shared UI design tokens.
 *
 * Browser-only: this module produces CSS text and imports nothing from Node
 * adapters, so any surface (workbench, host shell, browser space)
 * can inline it into its own stylesheet.
 *
 * The token layer is scoped to `.dsh-ui`. A surface root carries that class
 * next to its own class (`class="dsh-workbench dsh-ui"`) so the shared custom
 * properties resolve on that element and inherit downwards.
 *
 * Surfaces keep their existing variable names (`--wb-*`, `--dsh-spaces-*`) and
 * map them onto these tokens with `uiTokenMixin`, so no existing rule has to
 * change when the shared layer changes.
 */

/**
 * The shared token layer plus the shared keyframes.
 *
 * Dark is the default. Light follows the same conventions the workbench
 * already uses: an explicit `data-theme="light"`, or `data-theme="system"`
 * together with `prefers-color-scheme: light`.
 */
export const UI_TOKENS_CSS = `
.dsh-ui {
  /* Material colours (dark default). */
  --dsh-ui-bg: #0f1012;
  --dsh-ui-surface: #18191d;
  --dsh-ui-surface-2: #1f2025;
  --dsh-ui-text: #f2f3f5;
  --dsh-ui-muted: #9aa0a6;
  --dsh-ui-faint: #6e7378;
  --dsh-ui-border: color-mix(in srgb, var(--dsh-ui-text) 15%, transparent);
  --dsh-ui-accent: #5865f2;
  --dsh-ui-accent-2: #8b5cf6;
  --dsh-ui-accent-ink: #ffffff;
  --dsh-ui-danger: #d1242f;
  --dsh-ui-ok: #3ba55d;
  --dsh-ui-warn: #c9a227;

  /* Elevation. */
  --dsh-ui-shadow-sm: 0 1px 2px rgba(0,0,0,0.32);
  --dsh-ui-shadow-md: 0 6px 18px -8px rgba(0,0,0,0.55);
  --dsh-ui-shadow-lg: 0 20px 48px -16px rgba(0,0,0,0.65);
  --dsh-ui-glow: 0 0 24px -6px color-mix(in srgb, var(--dsh-ui-accent) 70%, transparent);

  /* Radii. */
  --dsh-ui-radius-xs: 6px;
  --dsh-ui-radius-sm: 8px;
  --dsh-ui-radius-md: 12px;
  --dsh-ui-radius-lg: 16px;
  --dsh-ui-radius-pill: 999px;

  /* Spacing scale. */
  --dsh-ui-space-1: 4px;
  --dsh-ui-space-2: 8px;
  --dsh-ui-space-3: 12px;
  --dsh-ui-space-4: 16px;
  --dsh-ui-space-5: 24px;
  --dsh-ui-space-6: 32px;
  --dsh-ui-space-7: 48px;

  /* Durations. */
  --dsh-ui-dur-fast: 120ms;
  --dsh-ui-dur-base: 200ms;
  --dsh-ui-dur-slow: 360ms;

  /* Easing. */
  --dsh-ui-ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --dsh-ui-ease-emphasized: cubic-bezier(0.32, 0.72, 0, 1);
  --dsh-ui-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

  /* Glass surface. */
  --dsh-ui-glass-bg: color-mix(in srgb, var(--dsh-ui-surface) 72%, transparent);
  --dsh-ui-glass-blur: blur(18px) saturate(140%);

  /* Accent gradient and focus ring. */
  --dsh-ui-accent-gradient: linear-gradient(135deg, var(--dsh-ui-accent) 0%, var(--dsh-ui-accent-2) 100%);
  --dsh-ui-focus-ring: 0 0 0 2px var(--dsh-ui-bg), 0 0 0 4px var(--dsh-ui-accent);
}
.dsh-ui[data-theme="light"] {
  --dsh-ui-bg: #f6f7f9;
  --dsh-ui-surface: #ffffff;
  --dsh-ui-surface-2: #eceef2;
  --dsh-ui-text: #16171a;
  --dsh-ui-muted: #5c6166;
  --dsh-ui-faint: #8a9096;
  --dsh-ui-border: color-mix(in srgb, var(--dsh-ui-text) 15%, transparent);
  --dsh-ui-accent: #5865f2;
  --dsh-ui-accent-2: #7c3aed;
  --dsh-ui-glass-bg: color-mix(in srgb, var(--dsh-ui-surface) 78%, transparent);
  --dsh-ui-shadow-sm: 0 1px 2px rgba(16,17,26,0.10);
  --dsh-ui-shadow-md: 0 6px 18px -8px rgba(16,17,26,0.22);
  --dsh-ui-shadow-lg: 0 20px 48px -16px rgba(16,17,26,0.28);
  --dsh-ui-glow: 0 0 24px -6px color-mix(in srgb, var(--dsh-ui-accent) 45%, transparent);
}
@media (prefers-color-scheme: light) {
  .dsh-ui[data-theme="system"] {
    --dsh-ui-bg: #f6f7f9;
    --dsh-ui-surface: #ffffff;
    --dsh-ui-surface-2: #eceef2;
    --dsh-ui-text: #16171a;
    --dsh-ui-muted: #5c6166;
    --dsh-ui-faint: #8a9096;
    --dsh-ui-border: color-mix(in srgb, var(--dsh-ui-text) 15%, transparent);
    --dsh-ui-accent: #5865f2;
    --dsh-ui-accent-2: #7c3aed;
    --dsh-ui-glass-bg: color-mix(in srgb, var(--dsh-ui-surface) 78%, transparent);
    --dsh-ui-shadow-sm: 0 1px 2px rgba(16,17,26,0.10);
    --dsh-ui-shadow-md: 0 6px 18px -8px rgba(16,17,26,0.22);
    --dsh-ui-shadow-lg: 0 20px 48px -16px rgba(16,17,26,0.28);
    --dsh-ui-glow: 0 0 24px -6px color-mix(in srgb, var(--dsh-ui-accent) 45%, transparent);
  }
}
@keyframes dsh-ui-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes dsh-ui-scale-in {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes dsh-ui-slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes dsh-ui-shimmer {
  from { background-position: -200% 0; }
  to { background-position: 200% 0; }
}
@keyframes dsh-ui-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
@keyframes dsh-ui-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes dsh-ui-glow-breathe {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-ui, .dsh-ui * {
    animation: none !important;
    transition: none !important;
  }
}
`;

/**
 * Build the CSS rule that maps a surface's own variables onto the shared
 * tokens. This is the mixin every surface uses: the surface keeps its own
 * variable names and only borrows the shared material values, so no existing
 * rule has to be rewritten.
 *
 * @example
 *   uiTokenMixin(".dsh-workbench", {
 *     "--wb-elev-md": "var(--dsh-ui-shadow-md)",
 *     "--wb-glass-bg": "var(--dsh-ui-glass-bg)",
 *   });
 */
export function uiTokenMixin(selector: string, tokens: Record<string, string>): string {
  const declarations = Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `${selector} {\n${declarations}\n}\n`;
}
