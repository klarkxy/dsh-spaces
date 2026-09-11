import { useEffect, useRef, useState } from "react";
import type { BackupPreview, DiagnosticsSnapshot } from "@shared/diagnostics";
import { DiagnosticsDialog } from "./DiagnosticsDialog";
import { Card, Overlay } from "./Overlay";
import { useI18n } from "../i18n";

export function DiagnosticsPanel({ name, onClose, onChanged }: {
  name: string; onClose: () => void; onChanged: () => Promise<unknown>;
}) {
  const { t, locale } = useI18n();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const perform = async (action: () => Promise<void>) => {
    const id = ++sequence.current;
    setBusy(true);
    setError("");
    try { await action(); }
    catch (err) { if (sequence.current === id) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (sequence.current === id) setBusy(false); }
  };
  const refresh = async () => {
    const id = sequence.current;
    const next = await window.dshSpaces.getDiagnostics(name);
    if (sequence.current === id) setSnapshot(next);
  };
  useEffect(() => {
    setSnapshot(null); setPreview(null);
    void perform(refresh);
    return () => { sequence.current++; };
  }, [name]);
  if (!snapshot) return <Overlay onBackdrop={busy ? undefined : onClose}><Card>
    <h2 className="text-lg font-semibold">{locale === "zh" ? "空间诊断" : "Space diagnostics"}</h2>
    <p className="my-4 whitespace-pre-wrap text-sm" role={error ? "alert" : "status"}>{error || t("common.working")}</p>
    <div className="flex gap-4">
      {error ? <button disabled={busy} onClick={() => void perform(refresh)}>{locale === "zh" ? "重试" : "Retry"}</button> : null}
      <button disabled={busy} onClick={onClose}>{t("common.close")}</button>
    </div>
  </Card></Overlay>;
  return <DiagnosticsDialog snapshot={snapshot} backups={snapshot.backups} busy={busy} error={error} preview={preview}
    onCopy={() => void perform(async () => {
      await navigator.clipboard.writeText(snapshot.logs.map(row => `${row.at} [${row.channel}] ${row.text}`).join("\n"));
    })}
    onClose={onClose} onRefresh={() => void perform(refresh)}
    onPreview={(id) => void perform(async () => {
      const request = sequence.current;
      const next = await window.dshSpaces.previewConfigBackup(name, id);
      if (sequence.current === request) setPreview(next);
    })}
    onRestore={(id) => void perform(async () => {
      await window.dshSpaces.restoreConfigBackup(name, id);
      setPreview(null); await refresh(); await onChanged();
    })}
  />;
}
