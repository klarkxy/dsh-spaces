import React, { useEffect, useRef, useState } from "react";
import type { WorkbenchServiceRestartPreview } from "../../types";
import { publicGuideDetail } from "../guide-detail";
import type { NativeHostController } from "./native-controller";
import { PressButton } from "./press-button";

/** Kept in the shell lifetime: returning to main does not abandon an accepted operation. */
export function useServiceRestart(controller: NativeHostController, onRestarted: (next: NativeHostController) => void) {
  const [preview, setPreview] = useState<WorkbenchServiceRestartPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false), inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    setPreview(null); setBusy(null); setError(null);
    return () => { mounted.current = false; };
  }, [controller]);
  const failure = (cause: unknown) => {
    if (mounted.current) setError(publicGuideDetail(cause instanceof Error ? cause.message : String(cause)) || "手动操作失败，未自动重试。");
  };
  const prepare = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy("preview"); setError(null); setPreview(null);
    try { const value = await controller.previewServiceRestart(); if (mounted.current) setPreview(value); }
    catch (cause) { failure(cause); }
    finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  };
  const confirm = async () => {
    if (!preview || inFlight.current) return;
    inFlight.current = true; setBusy("restart"); setError(null);
    const id = preview.confirmationId;
    setPreview(null);
    try { const next = await controller.restartService(id); if (mounted.current) onRestarted(next); }
    catch (cause) { failure(cause); }
    finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  };
  if (!controller.supportsServiceRestart) return null;
  return <section aria-label="手动启动或重启 Spaces 服务">
    {busy && <p role="status">{busy === "preview" ? "正在读取服务和受影响空间…" : "正在正常停止旧服务并启动一次新服务…"}</p>}
    {error && <p role="alert" className="dsh-host-detail">{error}</p>}
    {preview ? <section aria-label="确认服务操作">
      <h3>{preview.action === "restart" ? "确认重启 Spaces 服务" : "确认启动 Spaces 服务"}</h3>
      <p>{preview.action === "restart" ? "将停止当前 Spaces 服务及以下空间，再启动管理服务。正在执行的子空间任务会中断；子空间保持停止，不自动继续任务。" : "当前没有存活的 Spaces 服务。将使用当前插件启动一次管理服务，不继续上次中断的任务。"}</p>
      <p>当前 Desktop 和 main 会话保持打开。</p>
      {preview.spaces.length > 0 && <ul>{preview.spaces.map(space => <li key={space.id}>{space.displayName}（{space.id}）{space.running ? " · 运行中，将停止" : " · 由此服务管理"}</li>)}</ul>}
      <PressButton type="button" className="dsh-host-action" disabled={!!busy} onClick={() => void confirm()}>{preview.action === "restart" ? "确认停止并重启服务" : "确认启动服务"}</PressButton>
      <PressButton type="button" className="dsh-host-action" disabled={!!busy} onClick={() => setPreview(null)}>取消</PressButton>
    </section> : <PressButton type="button" className="dsh-host-action" disabled={!!busy} onClick={() => void prepare()}>手动启动 / 重启 Spaces 服务…</PressButton>}
  </section>;
}
