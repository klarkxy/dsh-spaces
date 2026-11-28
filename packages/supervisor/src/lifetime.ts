import type { SupervisorDiagnosticsReporter } from "../../../src/adapters/node/diagnostics/supervisor-diagnostics.ts";

export interface HostChannel {
  readonly connected: boolean;
  once(event: "disconnect", listener: () => void): unknown;
}

export interface SupervisorStopTarget {
  close(reason?: "host-exit" | "signal"): Promise<void>;
}

export interface LifetimeDeps {
  exit(code: number): void;
  diagnostics?: SupervisorDiagnosticsReporter;
  writeStderr?(text: string): void;
}

/** Fails fast: --exit-with-host without a live channel means the launcher did not keep its side. */
export function requireHostChannel(channel: HostChannel | undefined): HostChannel {
  if (!channel || channel.connected !== true) {
    throw new Error("The launching host channel is missing. The supervisor was not started.");
  }
  return channel;
}

export function bindSupervisorLifetime(input: {
  handle: Promise<SupervisorStopTarget>;
  hostChannel?: HostChannel;
  deps: LifetimeDeps;
}): { onSignal(signal: string): void } {
  const { handle, hostChannel, deps } = input;
  let stopping = false;
  const report = (write: (reporter: SupervisorDiagnosticsReporter) => void) => {
    if (!deps.diagnostics) return;
    try {
      write(deps.diagnostics);
    } catch {
      /* reporting must not recurse into another fatal exception */
    }
  };
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    void handle.then(async (target) => {
      if (signal === "host-exit") {
        try {
          await target.close("host-exit");
          report((reporter) => reporter.recordNormalStop({ exit: 0, signal: "host-exit" }));
          deps.exit(0);
        } catch (error) {
          report((reporter) => reporter.recordFailure(error, { signal: "host-exit" }));
        }
        return;
      }
      try {
        await target.close("signal");
        report((reporter) => reporter.recordNormalStop({ exit: 0, signal }));
        deps.exit(0);
      } catch (error) {
        report((reporter) => reporter.recordFailure(error, { exit: 1, signal }));
        deps.writeStderr?.(`${error instanceof Error ? error.message : "supervisor stop failed"}\n`);
        deps.exit(1);
      }
    }, () => {
      /* startup failure stays on the caller's existing failure path */
    });
  };
  hostChannel?.once("disconnect", () => stop("host-exit"));
  return { onSignal: (signal: string) => stop(signal) };
}
