import React, { useEffect, useRef, useState } from "react";
import type { WorkbenchServiceRestartPreview } from "../../types";
import { publicGuideDetail } from "../guide-detail";
import { inferSpacesLocale } from "../i18n";
import type { NativeHostController } from "./native-controller";
import { nativeTexts } from "./native-texts";
import { PressButton } from "./press-button";
import { NativeDialog } from "./native-dialog";

/** The Desktop owns the confirmation and survives the manager's normal shutdown. */
export function useServiceRestart(controller: NativeHostController, onRestarted: (next: NativeHostController) => void, stopRequest = 0) {
  const [preview, setPreview] = useState<WorkbenchServiceRestartPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "start" | "restart" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false), inFlight = useRef(false), lastRequest = useRef(0);
  const locale = inferSpacesLocale();
  const texts = nativeTexts(locale);
  useEffect(() => {
    mounted.current = true;
    setPreview(null); setBusy(null); setError(null); lastRequest.current = 0;
    return () => { mounted.current = false; };
  }, [controller]);
  const failure = (cause: unknown) => {
    if (mounted.current) setError(publicGuideDetail(cause instanceof Error ? cause.message : String(cause)) || texts.serviceActionFailed);
  };
  const prepare = async (stop = false) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy("preview"); setError(null); setPreview(null);
    try { const value = await (stop ? controller.previewServiceStop() : controller.previewServiceRestart()); if (mounted.current) setPreview(value); }
    catch (cause) { failure(cause); }
    finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  };
  useEffect(() => {
    if (stopRequest > lastRequest.current) { lastRequest.current = stopRequest; void prepare(true); }
  }, [stopRequest, controller]);
  const confirm = async () => {
    if (!preview || inFlight.current) return;
    inFlight.current = true; setBusy(preview.action); setError(null);
    const { confirmationId, action } = preview;
    setPreview(null);
    try {
      if (action === "stop") await controller.stopService(confirmationId);
      else { const next = await controller.restartService(confirmationId); if (mounted.current) onRestarted(next); }
    } catch (cause) { failure(cause); }
    finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  };
  const action = controller.supportsServiceRestart
    ? <PressButton type="button" className="dsh-host-action" disabled={!!busy} onClick={() => void prepare()}>{texts.serviceManual}</PressButton> : null;
  const expiresAt = preview ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(preview.expiresAt)) : "";
  const dialog = (preview || busy || error) ? <NativeDialog label={texts.serviceOperation} onCancel={busy ? undefined : () => { setPreview(null); setError(null); }}>
      {busy && <p role="status">{busy === "preview" ? texts.servicePreviewReading : busy === "stop" ? texts.serviceStopping : busy === "start" ? texts.serviceStarting : texts.serviceRestarting}</p>}
      {error && <><p role="alert">{error}</p><PressButton type="button" className="dsh-host-action" onClick={() => setError(null)}>{texts.closeNotice}</PressButton></>}
      {preview && <>
        <h3>{preview.action === "stop" ? texts.serviceStopTitle : preview.action === "restart" ? texts.serviceRestartTitle : texts.serviceStartTitle}</h3>
        <p>{preview.action === "stop" ? texts.serviceStopBody : preview.action === "restart" ? texts.serviceRestartBody : texts.serviceStartBody}</p>
        <p>{texts.serviceMainSpaceNote}</p>
        {preview.spaces.length > 0 && <ul>{preview.spaces.map(space => <li key={space.id}>{space.displayName}{space.running ? ` · ${texts.serviceSpaceRunning}` : ` · ${texts.serviceSpaceManaged}`}</li>)}</ul>}
        <details><summary>{texts.serviceConfirmDetails}</summary><p>{texts.serviceConfirmValid.replace("{time}", expiresAt)}</p></details>
        <div className="dsh-native-confirm-actions">
          <PressButton type="button" className="dsh-host-action" disabled={!!busy} onClick={() => setPreview(null)}>{texts.cancel}</PressButton>
          <PressButton type="button" className={`dsh-host-action${preview.action === "start" ? "" : " danger"}`} disabled={!!busy} onClick={() => void confirm()}>{preview.action === "stop" ? texts.serviceStopConfirm : preview.action === "restart" ? texts.serviceRestartConfirm : texts.serviceStartConfirm}</PressButton>
        </div>
      </>}
  </NativeDialog> : null;
  return { action, dialog };
}
