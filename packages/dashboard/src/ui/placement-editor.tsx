import React, { useEffect, useState, type ReactNode } from 'react';
import type { Placement } from '../../../../src/shared/dashboard.js';

/**
 * Position and size editor for one pinned widget.
 *
 * The form only edits a local draft; the board command is built by the
 * caller, which keeps the compare-and-swap revision check in one place.
 */
export function PlacementEditor({ placement, disabled, onChange }: { placement: Placement; disabled: boolean; onChange(position: Pick<Placement, 'x' | 'y' | 'w' | 'h'>): void }): ReactNode {
  const [position, setPosition] = useState({ x: placement.x, y: placement.y, w: placement.w, h: placement.h });
  useEffect(() => setPosition({ x: placement.x, y: placement.y, w: placement.w, h: placement.h }), [placement.x, placement.y, placement.w, placement.h]);
  return <details className="dd-placement"><summary>调整布局</summary><form onSubmit={event => { event.preventDefault(); onChange(position); }}>
    {(['x', 'y', 'w', 'h'] as const).map(key => <label key={key}>{({ x: '列', y: '行', w: '宽', h: '高' })[key]}<input type="number" step={1} min={key === 'w' || key === 'h' ? 1 : 0} max={key === 'x' ? 11 : key === 'w' ? 12 : key === 'y' ? 9999 : 10000} value={position[key]} disabled={disabled} onChange={event => setPosition({ ...position, [key]: event.currentTarget.valueAsNumber })} /></label>)}
    <button type="submit" disabled={disabled}>保存位置</button>
  </form></details>;
}
