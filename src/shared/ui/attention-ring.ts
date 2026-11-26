/**
 * Per-space sidebar activity & attention glow for space rail buttons.
 *
 * Scoped strictly to rail buttons (`.dsh-host-rail-btn` and `.dsh-wb-rail-btn`)
 * and drawn INSIDE the button bounds (`overflow: hidden` clips outer glow):
 *
 * - Green (`data-glow="working"`): the space is actively running a task and has
 *   no pending approval/question. Static ring.
 * - Yellow (`data-glow="attention"` or `data-attention="required"`): the space
 *   needs user intervention (pending tool approval or `ask_user_question`).
 *   Always overrides green and breathes softly.
 *
 * The status dot sits at `z-index: 4`, above this ring (`z-index: 3`), which in
 * turn sits above the full-bleed space icon (`z-index: 1`) and selection pill.
 */
export const ATTENTION_RING_CSS = `
@keyframes dsh-ui-attention-breathe {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
:is(.dsh-host-rail-btn, .dsh-wb-rail-btn):is([data-glow="working"], [data-glow="attention"], [data-attention="required"])::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
  border-radius: inherit;
}
:is(.dsh-host-rail-btn, .dsh-wb-rail-btn)[data-glow="working"]:not([data-attention="required"]):not([data-glow="attention"])::after {
  border: 2px solid var(--dsh-spaces-working, var(--dsh-ui-ok, #39bf83));
  box-shadow:
    inset 0 0 10px -2px color-mix(in srgb, var(--dsh-spaces-working, var(--dsh-ui-ok, #39bf83)) 55%, transparent);
}
:is(.dsh-host-rail-btn, .dsh-wb-rail-btn):is([data-glow="attention"], [data-attention="required"])::after {
  border: 2px solid var(--dsh-spaces-attention, var(--dsh-ui-warn, #d9a441));
  box-shadow:
    0 0 12px -2px color-mix(in srgb, var(--dsh-spaces-attention, var(--dsh-ui-warn, #d9a441)) 55%, transparent),
    inset 0 0 10px -2px color-mix(in srgb, var(--dsh-spaces-attention, var(--dsh-ui-warn, #d9a441)) 55%, transparent);
  animation: dsh-ui-attention-breathe 2s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  :is(.dsh-host-rail-btn, .dsh-wb-rail-btn):is([data-glow="attention"], [data-attention="required"])::after { animation: none; }
}
@media (forced-colors: active) {
  :is(.dsh-host-rail-btn, .dsh-wb-rail-btn):is([data-glow="working"], [data-glow="attention"], [data-attention="required"])::after {
    border-color: Highlight;
    box-shadow: none;
  }
  :is(.dsh-host-rail-btn, .dsh-wb-rail-btn)[data-glow="working"]:not([data-attention="required"]):not([data-glow="attention"])::after {
    border-style: dashed;
  }
}
`;
