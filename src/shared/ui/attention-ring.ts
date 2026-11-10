/**
 * The shared "needs attention" halo for space rail entries.
 *
 * A soft breathing ring drawn INSIDE the button bounds: every rail button
 * locks `overflow: hidden`, so an outer glow would be clipped anyway. The ring
 * reads `--dsh-spaces-attention` for its colour so each surface picks its own
 * accent without duplicating the animation.
 *
 * It marks a pending approval or question, never an error and never a status:
 * the existing status dot and the warn "starting" pulse stay untouched.
 */
export const ATTENTION_RING_CSS = `
@keyframes dsh-ui-attention-breathe {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
[data-attention="required"]::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  border-radius: inherit;
  border: 2px solid var(--dsh-spaces-attention, #8b5cf6);
  box-shadow:
    0 0 12px -2px color-mix(in srgb, var(--dsh-spaces-attention, #8b5cf6) 55%, transparent),
    inset 0 0 8px -4px color-mix(in srgb, var(--dsh-spaces-attention, #8b5cf6) 45%, transparent);
  animation: dsh-ui-attention-breathe 2s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  [data-attention="required"]::after { animation: none; }
}
`;
