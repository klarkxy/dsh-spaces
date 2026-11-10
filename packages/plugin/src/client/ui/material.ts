/**
 * Material layer of the host-side client surfaces.
 *
 * The host owns the palette: every colour comes from the DSH `--dsw-*` theme
 * tokens, so the Spaces panel and the space dock follow the host theme
 * without the surface having to know which theme the host runs.
 *
 * The shared `--dsh-ui-*` layer adds what the host does not provide —
 * elevation, glass, accent glow, radii and motion durations. It is read
 * through the local `--sp-*` / `--host-*` variables, so no existing rule has
 * to change and the host tokens stay the single source of colour.
 *
 * The DSH client publishes the resolved theme on
 * `<html data-ds-theme-source="light|dark|system">` and marks the dark
 * palette with `<body data-ds-dark-theme>`. The light block below mirrors the
 * shared light material onto the two surfaces, so elevation and glow read
 * correctly on a light host without any JavaScript.
 */
import { uiTokenMixin } from "../../../../../src/shared/ui/tokens";

/** The host resolved its theme to light. */
const HOST_LIGHT = ':where(html[data-ds-theme-source="light"])';
/** The host follows the operating system, or predates the theme source. */
const HOST_SYSTEM = ':where(html[data-ds-theme-source="system"], html:not([data-ds-theme-source]))';
/** The host is not painting the dark palette. */
const HOST_NOT_DARK = ':where(body:not([data-ds-dark-theme]))';

/** Space dock tokens: same host palette, shared material on top. */
export const HOST_UI_TOKEN_CSS = uiTokenMixin(".dsh-host-dock", {
  "--host-text": "var(--dsw-alias-label-primary, #202127)",
  "--host-bg": "var(--dsw-alias-bg-base, #ffffff)",
  "--host-rail-bg": "var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f0f1f5))",
  "--host-border": "var(--dsw-alias-border-l3, #d6d8de)",
  "--host-hover": "color-mix(in srgb, var(--host-text) 10%, transparent)",
  "--host-active": "color-mix(in srgb, var(--host-text) 12%, transparent)",
  "--host-accent": "var(--dsw-alias-button-primary-fill, #5865f2)",
  "--host-danger": "var(--dsw-alias-label-error, #d1242f)",
  "--host-elev-sm": "var(--dsh-ui-shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.2))",
  "--host-elev-md": "var(--dsh-ui-shadow-md, 0 10px 26px -14px rgba(0, 0, 0, 0.45))",
  "--host-elev-lg": "var(--dsh-ui-shadow-lg, 0 24px 48px -20px rgba(0, 0, 0, 0.55))",
  "--host-glow": "var(--dsh-ui-glow, 0 0 24px -6px rgba(88, 101, 242, 0.6))",
  "--host-glass": "color-mix(in srgb, var(--host-bg) 78%, transparent)",
  "--host-glass-blur": "var(--dsh-ui-glass-blur, blur(16px) saturate(140%))",
  "--host-radius-sm": "var(--dsh-ui-radius-sm, 8px)",
  "--host-radius-md": "var(--dsh-ui-radius-md, 12px)",
  "--host-radius-lg": "var(--dsh-ui-radius-lg, 16px)",
  "--host-radius-pill": "var(--dsh-ui-radius-pill, 999px)",
  "--host-dur-fast": "var(--dsh-ui-dur-fast, 120ms)",
  "--host-dur-base": "var(--dsh-ui-dur-base, 200ms)",
  "--host-dur-slow": "var(--dsh-ui-dur-slow, 360ms)",
  "--host-ease-standard": "var(--dsh-ui-ease-standard, cubic-bezier(0.2, 0, 0, 1))",
  "--host-ease-spring": "var(--dsh-ui-ease-spring, cubic-bezier(0.34, 1.56, 0.64, 1))",
  "--host-accent-gradient": "var(--dsh-ui-accent-gradient, linear-gradient(135deg, #5865f2 0%, #8b5cf6 100%))",
  "--host-shimmer": "linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--host-text) 14%, transparent) 42%, transparent 64%)",
  /** Attention halo colour: the shared accent-2 hue, distinct from the warn status pulse. */
  "--dsh-spaces-attention": "var(--dsh-ui-accent-2, #8b5cf6)",
});

/**
 * Light-host material. The shared layer defaults to the dark palette, so the
 * elevation and glow values are re-declared here for a host that resolved to
 * light. The surfaces keep consuming the same `--dsh-ui-*` names.
 */
export const HOST_LIGHT_MATERIAL_CSS = `
${HOST_LIGHT} .dsh-spaces,
${HOST_LIGHT} .dsh-host-dock {
  --dsh-ui-shadow-sm: 0 1px 2px rgba(16, 17, 26, 0.1);
  --dsh-ui-shadow-md: 0 6px 18px -8px rgba(16, 17, 26, 0.22);
  --dsh-ui-shadow-lg: 0 20px 48px -16px rgba(16, 17, 26, 0.28);
  --dsh-ui-glow: 0 0 24px -6px rgba(88, 101, 242, 0.45);
}
@media (prefers-color-scheme: light) {
  ${HOST_SYSTEM} ${HOST_NOT_DARK} .dsh-spaces,
  ${HOST_SYSTEM} ${HOST_NOT_DARK} .dsh-host-dock {
    --dsh-ui-shadow-sm: 0 1px 2px rgba(16, 17, 26, 0.1);
    --dsh-ui-shadow-md: 0 6px 18px -8px rgba(16, 17, 26, 0.22);
    --dsh-ui-shadow-lg: 0 20px 48px -16px rgba(16, 17, 26, 0.28);
    --dsh-ui-glow: 0 0 24px -6px rgba(88, 101, 242, 0.45);
  }
}
`;
