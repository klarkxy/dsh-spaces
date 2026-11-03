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
  "template.create": "jobs.kind.template.create",
  "catalog.refresh": "jobs.kind.catalog.refresh",
  "blueprint.apply": "jobs.kind.blueprint.apply",
  "plan.execute": "jobs.kind.plan.execute",
  "llm.apply": "jobs.kind.llm.apply",
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
  prepare: "jobs.phase.prepare",
  start: "jobs.phase.start",
  stop: "jobs.phase.stop",
  install: "jobs.phase.install",
  remove: "jobs.phase.remove",
  update: "jobs.phase.update",
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
    <section aria-label={t(locale, "jobs.progress")}>
      <h2 className="dsh-wb-title">{t(locale, "home.jobs")}</h2>
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
              {t(locale, "jobs.phase")}: {jobPhaseLabel(locale, job.phase)} — {job.message}
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
