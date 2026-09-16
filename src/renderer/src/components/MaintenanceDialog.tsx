import { useEffect, useState } from "react";
import type { MaintenanceView } from "@shared/maintenance-view";
import { DSH_DEFAULT_CHANNEL, preferredTaggedVersion, type RuntimeCatalog } from "@shared/runtime";
import type { SnapshotMeta } from "@shared/snapshots";
import type { UpgradePreview, UpgradePhase } from "@shared/upgrade";
import { useI18n } from "../i18n";
import { isDataOnlySnapshot } from "../recovery";

export function MaintenancePanel({
  onChanged,
  onBusyChange,
}: {
  onChanged: () => Promise<unknown>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { locale, t } = useI18n();
  const say = (zh: string, en: string) => locale === "zh" ? zh : en;
  const [state, setState] = useState<MaintenanceView | null>(null);
  const [catalog, setCatalog] = useState<RuntimeCatalog | null>(null);
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<{ kind: "upgrade"; version: string; preview: UpgradePreview } | { kind: "delete"; snapshot: SnapshotMeta } | null>(null);
  const [phase, setPhase] = useState<UpgradePhase | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const refresh = async () => setState(await window.dshSpaces.getMaintenance());
  // `changed` marks real mutations (snapshot create/delete, upgrade apply);
  // read-only queries and previews must not reset parent state or the fault view.
  const run = async (label: string, action: () => Promise<unknown>, success = "", changed = false) => {
    setBusy(label); setError(""); setNotice(""); setPhase(null);
    try { await action(); await refresh(); if (changed) await onChanged(); setNotice(success); }
    catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refresh().catch(() => {});
    } finally { setBusy(""); }
  };
  useEffect(() => {
    void run(t("common.working"), async () => {
      await refresh();
      try {
        const next = await window.dshSpaces.getRuntimeCatalog();
        setCatalog(next);
        setVersion((current) => current || preferredTaggedVersion(next) || "");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }, []);
  useEffect(() => window.dshSpaces.onMaintenanceProgress(progress => setPhase(progress.phase)), []);
  const disabled = Boolean(busy || state?.operation);
  useEffect(() => {
    onBusyChange?.(disabled);
    return () => onBusyChange?.(false);
  }, [disabled, onBusyChange]);
  const phaseLabels: Record<UpgradePhase, string> = {
    drain: say("等待插件操作完成", "Waiting for plugin operations"), stop: say("停止空间", "Stopping spaces"),
    snapshot: say("备份当前状态", "Backing up current state"), install: say("准备运行版本", "Preparing runtime"),
    stage: say("准备官方插件", "Preparing official plugins"), verify: say("检查配置", "Checking configuration"),
    smoke: say("验证启动", "Checking startup"), commit: say("应用新版本", "Applying new version"),
    rollback: say("升级未提交", "Upgrade was not committed"), done: say("完成", "Done"),
  };
  const confirmSnapshot = (id: string) => void run(t("common.working"), async () => {
    const snapshot = await window.dshSpaces.previewSnapshot(id);
    setAcknowledged(false); setConfirmation({ kind: "delete", snapshot });
  });
  const button = "rounded border px-3 py-1.5 text-sm disabled:opacity-40";
  const preferred = catalog ? preferredTaggedVersion(catalog) : undefined;
  const currentVersion = state?.inventory.current?.version;
  const tagLine = catalog
    ? ["latest", "next", "alpha"].filter((tag) => catalog.distTags[tag]).map((tag) => `${tag} ${catalog.distTags[tag]}`).join(" · ")
    : "";
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-auto pr-1 text-sm">
      {busy || state?.operation ? <p role="status">{phase ? phaseLabels[phase] : busy || state?.operation}</p> : null}
      {error || state?.error ? <p role="alert" className="whitespace-pre-wrap text-red-500">{error || state?.error}</p> : null}
      {notice ? <p role="status" className="text-emerald-500">{notice}</p> : null}
      <section>
        <h3 className="font-semibold">{say("DSH 运行版本", "DSH runtime")}</h3>
        <p className="my-2">{say("所有空间共用：", "Shared by all spaces: ")}{state?.inventory.current?.version || say("尚未就绪", "Not ready")}
          {state?.inventory.current ? ` · ${{ store: say("版本库", "Version library"), managed: say("应用托管", "App managed"), system: say("系统安装", "System installation"), snapshot: say("恢复的快照", "Restored snapshot") }[state.inventory.current.origin]}` : ""}</p>
        <p className="mb-3" style={{ color: "var(--text-muted)" }}>{say("安装只保存版本。切换版本会停止所有空间，先备份，再协调更新官方插件并检查配置。", "Installing only saves a version. Applying it stops all spaces, takes a snapshot, updates official plugins, and checks configuration.")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button className={button} disabled={disabled} onClick={() => void run(say("正在查询版本…", "Fetching versions…"), async () => {
            const next = await window.dshSpaces.getRuntimeCatalog();
            setCatalog(next);
            setVersion((current) => current || preferredTaggedVersion(next) || "");
          }, say("已刷新可用版本。", "Available versions updated."))}>{say("查询可用版本", "Check available versions")}</button>
          <input aria-label={say("精确版本号", "Exact version")} className="field w-auto max-w-[12rem]" list="dsh-runtime-versions" value={version} onChange={event => setVersion(event.target.value)} placeholder={DSH_DEFAULT_CHANNEL} disabled={disabled} />
          <datalist id="dsh-runtime-versions">{catalog?.versions.map(row => <option key={row.version} value={row.version} />)}</datalist>
          <button className={button} disabled={disabled || !version} onClick={() => void run(say("正在安装版本…", "Installing version…"), () => window.dshSpaces.installRuntimeVersion(version), say("版本已安装，当前运行版本未变。", "Version installed. The active runtime is unchanged."))}>{say("安装", "Install")}</button>
        </div>
        {catalog ? (
          <>
            <p className="mt-2" style={{ color: "var(--text-muted)" }}>
              {tagLine || say("未返回 dist-tag。", "No dist-tags returned.")}
              {preferred && currentVersion && preferred !== currentVersion ? ` · ${say("可更新到", "Update available:")} ${preferred}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {catalog.versions.slice(0, 12).map((row) => {
                const channels = Object.entries(catalog.distTags).filter(([, tagged]) => tagged === row.version).map(([tag]) => tag);
                return (
                  <button type="button" className={button} disabled={disabled} key={row.version} onClick={() => setVersion(row.version)}>
                    {row.version}{channels.length ? ` (${channels.join(", ")})` : ""}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
        <ul className="mt-3 divide-y" style={{ borderColor: "var(--border)" }}>{state?.inventory.installed.map(row => <li className="flex items-center justify-between py-2" key={row.version}>
          <span>{row.version}</span>
          <button className={button} disabled={disabled || row.version === state.inventory.current?.version} onClick={() => void run(t("common.working"), async () => {
            const preview = await window.dshSpaces.previewUpgrade(row.version);
            setAcknowledged(false); setConfirmation({ kind: "upgrade", version: row.version, preview });
          })}>{say("应用到所有空间", "Apply to all spaces")}</button>
        </li>)}</ul>
      </section>
      <section>
        <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{say("完整快照", "Full snapshots")}</h3>
          <button className={button} disabled={disabled || !state?.inventory.current} onClick={() => void run(say("正在停止空间并创建快照…", "Stopping spaces and creating snapshot…"), () => window.dshSpaces.createSnapshot(), say("快照已创建，空间保持停止。", "Snapshot created. Spaces remain stopped."), true)}>{say("停止空间并创建快照", "Stop spaces and create snapshot")}</button>
        </div>
        <p className="my-2" style={{ color: "var(--text-muted)" }}>{say("包含配置、插件、聊天、存储和运行时。保留当前登录信息与外部源文件。快照不能用于恢复。", "Includes configuration, plugins, chats, storage and runtime. Current sign-in information and external source files are preserved. Snapshots cannot be restored.")}</p>
        {!state?.snapshots.length ? <p>{say("暂无快照。", "No snapshots yet.")}</p> : null}
        {state?.snapshots.map(row => {
          const dataOnly = isDataOnlySnapshot(row);
          return <div key={row.id} className="flex items-center justify-between gap-3 border-b py-3" style={{ borderColor: "var(--border)" }}>
          <div><p>{new Date(row.createdAt).toLocaleString()} · DSH {row.runtimeVersion}{dataOnly ? ` · ${say("仅数据备份（运行时缺失）", "Data-only backup (runtime missing)")}` : ""}</p><p style={{ color: "var(--text-muted)" }}>{row.profiles.join(", ")} · {(row.size / 1048576).toFixed(1)} MB{dataOnly ? ` · ${say("只保留数据，不能直接恢复运行环境。", "Keeps data only; not a restorable runtime environment.")}` : ""}</p></div>
          <div className="flex shrink-0 gap-2"><button className={button} disabled={disabled} onClick={() => confirmSnapshot(row.id)}>{say("删除", "Delete")}</button></div>
        </div>;
        })}
      </section>
      {confirmation ? <section className="rounded border p-4" style={{ borderColor: "var(--accent)" }}>
        <h3 className="font-semibold">{confirmation.kind === "upgrade" ? say(`切换到 ${confirmation.version}`, `Apply ${confirmation.version}`) : say("删除此快照", "Delete this snapshot")}</h3>
        <p className="my-2 break-words">{confirmation.kind === "upgrade" ? say("受影响空间：", "Affected spaces: ") + (state?.profiles.join(", ") || "—") : `${new Date(confirmation.snapshot.createdAt).toLocaleString()} · DSH ${confirmation.snapshot.runtimeVersion} · ${confirmation.snapshot.profiles.join(", ")}`}</p>
        {confirmation.kind === "upgrade" ? <table className="my-3 w-full text-left text-xs"><thead><tr><th>{say("空间", "Space")}</th><th>{say("官方插件版本", "Official plugin versions")}</th><th>{say("保留的第三方插件", "Third-party plugins preserved")}</th></tr></thead><tbody>{confirmation.preview.profiles.map(row => <tr key={row.name}><td className="py-2">{row.name}</td><td>{row.official.map(plugin => `${plugin.name}: ${plugin.from || "—"} → ${plugin.to || "—"}`).join("; ")}</td><td>{row.thirdParty.join(", ") || "—"}</td></tr>)}</tbody></table> : null}
        <label className="my-3 flex items-start gap-2"><input type="checkbox" checked={acknowledged} disabled={disabled} onChange={event => setAcknowledged(event.target.checked)} />
          <span>{confirmation.kind === "delete" ? say("确认永久删除这份快照。正在使用的快照无法删除。", "Permanently delete this snapshot. An active snapshot cannot be deleted.") : say("确认停止所有空间，备份后协调更新官方插件。成功后空间保持停止；失败时保留失败现场。", "Stop all spaces, take a snapshot, then update official plugins together. Spaces remain stopped on success; failure keeps the failed state.")}</span>
        </label>
        <div className="flex gap-3"><button className={button} disabled={disabled || !acknowledged} onClick={() => {
          const action = confirmation;
          setConfirmation(null);
          void run(say("正在执行，请保持应用开启…", "Working. Keep the app open…"), () => action.kind === "upgrade" ? window.dshSpaces.upgradeRuntime(action.version) : window.dshSpaces.deleteSnapshot(action.snapshot.id), say("操作完成。", "Operation complete."), true);
        }}>{say("确认执行", "Confirm")}</button><button className={button} disabled={disabled} onClick={() => setConfirmation(null)}>{say("取消", "Cancel")}</button></div>
      </section> : null}
    </div>
  );
}
