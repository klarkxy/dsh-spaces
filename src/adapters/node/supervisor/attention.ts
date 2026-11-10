import {
  parseSpaceAttentionReport,
  type SpaceAttention,
  type SpaceAttentionIdentity,
  type SpaceAttentionTransport,
} from "../../../shared/space-attention";
import type { SpaceRunRegistry } from "./space-runs";

type AttentionSession = {
  identity: SpaceAttentionIdentity;
  transport: SpaceAttentionTransport;
  revision: number;
  attention: SpaceAttention;
  dispose(): void;
};

export interface SupervisorAttentionHost {
  runs: SpaceRunRegistry;
  currentServiceEpoch(): string;
  log?: (message: string) => void;
}

/**
 * Latest attention report per live child identity. Reports only update the
 * cache; they never mutate space state. A stale or malformed message is
 * dropped — an older view bridge that never sends reports simply leaves the
 * space at "unknown".
 */
export class SupervisorAttention {
  private readonly sessions = new Map<string, AttentionSession>();
  private readonly host: SupervisorAttentionHost;

  constructor(host: SupervisorAttentionHost) {
    this.host = host;
  }

  attachChild(spaceId: string, transport: SpaceAttentionTransport, generation: number, serviceEpoch: string): () => void {
    this.sessions.get(spaceId)?.dispose();
    if (!transport.connected || !transport.on) return () => {};
    const identity = { spaceId, generation, serviceEpoch };
    const session: AttentionSession = {
      identity, transport, revision: -1, attention: "unknown",
      dispose: () => {
        if (this.sessions.get(spaceId) !== session) return;
        this.sessions.delete(spaceId);
        transport.off("message", receive);
        for (const event of ["disconnect", "exit", "error"]) transport.off(event, session.dispose);
      },
    };
    const receive = (raw: unknown) => {
      if (this.sessions.get(spaceId) !== session) return;
      const report = parseSpaceAttentionReport(raw, identity);
      if (!report || report.revision <= session.revision) return;
      session.revision = report.revision;
      session.attention = report.attention;
    };
    this.sessions.set(spaceId, session);
    transport.on("message", receive);
    for (const event of ["disconnect", "exit", "error"]) transport.on(event, session.dispose);
    return session.dispose;
  }

  /** The projected attention for one space: unknown for no live report. */
  attentionOf(spaceId: string): SpaceAttention {
    const session = this.sessions.get(spaceId);
    if (!session || !session.transport.connected) return "unknown";
    if (session.identity.generation !== this.host.runs.generation(spaceId) ||
      session.identity.serviceEpoch !== this.host.currentServiceEpoch()) return "unknown";
    return session.attention;
  }
}
