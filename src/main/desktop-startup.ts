import type { DesktopServicePublicStatus } from "../shared/desktop-shell";

export interface DesktopStartupPort {
  connect(): Promise<void>;
  status(): DesktopServicePublicStatus;
  canStart(): boolean;
  start(): Promise<unknown>;
}

/**
 * One normal launch: attach first, then start only after a verified absence.
 * Environment preparation can finish before or after attach. Neither state
 * polling nor a later failure/intentional stop starts a second launch.
 */
export function createDesktopStartup(port: DesktopStartupPort): {
  open(): Promise<void>;
  environmentPrepared(): Promise<void>;
} {
  let opening: Promise<void> | null = null;
  let starting: Promise<void> | null = null;
  let decided = false;

  function startWhenReady(): Promise<void> {
    if (starting) return starting;
    if (decided) return Promise.resolve();
    const status = port.status();
    // The first attach still owns the decision. Installation must not bypass it.
    if (status === "idle" || status === "connecting") return Promise.resolve();
    if (status !== "stopped") {
      decided = true;
      return Promise.resolve();
    }
    if (!port.canStart()) return Promise.resolve();
    // Consume before invoking start, including when start throws or rejects.
    decided = true;
    const run = (async () => { await port.start(); })();
    starting = run;
    void run.finally(() => {
      if (starting === run) starting = null;
    }).catch(() => undefined);
    return run;
  }

  return {
    open() {
      if (!opening) {
        opening = (async () => {
          await port.connect();
          await startWhenReady();
        })();
      }
      return opening;
    },
    environmentPrepared: startWhenReady,
  };
}
