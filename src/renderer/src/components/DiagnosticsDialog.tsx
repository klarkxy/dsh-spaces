import { interpolate, type AppLocale } from "@shared/i18n";
import type { BackupPreview, ConfigBackupMeta, DiagnosticsSnapshot } from "@shared/diagnostics";
import { useI18n } from "../i18n";
import { Card, Overlay } from "./Overlay";

const copy = {
  en: {
    title: "Diagnostics — {name}",
    status: "Status",
    lastError: "Last error",
    noError: "No recent error.",
    logs: "Recent logs",
    noLogs: "No logs yet.",
    logError: "Diagnostics log error: {detail}",
    refresh: "Refresh",
    backups: "Configuration backups",
    noBackups: "No configuration backups yet.",
    preview: "Preview",
    tooLarge: "This backup is larger than 1 MiB.",
    backupsHint: "Configuration backups are listed for diagnosis. Restore is not supported.",
    previewTitle: "Backup preview",
    emptyPreview: "Select a backup to preview it.",
    stopped: "stopped",
    starting: "starting",
    running: "running",
    crashed: "crashed",
  },
  zh: {
    title: "诊断 — {name}",
    status: "状态",
    lastError: "最近错误",
    noError: "没有最近错误。",
    logs: "近期日志",
    noLogs: "暂无日志。",
    logError: "诊断日志错误：{detail}",
    refresh: "刷新",
    backups: "配置备份",
    noBackups: "还没有配置备份。",
    preview: "预览",
    tooLarge: "这份备份超过 1 MiB。",
    backupsHint: "配置备份仅供诊断查看，不支持恢复。",
    previewTitle: "备份预览",
    emptyPreview: "选择一份备份以预览。",
    stopped: "已停止",
    starting: "正在启动",
    running: "运行中",
    crashed: "已崩溃",
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

type CopyKey = keyof typeof copy.en;

export function DiagnosticsDialog({
  snapshot,
  backups,
  busy = false,
  error,
  preview = null,
  onRefresh,
  onPreview,
  onClose,
  onCopy,
}: {
  snapshot: DiagnosticsSnapshot;
  backups: ConfigBackupMeta[];
  busy?: boolean;
  error?: string | null;
  preview?: BackupPreview | null;
  onRefresh: () => void;
  onPreview: (backupId: string) => void;
  onClose: () => void;
  onCopy?: () => void;
}) {
  const { t, locale } = useI18n();
  const d = (key: CopyKey, params?: Record<string, string | number>) =>
    interpolate(copy[locale][key] ?? copy.en[key], params);

  const selectedId = preview?.id;
  const selected = backups.find((item) => item.id === selectedId) ?? preview;
  const tooLarge = Boolean(selected?.tooLarge || preview?.tooLarge);

  const statusLabel =
    snapshot.status === "stopped" ||
    snapshot.status === "starting" ||
    snapshot.status === "running" ||
    snapshot.status === "crashed"
      ? d(snapshot.status)
      : snapshot.status;

  return (
    <Overlay onBackdrop={onClose}>
      <Card wide>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">{d("title", { name: snapshot.name })}</h2>
          <button type="button" disabled={busy} className="btn-ghost rounded px-2 py-1 text-sm" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>

        {error ? (
          <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
        {busy ? (
          <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
            {t("common.working")}
          </p>
        ) : null}

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          <p className="text-xs" style={{ color: "var(--text-label)" }}>
            {d("status")}
          </p>
          <p className="mt-1 text-sm">{statusLabel}</p>

          <p className="mt-4 text-xs" style={{ color: "var(--text-label)" }}>
            {d("lastError")}
          </p>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            {snapshot.lastError || d("noError")}
          </p>

          <div className="mt-4 flex items-center justify-between gap-2">
            <p className="text-xs" style={{ color: "var(--text-label)" }}>
              {d("logs")}
            </p>
            {onCopy ? <button type="button" className="btn-ghost rounded px-2 py-1 text-xs" disabled={busy} onClick={onCopy}>{locale === "zh" ? "复制脱敏日志" : "Copy redacted logs"}</button> : null}
            <button
              type="button"
              className="btn-ghost rounded px-2 py-1 text-xs"
              disabled={busy}
              onClick={onRefresh}
            >
              {d("refresh")}
            </button>
          </div>
          {snapshot.logError ? (
            <p className="mt-1 text-sm" style={{ color: "var(--danger)" }}>
              {d("logError", { detail: snapshot.logError })}
            </p>
          ) : null}
          {snapshot.logs.length === 0 ? (
            <p className="mt-1 text-sm" style={{ color: "var(--text-faint)" }}>
              {d("noLogs")}
            </p>
          ) : (
            <pre
              className="mt-2 max-h-40 overflow-auto rounded p-2 font-mono text-xs"
              style={{ background: "var(--bg-input)", border: "1px solid var(--border)" }}
            >
              {snapshot.logs
                .map((entry) => `${entry.at} [${entry.channel}] ${entry.text}`)
                .join("\n")}
            </pre>
          )}

          <p className="mt-4 text-xs" style={{ color: "var(--text-label)" }}>
            {d("backups")}
          </p>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            {d("backupsHint")}
          </p>
          {backups.length === 0 ? (
            <p className="mt-1 text-sm" style={{ color: "var(--text-faint)" }}>
              {d("noBackups")}
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {backups.map((backup) => {
                const active = backup.id === selectedId;
                return (
                  <li key={backup.id}>
                    <button
                      type="button"
                      disabled={busy}
                      className="w-full rounded px-2 py-1.5 text-left text-sm"
                      style={{
                        background: active ? "var(--bg-hover)" : "transparent",
                        border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                      }}
                      onClick={() => onPreview(backup.id)}
                    >
                      <span className="block truncate">{backup.id}</span>
                      <span className="block text-xs" style={{ color: "var(--text-faint)" }}>
                        {backup.createdAt} · {backup.size} B
                        {backup.tooLarge ? ` · ${d("tooLarge")}` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {preview ? (
            <>
              <p className="mt-4 text-xs" style={{ color: "var(--text-label)" }}>
                {d("previewTitle")}
              </p>
              {tooLarge ? (
                <p className="mt-1 text-sm" style={{ color: "var(--warn)" }}>
                  {d("tooLarge")}
                </p>
              ) : preview.content != null ? (
                <pre
                  className="mt-2 max-h-40 overflow-auto rounded p-2 font-mono text-xs"
                  style={{ background: "var(--bg-input)", border: "1px solid var(--border)" }}
                >
                  {preview.content}
                </pre>
              ) : (
                <p className="mt-1 text-sm" style={{ color: "var(--text-faint)" }}>
                  {d("emptyPreview")}
                </p>
              )}
            </>
          ) : null}
        </div>
      </Card>
    </Overlay>
  );
}
