/**
 * Job list and locale switch.
 *
 * Job rows stagger in; a failed job is never delayed, because its failure
 * reason has to be readable immediately.
 *
 * A job speaks the protocol's own words: kind, status and phase. The list
 * shows what the job does in plain language and keeps the raw values in a
 * collapsible "details" block.
 */

import React, { type ReactElement } from "react";
import type { JobStatus, WorkbenchJob } from "../../../../../src/shared/workbench";
import { StaggerItem, springSoft } from "../../../../../src/shared/ui/motion";
import { BlueprintJobResult } from "../blueprint/apply";
import { EmptyState } from "../empty-state";
import { ImportResultCard } from "../product-ui";
import { t, type WorkbenchLocale, type WorkbenchMessageKey } from "../i18n";

/** The known job kinds. An unknown kind keeps its raw value. */
const JOB_KIND_KEYS: Record<string, WorkbenchMessageKey> = {
  "space.create": "jobs.kind.space.create",
  "space.update": "jobs.kind.space.update",
  "space.reorder": "jobs.kind.space.reorder",
  "space.start": "jobs.kind.space.start",
  "space.stop": "jobs.kind.space.stop",
  "space.restart": "jobs.kind.space.restart",
  "space.delete": "jobs.kind.space.delete",
  "space.import": "jobs.kind.space.import",
  "space.runtime.set": "jobs.kind.space.runtime.set",
  "space.models.sync": "jobs.kind.space.models.sync",
  "plugin.install": "jobs.kind.plugin.install",
  "plugin.remove": "jobs.kind.plugin.remove",
  "plugin.toggle": "jobs.kind.plugin.toggle",
  "plugin.download": "jobs.kind.plugin.download",
  "plugin.library.remove": "jobs.kind.plugin.library.remove",
  "plugin.cleanup-manager": "jobs.kind.plugin.cleanup-manager",
  "snapshot.create": "jobs.kind.snapshot.create",
  "snapshot.delete": "jobs.kind.snapshot.delete",
  "runtime.remove": "jobs.kind.runtime.remove",
  "service.shutdown": "jobs.kind.service.shutdown",
  "settings.update": "jobs.kind.settings.update",
  "template.save": "jobs.kind.template.save",
  "template.delete": "jobs.kind.template.delete",
  "template.create": "jobs.kind.template.create",
  "catalog.refresh": "jobs.kind.catalog.refresh",
  "blueprint.apply": "jobs.kind.blueprint.apply",
  "plan.execute": "jobs.kind.plan.execute",
  "creator.create": "jobs.kind.creator.create",
  "control.execute": "jobs.kind.control.execute",
};

const JOB_STATUS_KEYS: Record<JobStatus, WorkbenchMessageKey> = {
  queued: "jobs.status.queued",
  running: "jobs.status.running",
  succeeded: "jobs.status.succeeded",
  failed: "jobs.status.failed",
  cancelled: "jobs.status.cancelled",
};

const JOB_PHASE_KEYS: Record<string, WorkbenchMessageKey> = {
  queued: "jobs.phase.queued",
  running: "jobs.phase.running",
  succeeded: "jobs.phase.succeeded",
  failed: "jobs.phase.failed",
  cancelled: "jobs.phase.cancelled",
  create: "jobs.phase.create",
  prepare: "jobs.phase.prepare",
  "view-bridge": "jobs.phase.viewBridge",
  "models-sync": "jobs.phase.modelsSync",
  start: "jobs.phase.start",
  stop: "jobs.phase.stop",
  restart: "jobs.phase.restart",
  install: "jobs.phase.install",
  download: "jobs.phase.download",
  remove: "jobs.phase.remove",
  update: "jobs.phase.update",
  toggle: "jobs.phase.toggle",
  enable: "jobs.phase.enable",
  disable: "jobs.phase.disable",
  cleanup: "jobs.phase.cleanup",
  delete: "jobs.phase.delete",
  reinitialize: "jobs.phase.reinitialize",
  reorder: "jobs.phase.reorder",
  runtime: "jobs.phase.runtime",
  pin: "jobs.phase.pin",
  "live-plugin": "jobs.phase.livePlugin",
  "stopping-children": "jobs.phase.stoppingChildren",
  finalizing: "jobs.phase.finalizing",
  "space-create": "jobs.phase.spaceCreate",
  packages: "jobs.phase.packages",
  presets: "jobs.phase.presets",
  plugins: "jobs.phase.plugins",
  result: "jobs.phase.result",
  verify: "jobs.phase.verify",
  snapshot: "jobs.phase.snapshot",
  shutdown: "jobs.phase.shutdown",
  done: "jobs.phase.done",
};

/** What the job does, in plain language. */
export function jobKindLabel(locale: WorkbenchLocale, kind: string): string {
  const key = JOB_KIND_KEYS[kind];
  return key ? t(locale, key) : kind;
}

/** How the job ended or where it is. */
export function jobStatusLabel(locale: WorkbenchLocale, status: JobStatus): string {
  return t(locale, JOB_STATUS_KEYS[status] ?? "jobs.status.running");
}

/** Which step of the job is running. */
export function jobPhaseLabel(locale: WorkbenchLocale, phase: string): string {
  const key = JOB_PHASE_KEYS[phase];
  return key ? t(locale, key) : phase;
}

function localizeApplicationNote(application: string): string {
  if (application === "live") return "已即时生效";
  if (application === "restart-required") return "需重启后完全生效";
  return application;
}

/**
 * Human-friendly progress wording for backend job messages.
 *
 * Raw backend values remain inside the collapsible job details block.
 */
export function jobMessageLabel(locale: WorkbenchLocale, message: string): string {
  if (!message || locale === "en" || /^DSH\s+/i.test(message)) return message;
  const exact: Record<string, string> = {
    "Stopping owned workspaces.": "正在停止托管空间",
    "Creating a whole-home snapshot.": "正在创建整 Home 备份",
    "Deleting the snapshot.": "正在删除备份",
    "Reinitializing the manager.": "正在重新初始化管理器",
    "Reading the main space model settings before writing.": "正在读取主空间模型配置",
  };
  if (exact[message]) return exact[message];
  let match: RegExpExecArray | null;
  if ((match = /^Writing (.+) inside the running space\.$/.exec(message))) {
    return `正在向运行中的空间写入 ${match[1]}`;
  }
  if ((match = /^Downloading (.+)\.$/.exec(message))) {
    return `正在下载 ${match[1]}`;
  }
  if ((match = /^Installing runtime (.+)\.$/.exec(message))) {
    return `正在安装 DSH ${match[1]}`;
  }
  if ((match = /^Removing runtime (.+)\.$/.exec(message))) {
    return `正在移除 DSH ${match[1]}`;
  }
  if ((match = /^Pinning (.+) to DSH (.+)\.$/.exec(message))) {
    return `正在将 ${match[1]} 固定到 DSH ${match[2]}`;
  }
  if ((match = /^Stopping (.+)\.$/.exec(message))) {
    return `正在停止 ${match[1]}`;
  }
  if ((match = /^Starting (.+)\.$/.exec(message))) {
    return `正在启动 ${match[1]}`;
  }
  if ((match = /^Installing (.+) (?:inside|in) (.+?)(?: through its own plugin manager)?\.$/.exec(message))) {
    return `正在为 ${match[2]} 安装 ${match[1]}`;
  }
  if ((match = /^Installing (.+)\.$/.exec(message))) {
    return `正在安装 ${match[1]}`;
  }
  if ((match = /^Installed (.+) in (.+) \(application=(.+)\)\.$/.exec(message))) {
    return `已在 ${match[2]} 安装 ${match[1]}（${localizeApplicationNote(match[3])}）`;
  }
  if ((match = /^Updating (.+) to (.+) (?:inside|in) (.+?)(?: through its own plugin manager)?\.$/.exec(message))) {
    return `正在将 ${match[3]} 中的 ${match[1]} 更新到 ${match[2]}`;
  }
  if ((match = /^Updated (.+) to (.+) in (.+) \(application=(.+)\)\.$/.exec(message))) {
    return `已将 ${match[3]} 中的 ${match[1]} 更新到 ${match[2]}（${localizeApplicationNote(match[4])}）`;
  }
  if ((match = /^Removing (.+) (?:inside|from) (.+?)(?: through its own plugin manager)?\.$/.exec(message))) {
    return `正在从 ${match[2]} 移除 ${match[1]}`;
  }
  if ((match = /^Removing (.+)\.$/.exec(message))) {
    return `正在移除 ${match[1]}`;
  }
  if ((match = /^Removed (.+) from (.+) \(application=(.+)\)\.$/.exec(message))) {
    return `已从 ${match[2]} 移除 ${match[1]}（${localizeApplicationNote(match[3])}）`;
  }
  if ((match = /^(Enabling|Disabling) (.+) inside (.+)\.$/.exec(message))) {
    return `正在为 ${match[3]} ${match[1] === "Enabling" ? "启用" : "停用"} ${match[2]}`;
  }
  if ((match = /^(Enabled|Disabled) (.+) in (.+) \(application=(.+)\)\.$/.exec(message))) {
    return `已在 ${match[3]} ${match[1] === "Enabled" ? "启用" : "停用"} ${match[2]}（${localizeApplicationNote(match[4])}）`;
  }
  return message;
}

export function JobsList({
  locale,
  jobs,
  onCancel,
}: {
  locale: WorkbenchLocale;
  jobs: WorkbenchJob[];
  onCancel: (id: string) => void;
}): ReactElement {
  return (
    <section className="dsh-wb-jobs" aria-label={t(locale, "jobs.progress")}>
      <h3 className="dsh-wb-title">{t(locale, "home.jobs")}</h3>
      {jobs.length === 0 ? <EmptyState testId="jobs" title={t(locale, "home.noJobs")} /> : null}
      {jobs.map((job, index) => (
        <StaggerItem
          key={job.id}
          appear={job.status !== "failed"}
          transition={{ ...springSoft, delay: index * 0.04 }}
        >
          <div
            className="dsh-wb-job"
            data-status={job.status}
            data-job-id={job.id}
            data-phase={job.phase}
          >
            <strong>{jobKindLabel(locale, job.kind)}</strong> · {jobStatusLabel(locale, job.status)}
            <div>
              {t(locale, "jobs.phase")}: {jobPhaseLabel(locale, job.phase)}
              {job.message ? ` — ${jobMessageLabel(locale, job.message)}` : ""}
            </div>
            <details className="dsh-wb-job-details" data-job-details="true">
              <summary>{t(locale, "jobs.details")}</summary>
              <dl className="dsh-wb-dl">
                <dt>kind</dt>
                <dd><code>{job.kind}</code></dd>
                <dt>status</dt>
                <dd><code>{job.status}</code></dd>
                <dt>phase</dt>
                <dd><code>{job.phase}</code></dd>
                {job.message ? (
                  <>
                    <dt>message</dt>
                    <dd><code>{job.message}</code></dd>
                  </>
                ) : null}
              </dl>
            </details>
            {job.status === "failed" && job.error && (
              <p className="dsh-wb-alert" role="alert">
                {t(locale, "jobs.failed")}: {job.message || job.error.message}
                {job.error.packageName
                  ? ` · ${job.error.packageName}`
                  : job.error.pluginAttribution === "unknown"
                    ? ` · ${t(locale, "app.status.unknown")}`
                    : ""}
              </p>
            )}
            {job.result?.product && (job.result.product.kind === "space.import" || job.result.product.kind === "template.create") ? (
              <ImportResultCard locale={locale} result={job.result.product.import} />
            ) : null}
            <BlueprintJobResult locale={locale} job={job} />
            {job.canCancel ? (
              <button type="button" className="dsh-wb-btn" onClick={() => onCancel(job.id)}>
                {t(locale, "jobs.cancel")}
              </button>
            ) : null}
          </div>
        </StaggerItem>
      ))}
    </section>
  );
}

export function LanguageSwitch({
  locale,
  onChange,
}: {
  locale: WorkbenchLocale;
  onChange: (locale: WorkbenchLocale) => void;
}): ReactElement {
  return (
    <div className="dsh-wb-lang" role="group" aria-label={t(locale, "app.language")}>
      <button type="button" aria-pressed={locale === "zh"} onClick={() => onChange("zh")}>
        中文
      </button>
      <button type="button" aria-pressed={locale === "en"} onClick={() => onChange("en")}>
        English
      </button>
    </div>
  );
}
