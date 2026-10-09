import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { BUS_CHANNEL, BUS_MAX_PENDING, busFailure, busIdentifier, parseBusMessage, type BusMessage, type BusResponse } from '../../../shared/space-message-bus.ts';

type Session = { spaceId: string; child: ChildProcess; dispose(): void };
type Pending = { caller: Session; target: Session; requestId: string; timer: ReturnType<typeof setTimeout> };
/** A session is the exact owned ChildProcess, never a message's claimed identity. */
export class SpaceMessageRouter {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Pending>();
  get pendingCount(): number { return this.pending.size; }
  attach(spaceId: string, child: ChildProcess): () => void {
    if (!busIdentifier(spaceId) || !child.connected) return () => {};
    this.sessions.get(spaceId)?.dispose();
    const session: Session = { spaceId, child, dispose: () => {
      if (this.sessions.get(spaceId) !== session) return;
      this.sessions.delete(spaceId);
      child.off('message', receive); child.off('disconnect', session.dispose); child.off('exit', session.dispose); child.off('error', session.dispose);
      for (const [id, p] of this.pending) {
        if (p.caller === session || p.target === session) this.finish(id, busFailure(id, 'disconnected'));
      }
    } };
    const receive = (raw: unknown) => {
      if (this.sessions.get(spaceId) !== session) return;
      let message;
      try { message = parseBusMessage(raw); } catch {
        const id = (raw as { requestId?: unknown })?.requestId;
        if (busIdentifier(id)) this.send(session, busFailure(id, 'invalid-input'));
        return;
      }
      if (!message) return;
      if (message.kind === 'response') {
        if (this.pending.get(message.requestId)?.target === session) this.finish(message.requestId, message);
        return;
      }
      if (message.kind !== 'request') return;
      const target = this.sessions.get(message.target);
      if (!target) { this.send(session, busFailure(message.requestId, 'target-unavailable')); return; }
      if (this.pending.size >= BUS_MAX_PENDING || [...this.pending.values()].some(p => p.caller === session && p.requestId === message.requestId)) {
        this.send(session, busFailure(message.requestId, 'overloaded')); return;
      }
      const id = randomUUID(); // independent routing ID prevents cross-caller collisions and old-run replies
      let invoke: BusMessage;
      try { invoke = parseBusMessage({ channel: BUS_CHANNEL, kind: 'invoke', requestId: id, source: session.spaceId,
        operation: message.operation, params: message.params, timeoutMs: message.timeoutMs })!; }
      catch { this.send(session, busFailure(message.requestId, 'invalid-input')); return; }
      const timer = setTimeout(() => this.finish(id, busFailure(id, 'timeout')), message.timeoutMs);
      this.pending.set(id, { caller: session, target, requestId: message.requestId, timer });
      this.send(target, invoke, () => this.finish(id, busFailure(id, 'disconnected')));
    };
    this.sessions.set(spaceId, session);
    child.on('message', receive); child.once('disconnect', session.dispose); child.once('exit', session.dispose); child.once('error', session.dispose);
    return session.dispose;
  }
  private finish(id: string, response: BusResponse): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id); clearTimeout(p.timer);
    let reply: BusMessage;
    try { reply = parseBusMessage({ ...response, requestId: p.requestId })!; }
    catch { reply = busFailure(p.requestId, 'operation-failed'); }
    this.send(p.caller, reply);
  }
  private send(session: Session, message: BusMessage, failed?: () => void): void {
    if (this.sessions.get(session.spaceId) !== session || !session.child.connected) { failed?.(); return; }
    try { session.child.send(message, error => { if (error) failed?.(); }); } catch { failed?.(); }
  }
  close(): void { for (const session of [...this.sessions.values()]) session.dispose(); }
}
