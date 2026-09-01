import type { CliEnsureStatus, PackageSource } from "@shared/types";
import { Card, Overlay } from "./Overlay";

const STEP_LABEL: Record<NonNullable<CliEnsureStatus["step"]>, string> = {
  node: "Node.js",
  pnpm: "pnpm",
  cli: "DSH CLI",
};

export function CliSetup({
  status,
  packageSource,
  onPackageSource,
  onInstall,
}: {
  status: CliEnsureStatus;
  packageSource: PackageSource;
  onPackageSource: (source: PackageSource) => void;
  onInstall: (source: PackageSource) => void;
}) {
  const failed = status.state === "error";
  const busy = status.state === "installing" || status.state === "checking";
  const waiting = status.state === "idle" || failed;
  return (
    <Overlay>
      <Card className="w-[480px]">
        <p className="text-xs tracking-wide text-[#5865f2] uppercase">DSH Spaces</p>
        <h2 className="mt-1 text-xl font-semibold">
          {failed ? "Couldn't install the runtime" : busy ? "Installing runtime" : "Set up the runtime"}
        </h2>
        <p className="mt-2 text-sm text-white/60">
          Full DSH needs Node, pnpm, and the DSH CLI. They are installed into app data, not your system.
        </p>
        <label className="mt-4 block text-xs text-white/50">Package source</label>
        <select
          className="mt-1 w-full rounded bg-black/40 px-3 py-2 text-sm disabled:opacity-60"
          value={packageSource}
          disabled={busy}
          onChange={(event) => onPackageSource(event.target.value as PackageSource)}
        >
          <option value="china">China — npmmirror.com</option>
          <option value="official">Official — npmjs.org / nodejs.org</option>
        </select>
        <p className="mt-1 text-xs text-white/40">
          {packageSource === "china"
            ? "Node dist and npm registry use npmmirror. Switch later in Settings."
            : "Downloads from nodejs.org and the public npm registry."}
        </p>
        {status.step ? (
          <p className="mt-3 text-xs uppercase tracking-wide text-[#5865f2]">Step: {STEP_LABEL[status.step]}</p>
        ) : null}
        <p
          className={`mt-3 rounded-lg px-3 py-2 text-sm leading-6 ${failed ? "bg-red-500/10 text-red-300" : "bg-white/5 text-white/70"}`}
        >
          {status.message || (failed ? "Install failed." : "Ready when you are.")}
        </p>
        {waiting ? (
          <button
            type="button"
            onClick={() => onInstall(packageSource)}
            className="mt-4 w-full rounded-lg bg-[#5865f2] py-2 text-sm font-medium"
          >
            {failed ? "Retry" : "Install runtime"}
          </button>
        ) : null}
      </Card>
    </Overlay>
  );
}
