import { ONBOARDING_NOTICE, type OnboardingScan } from "@shared/types";
import { Card, Overlay } from "./Overlay";

const ACTION_LABEL: Record<OnboardingScan["profiles"][number]["action"], string> = {
  "adopt-root": "Adopt as Home — zero writes to the official web profile",
  "convert-workbench": "Convert to workbench — backup patch, then dual-root isolation",
  "already-workbench": "Already a workbench — keep isolation patch",
  hide: "Hidden (no web-app GUI)",
};

export function Onboarding({
  scan,
  busy,
  error,
  onConfirm,
}: {
  scan: OnboardingScan;
  busy: boolean;
  error: string;
  onConfirm: () => void;
}) {
  const converting = scan.profiles.filter((p) => p.action === "convert-workbench");
  return (
    <Overlay>
      <Card className="w-[480px]">
        <p className="text-xs tracking-wide text-[#5865f2] uppercase">DSH Spaces</p>
        <h2 className="mt-1 text-xl font-semibold">First-run scan</h2>
        <p className="mt-2 text-sm text-white/60">
          Home: <code className="text-white/80">{scan.dshHome}</code>
        </p>
        <ul className="mt-4 max-h-48 space-y-2 overflow-y-auto text-sm">
          {scan.profiles.map((profile) => (
            <li key={profile.name} className="rounded bg-black/30 px-3 py-2">
              <div className="font-medium">{profile.name}</div>
              <div className="text-white/55">{ACTION_LABEL[profile.action]}</div>
            </li>
          ))}
        </ul>
        {converting.length > 0 ? (
          <p className="mt-4 rounded-lg bg-amber-500/15 px-3 py-2 text-sm leading-6 text-amber-100">
            {ONBOARDING_NOTICE}
          </p>
        ) : (
          <p className="mt-4 rounded-lg bg-white/5 px-3 py-2 text-sm leading-6 text-white/70">
            {ONBOARDING_NOTICE}
          </p>
        )}
        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="mt-4 w-full rounded-lg bg-[#5865f2] py-2 text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Converting…" : "Confirm and continue"}
        </button>
      </Card>
    </Overlay>
  );
}
