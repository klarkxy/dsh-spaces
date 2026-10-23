import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { MotionRoot } from '../../../../src/shared/ui/index.js';
import { DashboardFault, publicError } from '../../../../src/core/domain/dashboard/errors.js';
import { DashboardReadSession } from '../../../../src/core/domain/dashboard/read-session.js';
import { parseLayoutDocument } from '../../../../src/core/domain/dashboard/boards.js';
import type { BoardCommand, BoardMutationReceipt, DashboardError, InstanceRef } from '../../../../src/shared/dashboard.js';
import { moveCommand, pinCommand, readDashboardFrame, unpinCommand, type DashboardFrame, type DashboardReadBackend } from '../model.js';
import { DashboardView } from './dashboard-view.js';

/** Mount with an authenticated backend supplied by the Host; never creates a manager or discovers a Home. */
export function DashboardApp({ backend, mode, theme, onOpen }: { backend: DashboardReadBackend; mode?: 'home' | 'local'; theme?: 'dark' | 'light' | 'system'; onOpen?(ref: InstanceRef): void }): ReactNode {
  const [frame, setFrame] = useState<DashboardFrame | null>(null);
  const [error, setError] = useState<DashboardError | null>(null);
  const [writeError, setWriteError] = useState<DashboardError | null>(null);
  const [busy, setBusy] = useState(false);
  const [boardId, setBoardId] = useState<string>();
  const generation = useRef(0);
  const writing = useRef(false);
  const writeVersion = useRef(0);
  const reader = useRef<DashboardReadSession<{ value: DashboardFrame; writeVersion: number }> | null>(null);
  useEffect(() => {
    generation.current++; writeVersion.current++; setError(null); setWriteError(null); writing.current = false; setBusy(false);
    const session = new DashboardReadSession({
      read: async (signal, progress) => {
        const version = writeVersion.current;
        return { value: await readDashboardFrame(backend, signal, boardId, progress), writeVersion: version };
      },
      onValue: result => {
        // A poll begun before/during a local write must not replace its newer
        // receipt with an older layout. The next normal successful poll reads it.
        if (result.writeVersion === writeVersion.current && !writing.current) setFrame(result.value);
      },
      onFailure: failure => setError(failure), clearSensitive: () => setFrame(null),
    });
    reader.current = session;
    session.start();
    return () => { generation.current++; session.close(); if (reader.current === session) reader.current = null; };
  }, [backend, boardId]);
  async function write(make: (current: DashboardFrame) => BoardCommand): Promise<void> {
    if (!frame || error || writing.current || !frame.overview.capabilities.layoutWrite) return;
    writing.current = true; writeVersion.current++; setBusy(true); setWriteError(null);
    const identity = generation.current;
    let requestId: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      requestId = crypto.randomUUID();
      const command = make(frame);
      const request = { requestId, issuedAt: new Date().toISOString(), backendEpoch: frame.backendEpoch, command };
      const receipt = await Promise.race<BoardMutationReceipt>([
        backend.mutate(request),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new DashboardFault('dashboard/unavailable')), 5000); }),
      ]);
      if (identity !== generation.current) return;
      if (receipt.protocolVersion !== 1 || receipt.requestId !== requestId || receipt.backendEpoch !== frame.backendEpoch) throw new DashboardFault('dashboard/invalid-input');
      if (receipt.result.kind !== 'board.saved') throw new DashboardFault('dashboard/invalid-input');
      const saved = parseLayoutDocument({ schemaVersion: 1, boards: [receipt.result.board], tombstones: [], receipts: [] }).boards[0];
      if (saved.id !== command.boardId) throw new DashboardFault('dashboard/invalid-input');
      setFrame(previous => previous && previous.backendEpoch === receipt.backendEpoch && previous.boardId === saved.id ? { ...previous, board: saved } : previous);
    } catch (failure) {
      if (identity === generation.current) {
        const exposed = publicError(failure);
        if (exposed.code === 'dashboard/unauthenticated' || exposed.code === 'dashboard/forbidden') {
          reader.current?.close();
          setError(exposed);
        }
        setWriteError({ ...exposed, ...(requestId ? { requestId } : {}) });
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (identity === generation.current) { writeVersion.current++; writing.current = false; setBusy(false); }
    }
  }
  return <MotionRoot>
    <DashboardView frame={frame} mode={mode} theme={theme} error={error} writeError={writeError} busy={busy} onBoard={setBoardId} onOpen={onOpen}
      onPin={entry => { void write(current => pinCommand(current, entry.ref, crypto.randomUUID())); }}
      onUnpin={id => { void write(current => unpinCommand(current, id)); }}
      onMove={(id, position) => { void write(current => moveCommand(current, id, position)); }} />
  </MotionRoot>;
}
