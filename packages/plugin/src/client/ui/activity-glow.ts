/**
 * Ambient light of the current native space.
 *
 * Green: the space is working. Yellow: an approval or a question waits for the
 * user. The shell resolves one value (see `host-activity.ts`) and writes it as
 * `data-host-glow` on the dock, `data-glow` on the light layer and on the
 * pinned current entry. Nothing here animates in a loop: the light fades in and
 * out once, and an absent attribute means no light at all.
 *
 * Three places carry it, none of them over the native view (which paints above
 * the DOM and is never covered):
 *  - the rail's inner edge,
 *  - the pinned current entry,
 *  - the edges of the host content, only while that content is the one shown.
 *
 * Colours come from the shared `--dsh-ui-ok` / `--dsh-ui-warn` tokens; the
 * existing sub-space attention halo is untouched.
 */
export const HOST_ACTIVITY_GLOW_CSS = `
.dsh-host-dock {
  --dsh-glow-working: var(--dsh-ui-ok, #39bf83);
  --dsh-glow-attention: var(--dsh-ui-warn, #d9a441);
  --dsh-glow-strength: 42%;
}
html[data-ds-theme-source="light"] .dsh-host-dock { --dsh-glow-strength: 64%; }
@media (prefers-color-scheme: light) {
  html:is([data-ds-theme-source="system"], :not([data-ds-theme-source])) body:not([data-ds-dark-theme]) .dsh-host-dock { --dsh-glow-strength: 64%; }
}
.dsh-host-dock[data-host-glow="working"] { --dsh-glow-color: var(--dsh-glow-working); }
.dsh-host-dock[data-host-glow="attention"] { --dsh-glow-color: var(--dsh-glow-attention); }

/* Rail inner edge. */
.dsh-host-dock[data-host-glow] .dsh-host-rail {
  box-shadow:
    inset -2px 0 0 0 color-mix(in srgb, var(--dsh-glow-color) calc(var(--dsh-glow-strength) + 28%), transparent),
    inset -16px 0 20px -16px color-mix(in srgb, var(--dsh-glow-color) var(--dsh-glow-strength), transparent);
}

/* Host content edges: a soft inset bleed, never a frame. */
.dsh-host-glow {
  position: absolute;
  top: var(--dsh-frame-top-clearance, 0px);
  bottom: 0;
  left: var(--dsh-spaces-rail-width, 72px);
  right: 0;
  z-index: 1;
  pointer-events: none;
  opacity: 0;
  box-shadow: inset 0 0 56px -20px color-mix(in srgb, var(--dsh-glow-color, transparent) var(--dsh-glow-strength), transparent);
  transition: opacity var(--host-dur-slow, 360ms) var(--host-ease-standard, cubic-bezier(0.2, 0, 0, 1));
}
.dsh-host-glow[data-glow][data-surface="current"] { opacity: 1; }

/* Pinned current entry: a static ring, faded in once. It sits above the full-bleed
   glyph (z-index 1) and the selection pill (2), or the glyph would cover it. */
.dsh-host-rail-btn[data-pinned="true"]::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
  border-radius: inherit;
  border: 2px solid color-mix(in srgb, var(--dsh-glow-color, transparent) calc(var(--dsh-glow-strength) + 40%), transparent);
  box-shadow:
    0 0 12px -2px color-mix(in srgb, var(--dsh-glow-color, transparent) var(--dsh-glow-strength), transparent),
    inset 0 0 8px -4px color-mix(in srgb, var(--dsh-glow-color, transparent) var(--dsh-glow-strength), transparent);
  opacity: 0;
  transition: opacity var(--host-dur-slow, 360ms) var(--host-ease-standard, cubic-bezier(0.2, 0, 0, 1));
}
.dsh-host-rail-btn[data-pinned="true"][data-glow]::after { opacity: 1; }

/* Spoken state: empty when there is no light. */
.dsh-host-glow-status {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .dsh-host-glow, .dsh-host-rail-btn[data-pinned="true"]::after, .dsh-host-dock[data-host-glow] .dsh-host-rail { transition: none; }
}
/* Forced colours drop shadows: show the state with system-colour borders, and keep the two states apart by line style. */
@media (forced-colors: active) {
  .dsh-host-dock[data-host-glow] .dsh-host-rail { box-shadow: none; border-right: 3px solid Highlight; }
  .dsh-host-dock[data-host-glow="working"] .dsh-host-rail { border-right-style: dashed; }
  .dsh-host-glow { box-shadow: none; border: 3px solid Highlight; box-sizing: border-box; }
  .dsh-host-glow[data-glow="working"] { border-style: dashed; }
  .dsh-host-rail-btn[data-pinned="true"]::after { border-color: Highlight; box-shadow: none; }
  .dsh-host-rail-btn[data-pinned="true"][data-glow="working"]::after { border-style: dashed; }
}
`;
