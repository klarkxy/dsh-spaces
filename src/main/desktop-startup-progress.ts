import type { DesktopStartupStage } from "../shared/desktop-shell";

const STAGE_SEQUENCE: readonly DesktopStartupStage[] = [
  "attach",
  "prepare",
  "launch",
  "connect",
  "load-workbench",
  "ready",
];

export interface StartupProgressOptions {
  now?: () => number;
  /** Called after the visible stage changed (advance or reset). */
  onAdvance?: (stage: DesktopStartupStage | null) => void;
  /** Completion log sink; only a successful ready run emits a line. */
  onLog?: (line: string) => void;
}

export interface StartupProgress {
  /** New open() flow: clear the stage and always start a fresh clock. */
  beginConnect(): void;
  /** New start flow: clear the stage; keep the clock when it belongs to the
      open() flow this start continues, otherwise start a fresh one. */
  beginStart(): void;
  /** Advance to a stage. Stages only move forward within one flow. */
  stage(stage: DesktopStartupStage): void;
  /** The workbench was presented: advance to ready and log the total time. */
  succeed(): void;
  /** The flow ended without a ready workbench: drop the clock, log nothing. */
  fail(): void;
  /** Service stopped or recreated: clear stage and clock without emitting. */
  reset(): void;
  current(): DesktopStartupStage | null;
}

/**
 * Desktop startup stage state machine. The stage is forward-only within one
 * flow (a late "connect" cannot overwrite "ready"); a new open/start flow
 * resets it. The elapsed clock runs from the first connect of a flow until
 * ready, covering a later cold-start continuation of the same open().
 */
export function createStartupProgress(options: StartupProgressOptions = {}): StartupProgress {
  const now = options.now ?? (() => Date.now());
  let currentStage: DesktopStartupStage | null = null;
  let clock: { startedAt: number; coldStart: boolean } | null = null;

  function begin(freshClock: boolean): void {
    currentStage = null;
    if (freshClock || !clock) clock = { startedAt: now(), coldStart: false };
  }

  return {
    beginConnect: () => begin(true),
    beginStart: () => begin(false),
    stage: (stage) => {
      if ((stage === "prepare" || stage === "launch") && clock) clock.coldStart = true;
      if (currentStage && STAGE_SEQUENCE.indexOf(stage) <= STAGE_SEQUENCE.indexOf(currentStage)) {
        return;
      }
      currentStage = stage;
      options.onAdvance?.(currentStage);
    },
    succeed: () => {
      const timing = clock;
      clock = null;
      if (currentStage !== "ready") {
        currentStage = "ready";
        options.onAdvance?.(currentStage);
      }
      if (timing) {
        const elapsed = Math.max(0, now() - timing.startedAt);
        const mode = timing.coldStart ? "cold start" : "attached to existing service";
        options.onLog?.(`Startup completed in ${elapsed} ms (${mode}).`);
      }
    },
    fail: () => {
      clock = null;
    },
    reset: () => {
      currentStage = null;
      clock = null;
    },
    current: () => currentStage,
  };
}
