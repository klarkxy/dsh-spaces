import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lstatSync } from "../../../../src/shared/node/filesystem";
import { HomeLease, HOME_CONTROL_DIR_NAME } from "../../../../src/adapters/node/home/home-lease";
import type { WorkbenchApi, WorkbenchPlan } from "../../../../src/shared/workbench";
import type { WorkbenchBootstrapResult, WorkbenchServiceRestartPreview } from "../types";
import { attachExistingSupervisor, type SupervisorAttachResult } from "./supervisor-attach";
import { SUPERVISOR_ENDPOINT_FILE, type SupervisorEndpoint } from "../../../../src/adapters/node/home/supervisor-endpoint";
import { createWorkbenchHttpClient, type WorkbenchHttpClientOptions } from "./workbench-http";

type Missing = Extract<SupervisorAttachResult, { missing: true }>;
type Confirmation = { id: string; expires: number; discovery: { endpoint: SupervisorEndpoint } | Missing; plan?: WorkbenchPlan; stopOnly: boolean };
const active = new Set<string>();
const CHANGED = "The service or affected spaces changed. Review a new restart confirmation.";

export interface ServiceRestartOptions {
  home: string;
  allowRealHome: boolean;
  assertDesktop(): void;
  fetch?: WorkbenchHttpClientOptions["fetch"];
  connect?: (options: WorkbenchHttpClientOptions) => WorkbenchApi;
  /** Called only after the old shutdown is durably successful and ownership is released. */
  launch(previousEpoch: string | null, discovery: Missing): Promise<WorkbenchBootstrapResult>;
  timeoutMs?: number;
}

/** Explicit Desktop operation. It never replays shutdown, startup, or an interrupted job. */
export class DesktopServiceRestart {
  private confirmation?: Confirmation;
  private readonly key: string;
  constructor(private readonly options: ServiceRestartOptions) { this.key = resolve(options.home); }

  async preview(stopOnly = false): Promise<WorkbenchServiceRestartPreview> {
    this.options.assertDesktop();
    if (active.has(this.key)) throw Error("A manual service restart is already in progress.");
    this.confirmation = undefined;
    const discovery = await this.discover();
    if (!("endpoint" in discovery) && !("missing" in discovery)) throw Error(discovery.reasons.join("\n"));
    if (stopOnly && !("endpoint" in discovery)) throw Error("There is no running Spaces service to stop.");
    let plan: WorkbenchPlan | undefined;
    let spaces: WorkbenchServiceRestartPreview["spaces"] = [];
    if ("endpoint" in discovery) {
      const api = this.api(discovery.endpoint), state = await api.state();
      if (state.serviceEpoch !== discovery.endpoint.serviceEpoch || !state.writable || state.maintenance || state.availability === "unavailable") {
        throw Error("The service cannot accept a normal shutdown. Its failure and ownership were left unchanged.");
      }
      if (state.spaces.some(space => space.id === "desktop")) throw Error("A managed space cannot restart its owning service.");
      plan = await api.preview({ kind: "service.shutdown" }, { serviceEpoch: state.serviceEpoch, expectedRevision: state.revision });
      if (plan.kind !== "service.shutdown" || plan.serviceEpoch !== state.serviceEpoch || plan.stateRevision !== state.revision) throw Error(CHANGED);
      spaces = plan.affectedSpaceIds.map(id => ({ id, displayName: state.spaces.find(row => row.id === id)?.displayName ?? id,
        running: plan!.runningSpaceIds.includes(id) }));
    }
    const expires = Math.min(Date.now() + 5 * 60_000, plan ? Date.parse(plan.expiresAt) : Infinity);
    if (!Number.isFinite(expires) || expires <= Date.now()) throw Error("The restart confirmation expired.");
    const id = randomBytes(32).toString("hex");
    this.confirmation = { id, expires, discovery, plan, stopOnly };
    return { confirmationId: id, expiresAt: new Date(expires).toISOString(), action: stopOnly ? "stop" : plan ? "restart" : "start", spaces };
  }

  async execute(confirmationId: string, stopOnly = false): Promise<WorkbenchBootstrapResult> {
    this.options.assertDesktop();
    const confirmed = this.confirmation;
    if (!confirmed || confirmed.stopOnly !== stopOnly || confirmed.id !== confirmationId || confirmed.expires <= Date.now()) throw Error("The service confirmation is invalid or expired.");
    if (active.has(this.key)) throw Error("A manual service restart is already in progress.");
    // Consume before I/O. Duplicate clicks and a lost response cannot replay this operation.
    this.confirmation = undefined;
    active.add(this.key);
    try {
      const current = await this.discover();
      if (JSON.stringify(current) !== JSON.stringify(confirmed.discovery)) throw Error(CHANGED);
      let missing: Missing;
      let previousEpoch: string | null = null;
      if ("endpoint" in current) {
        const plan = confirmed.plan!;
        previousEpoch = current.endpoint.serviceEpoch;
        const requestId = "desktop-restart-" + randomUUID();
        const job = await this.api(current.endpoint).submit({ kind: "plan.execute", planId: plan.id }, requestId,
          { serviceEpoch: plan.serviceEpoch, expectedRevision: plan.stateRevision });
        await this.waitForShutdown(job.id, requestId, plan.id);
        const released = await this.discover();
        if (!("missing" in released) || released.previousOwner) throw Error(CHANGED);
        missing = released;
      } else {
        if (!("missing" in current)) throw Error(CHANGED);
        missing = current;
      }
      this.options.assertDesktop();
      if (stopOnly) return { ok: true, connected: false, unavailable: false, origin: null, reasons: [] };
      return await this.options.launch(previousEpoch, missing);
    } finally { active.delete(this.key); }
  }

  private discover() { return attachExistingSupervisor(this.options); }
  private api(endpoint: SupervisorEndpoint) {
    return (this.options.connect ?? createWorkbenchHttpClient)({ endpoint, fetch: this.options.fetch });
  }

  private async waitForShutdown(id: string, requestId: string, planId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw Error("The shutdown job identity is invalid.");
    const lease = new HomeLease(this.options.home, { allowRealHome: this.options.allowRealHome });
    const control = join(lease.home, HOME_CONTROL_DIR_NAME), jobs = join(control, "jobs"), file = join(jobs, id + ".json");
    const deadline = Date.now() + (this.options.timeoutMs ?? 240_000);
    while (Date.now() < deadline) {
      // Only observe the exact accepted job, never instantiate a job store (which recovers records).
      for (const directory of [control, jobs]) {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("The shutdown record directory is unsafe.");
      }
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw Error("The shutdown job record is unsafe.");
      const job = JSON.parse(readFileSync(file, "utf8"));
      if (job.schemaVersion !== 1 || job.id !== id || job.requestId !== requestId || job.command?.kind !== "plan.execute" || job.command?.planId !== planId) {
        throw Error("The shutdown job record does not match the confirmed operation.");
      }
      if (job.status === "failed" || job.status === "cancelled") throw Error("The confirmed shutdown failed. No new service was started.");
      if (!["queued", "running", "succeeded"].includes(job.status)) throw Error("The shutdown job result is unreadable.");
      if (job.status === "succeeded" && !lease.inspect().held && missingFile(join(control, SUPERVISOR_ENDPOINT_FILE))) return;
      await delay(100);
    }
    throw Error("Shutdown completion could not be confirmed before the deadline. No new service was started.");
  }
}

function missingFile(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}
