import { useState } from "react";
import type { ProfileRecord } from "@shared/types";
import { Card, Overlay } from "./Overlay";

export function DeleteDialog({
  profile,
  onCancel,
  onConfirm,
}: {
  profile: ProfileRecord;
  onCancel: () => void;
  onConfirm: (deleteOfficial: boolean) => void;
}) {
  const [deleteOfficial, setDeleteOfficial] = useState(false);
  return (
    <Overlay onBackdrop={onCancel}>
      <Card>
        <h2 className="text-lg font-semibold">Delete {profile.meta.displayName}?</h2>
        <p className="mt-2 text-sm text-white/65">This will:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-white/65">
          <li>Stop the running process if any</li>
          <li>Remove the rail entry from spaces.json</li>
          <li>
            Delete isolated data at <code>hub/{profile.name}/</code>
          </li>
        </ul>
        <label className="mt-4 flex items-start gap-2 text-sm text-white/70">
          <input
            type="checkbox"
            className="mt-1"
            checked={deleteOfficial}
            onChange={(event) => setDeleteOfficial(event.target.checked)}
          />
          <span>Also delete the official profile folder (plugins). Default is off.</span>
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded px-3 py-1.5 text-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-red-600 px-3 py-1.5 text-sm"
            onClick={() => onConfirm(deleteOfficial)}
          >
            Delete
          </button>
        </div>
      </Card>
    </Overlay>
  );
}
