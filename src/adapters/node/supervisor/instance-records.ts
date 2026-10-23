import { lstatSync } from "../../../shared/node/filesystem";
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../atomic";
import type { PidAliveFn } from "../home/home-lease";
import { parseSpaceName } from "./input";
import type { SupervisorLifecycle } from "./lifecycle";
import type { SpaceRunRegistry } from "./space-runs";
import type { StoredPlan } from "./types";

const INSTANCES_DIR_NAME = "instances";
const LIFECYCLE_PLANS_DIR_NAME = "lifecycle-plans";

export interface SupervisorInstanceRecordsHost {
  controlDir: string;
  runs: SpaceRunRegistry;
  lifecycle: SupervisorLifecycle;
  pidAlive: PidAliveFn;
  plans: Map<string, StoredPlan>;
}

export class SupervisorInstanceRecords {
  constructor(private readonly host: SupervisorInstanceRecordsHost) {}

  instancesDir(): string {
    return join(this.host.controlDir, INSTANCES_DIR_NAME);
  }

  instancePath(id: string): string {
    return join(this.instancesDir(), `${id}.json`);
  }

  writeInstanceRecord(id: string, port: number, generation: number): void {
    const spawned = this.host.runs.spawned.get(id);
    if (!spawned) return;
    mkdirSync(this.instancesDir(), { recursive: true });
    atomicWrite(
      this.instancePath(id),
      `${JSON.stringify({
        version: 1,
        spaceId: id,
        pid: spawned.pid,
        startedAt: spawned.startedAt,
        port,
        generation,
        origin: `http://127.0.0.1:${port}`,
      })}\n`,
    );
  }

  removeInstanceRecord(id: string): void {
    try {
      unlinkSync(this.instancePath(id));
    } catch {
      /* gone */
    }
  }

  reconcileInstanceRecords(): void {
    let names: string[] = [];
    try {
      const stat = lstatSync(this.instancesDir());
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("ambiguous instance directory");
      names = readdirSync(this.instancesDir()).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.host.runs.unmanaged.add("unknown-records");
      return;
    }
    for (const name of names) {
      const path = join(this.instancesDir(), name);
      const id = name.replace(/\.json$/, "");
      let record: { version?: number; kind?: string; spaceId?: string; pid?: number; startedAt?: string; port?: number; generation?: number; origin?: string };
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ambiguous record");
        record = JSON.parse(readFileSync(path, "utf8"));
        parseSpaceName(id);
      } catch {
        this.host.runs.unmanaged.add("unknown-records");
        continue;
      }
      const maintenanceChild = record?.kind === "maintenance" && /^maintenance-[a-f0-9]{12}$/.test(id);
      if (record?.version !== 1 || record.spaceId !== id || !Number.isInteger(record.pid) || record.pid! <= 0 ||
        typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt)) ||
        (!maintenanceChild && (!Number.isInteger(record.port) || record.port! < 1 || record.port! > 65535 ||
        !Number.isInteger(record.generation) || record.generation! < 0 ||
        record.origin !== `http://127.0.0.1:${record.port}`))) {
        this.host.runs.unmanaged.add(id);
        continue;
      }
      const liveness = this.host.pidAlive(record.pid!, record.startedAt);
      if (liveness === "dead") {
        this.removeInstanceRecord(id);
        continue;
      }
      this.host.runs.unmanaged.add(id);
      this.host.lifecycle.reasons.push(`Leftover process for ${id} was not adopted.`);
    }
  }

  writeLifecyclePlan(stored: StoredPlan): void {
    const dir = join(this.host.controlDir, LIFECYCLE_PLANS_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    atomicWrite(join(dir, `${stored.plan.id}.json`), `${JSON.stringify(stored)}\n`);
  }

  readLifecyclePlan(id: string): StoredPlan | undefined {
    const memory = this.host.plans.get(id);
    if (memory) return memory;
    try {
      const parsed = JSON.parse(readFileSync(join(this.host.controlDir, LIFECYCLE_PLANS_DIR_NAME, `${id}.json`), "utf8")) as StoredPlan;
      if (!parsed?.plan?.id || !parsed.request || !parsed.fingerprint) return undefined;
      if (!parsed.plan.serviceEpoch || !parsed.plan.stateRevision) return undefined;
      this.host.plans.set(id, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  consumeLifecyclePlan(id: string): void {
    const stored = this.host.plans.get(id);
    if (stored) stored.consumed = true;
    this.host.plans.delete(id);
    try {
      unlinkSync(join(this.host.controlDir, LIFECYCLE_PLANS_DIR_NAME, `${id}.json`));
    } catch {
      /* gone */
    }
  }
}
