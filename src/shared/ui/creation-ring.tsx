/**
 * A segmented circular progress ring for space creation.
 *
 * The ring is step-based, never a spinner and never a fake percentage: one
 * arc per create step, with the current step pulsing softly. Presentation
 * only — it is aria-hidden and carries its step data on the root.
 */

import React, { type ReactElement } from "react";

/** Shared ring styles; each surface interpolates this under its own root. */
export const CREATION_RING_CSS = `
.dsh-host-rail-btn > .dsh-creation-ring, .dsh-wb-rail-btn > .dsh-creation-ring { position:absolute; inset:2px; z-index:2; pointer-events:none; }
.dsh-creation-ring svg { display:block; width:100%; height:100%; }
.dsh-creation-arc { fill:none; stroke-width:3; stroke-linecap:round; stroke:color-mix(in srgb, currentColor 28%, transparent); }
.dsh-creation-arc.done { stroke:var(--host-accent, var(--wb-accent, #5865f2)); }
.dsh-creation-arc.current { stroke:var(--host-accent, var(--wb-accent, #5865f2)); animation:dsh-creation-pulse 1.6s ease-in-out infinite; }
.dsh-creation-arc.failed { stroke:var(--host-danger, var(--wb-danger, #d1242f)); }
.dsh-creation-arc.idle { stroke:color-mix(in srgb, currentColor 18%, transparent); }
@keyframes dsh-creation-pulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }
@media (prefers-reduced-motion: reduce) { .dsh-creation-arc.current { animation:none; } }
button:has(.dsh-creation-ring[data-creation-status="running"]) .dsh-wb-glyph,
button:has(.dsh-creation-ring[data-creation-status="running"]) .dsh-wb-glyph-img,
button:has(.dsh-creation-ring[data-creation-status="queued"]) .dsh-wb-glyph,
button:has(.dsh-creation-ring[data-creation-status="queued"]) .dsh-wb-glyph-img { opacity:.5; }
.dsh-host-rail-btn > .dsh-wb-creation-failed, .dsh-wb-rail-btn > .dsh-wb-creation-failed { position:absolute; top:2px; right:2px; width:16px; height:16px; border-radius:50%; background:var(--host-danger, var(--wb-danger, #d1242f)); color:#fff; font:bold 12px/16px system-ui; text-align:center; z-index:3; }
`;

export type CreationRingStatus = "queued" | "running" | "failed";

function arcPath(radius: number, startDeg: number, endDeg: number): string {
  const point = (deg: number): [number, number] => {
    const rad = (deg * Math.PI) / 180;
    return [24 + radius * Math.cos(rad), 24 + radius * Math.sin(rad)];
  };
  const [x1, y1] = point(startDeg);
  const [x2, y2] = point(endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
}

export function CreationRing({ index, total, status }: { index: number; total: number; status: CreationRingStatus }): ReactElement {
  const gap = total > 1 ? 14 : 0;
  const span = 360 / total;
  const segmentClass = (i: number): string => {
    if (status === "failed") return "failed";
    if (status === "queued") return "idle";
    if (i < index) return "done";
    if (i === index) return "current";
    return "idle";
  };
  return (
    <span
      className="dsh-creation-ring"
      data-creation-step={index + 1}
      data-creation-total={total}
      data-creation-status={status}
      aria-hidden="true"
    >
      <svg viewBox="0 0 48 48">
        {Array.from({ length: total }, (_, i) => (
          <path
            key={i}
            d={arcPath(21, -90 + i * span + gap / 2, -90 + (i + 1) * span - gap / 2)}
            className={`dsh-creation-arc ${segmentClass(i)}`}
          />
        ))}
      </svg>
    </span>
  );
}
