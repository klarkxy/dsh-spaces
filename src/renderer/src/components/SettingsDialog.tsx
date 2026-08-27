import { useState } from "react";
import type { HubSettings } from "@shared/types";
import { Card, Overlay } from "./Overlay";

export function SettingsDialog({
  initial,
  dshHome,
  pluginPending,
  pluginCurrent,
  onCancel,
  onSave,
}: {
  initial: HubSettings;
  dshHome: string;
  pluginPending: number;
  pluginCurrent?: string;
  onCancel: () => void;
  onSave: (settings: HubSettings) => void;
}) {
  const [portStart, setPortStart] = useState(String(initial.portStart));
  const [portEnd, setPortEnd] = useState(String(initial.portEnd));
  const [quitBehavior, setQuitBehavior] = useState(initial.quitBehavior);

  return (
    <Overlay onBackdrop={onCancel}>
      <Card>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="mt-3 text-xs text-white/50">DSH_HOME</p>
        <p className="mt-1 break-all rounded bg-black/40 px-3 py-2 text-sm">{dshHome}</p>
        <p className="mt-1 text-xs text-white/40">
          Unpackaged builds always use the repo sandbox. Packaged builds default to ~/.dsh.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-xs text-white/50">
            Port start
            <input
              className="mt-1 w-full rounded bg-black/40 px-3 py-2 text-sm"
              value={portStart}
              onChange={(event) => setPortStart(event.target.value)}
            />
          </label>
          <label className="text-xs text-white/50">
            Port end
            <input
              className="mt-1 w-full rounded bg-black/40 px-3 py-2 text-sm"
              value={portEnd}
              onChange={(event) => setPortEnd(event.target.value)}
            />
          </label>
        </div>
        <label className="mt-4 block text-xs text-white/50">On quit</label>
        <select
          className="mt-1 w-full rounded bg-black/40 px-3 py-2 text-sm"
          value={quitBehavior}
          onChange={(event) => setQuitBehavior(event.target.value as HubSettings["quitBehavior"])}
        >
          <option value="stop">Stop all profile processes</option>
          <option value="keep">Leave processes running</option>
        </select>
        {pluginPending > 0 ? (
          <p className="mt-3 text-sm text-amber-200">
            Plugin queue: {pluginPending} pending{pluginCurrent ? ` (${pluginCurrent})` : ""}
          </p>
        ) : (
          <p className="mt-3 text-sm text-white/45">Plugin queue is idle.</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded px-3 py-1.5 text-sm text-white/70" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-[#5865f2] px-3 py-1.5 text-sm"
            onClick={() =>
              onSave({
                portStart: Number(portStart),
                portEnd: Number(portEnd),
                quitBehavior,
              })
            }
          >
            Save
          </button>
        </div>
      </Card>
    </Overlay>
  );
}
