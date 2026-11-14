import { matchesPluginQuery } from "../../../../shared/plugin";
import { isExactRuntimeVersion } from "../../../../shared/runtime";
import type {
  WorkbenchBackup,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchSnapshot,
} from "../../../../shared/workbench";
import { readPluginLibrary } from "../../products/plugin-library";
import type { WorkbenchJobContext, WorkbenchJobResult } from "../workbench-jobs";
import { MaintenanceExecution } from "./execution";
import { HANDOFF_KINDS } from "./constants";
import { WorkbenchMaintenanceError } from "./errors";
import { publicBackup, publicPlugin, publicSnapshot } from "./projections";
import { isGuardedPackage, isNpmPackageId, parsePlanRequest } from "./validation";
import { unique } from "./util";

/**
 * Maintenance application service. Supervisor runtime supplies ports; this
 * module does not create a ProcessManager, HomeLease, or job engine.
 */
export class WorkbenchMaintenance extends MaintenanceExecution {
  async preview(request: WorkbenchPlanRequest): Promise<WorkbenchPlan> {
    this.assertWritable();
    try {
      return await this.ports.lock.run("workbench.preview", async () => {
        const parsed = parsePlanRequest(request);
        if (HANDOFF_KINDS.has(parsed.kind)) {
          throw new WorkbenchMaintenanceError("workbench/runtime-handoff");
        }
        const built = await this.buildPlan(parsed);
        this.writePlan(built);
        return {
          ...built.public,
          affectedSpaceIds: [...built.public.affectedSpaceIds],
          runningSpaceIds: [...built.public.runningSpaceIds],
          changes: [...built.public.changes],
        };
      });
    } catch (error) {
      throw this.fail(error, "preview");
    }
  }

  async execute(planId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJobResult | void> {
    this.assertWritable();
    try {
      return await this.ports.lock.run("workbench.execute", () => this.executeLocked(planId, ctx));
    } catch (error) {
      throw this.fail(error, "execute");
    }
  }

  admitPlan(planId: string): { scope: WorkbenchPlan["scope"]; affectedSpaceIds: string[] } {
    this.assertWritable();
    try {
      const stored = this.readPlan(planId);
      if (stored.status !== "previewed") throw new WorkbenchMaintenanceError("workbench/conflict");
      this.assertPlanIdentity(stored);
      this.assertFresh(stored);
      this.admittedPlans.add(planId);
      const affectedSpaceIds = stored.public.scope === "space"
        ? [...stored.public.affectedSpaceIds]
        : [];
      return { scope: stored.public.scope, affectedSpaceIds };
    } catch (error) {
      throw this.fail(error, "admitPlan");
    }
  }

  async plugins(query: string): Promise<WorkbenchPlugin[]> {
    if (typeof query !== "string" || query.length > 80) {
      throw new WorkbenchMaintenanceError("workbench/invalid-input");
    }
    const catalog = this.catalogEntries();
    const library = readPluginLibrary(this.ports.home);
    const installed = this.installedBySpace();
    const rows = new Map<string, WorkbenchPlugin>();

    const put = (row: WorkbenchPlugin) => {
      const key = row.packageName.toLowerCase();
      const existing = rows.get(key);
      if (!existing) {
        rows.set(key, row);
        return;
      }
      const installedIn = unique([...existing.installedIn, ...row.installedIn]);
      rows.set(key, {
        ...existing,
        title: existing.title || row.title,
        description: existing.description || row.description,
        version: existing.version ?? row.version,
        installedIn,
        protected: existing.protected || row.protected,
      });
    };

    for (const entry of catalog) {
      put(this.pluginFromCatalog(entry, installed));
    }
    for (const entry of library) {
      put(this.pluginFromLibrary(entry, installed));
    }
    for (const [spaceId, list] of Object.entries(installed)) {
      for (const item of list) {
        put({
          id: item.name,
          title: item.name,
          packageName: item.name,
          description: "",
          version: item.version ?? null,
          installedIn: [spaceId],
          protected: item.protected || isGuardedPackage(item.name),
        });
      }
    }

    const q = query.trim();
    let list = [...rows.values()];
    if (q) {
      list = list.filter((row) =>
        matchesPluginQuery(
          {
            id: row.id,
            repo: row.packageName,
            owner: row.packageName,
            packageName: row.packageName,
            description: row.description,
            tags: [],
          },
          q,
        ) || row.packageName.toLowerCase() === q.toLowerCase() || row.id.toLowerCase() === q.toLowerCase(),
      );
    }
    if (q && list.length === 0 && isNpmPackageId(q)) {
      const remote = await this.lookupNpmPackage(q);
      if (remote) list = [remote];
    }
    list.sort((a, b) => a.title.localeCompare(b.title) || a.packageName.localeCompare(b.packageName));
    return list.map(publicPlugin);
  }

  async snapshots(): Promise<WorkbenchSnapshot[]> {
    try {
      return this.ports.snapshots.list().map(publicSnapshot);
    } catch (error) {
      throw this.fail(error, "snapshots.list");
    }
  }

  async snapshot(id: string): Promise<WorkbenchSnapshot> {
    if (typeof id !== "string" || !id) throw new WorkbenchMaintenanceError("workbench/invalid-input");
    try {
      return publicSnapshot(this.ports.snapshots.preview(id));
    } catch (error) {
      throw this.fail(error, "snapshots.preview", "workbench/not-found");
    }
  }

  async runtimes(): Promise<WorkbenchRuntime[]> {
    let installed: Array<{ version: string }> = [];
    try {
      const inventory = this.ports.runtimes.inventory();
      installed = inventory.installed.filter((row) => isExactRuntimeVersion(row.version));
    } catch (error) {
      throw this.fail(error, "runtimes.inventory");
    }
    const versions = new Set(installed.map((row) => row.version));
    try {
      const catalog = await this.ports.runtimes.catalog();
      for (const row of catalog.versions) {
        if (isExactRuntimeVersion(row.version)) versions.add(row.version);
      }
    } catch (error) {
      this.log("runtimes.catalog", error);
    }
    const installedSet = new Set(installed.map((row) => row.version));
    const host = this.ports.hostRuntime()?.version;
    const pinned = new Map<string, string[]>();
    for (const row of this.ports.registry.scan()) {
      if (!row.meta.dshVersion) continue;
      const list = pinned.get(row.meta.dshVersion) ?? [];
      list.push(row.name);
      pinned.set(row.meta.dshVersion, list);
    }
    return [...versions]
      .sort((a, b) => a.localeCompare(b))
      .map((version) => {
        const pinnedBy = (pinned.get(version) ?? []).sort();
        return {
          version,
          installed: installedSet.has(version),
          host: host === version,
          pinnedBy,
          removable: installedSet.has(version) && host !== version && pinnedBy.length === 0,
          compatible: this.ports.isCompatibleRuntime(version),
        };
      });
  }

  async backups(spaceId: string): Promise<WorkbenchBackup[]> {
    this.targetSpace(spaceId, true);
    try {
      return this.ports.diagnostics.get(spaceId).backups.map(publicBackup);
    } catch (error) {
      throw this.fail(error, "diagnostics.get", "workbench/not-found");
    }
  }

  private assertWritable(): void {
    try {
      this.ports.assertWritable();
    } catch (error) {
      throw this.fail(error, "assertWritable", "workbench/forbidden");
    }
  }
}
