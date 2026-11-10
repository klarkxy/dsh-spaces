import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareScannedProfiles, defaultSpaceMeta } from "../../../core/domain/registry";
import { redactPublicReason } from "../../../shared/public-reason";
import type { SpaceDetail } from "../../../shared/spaces-control";
import type { ProfileStatus } from "../../../shared/types";
import type { SpaceAttention } from "../../../shared/space-attention";
import type { WorkbenchSpace } from "../../../shared/workbench";
import { sanitizeLogText } from "../diagnostics/diagnostics";
import type { ProfileRegistry } from "../profile/profile-registry";
import type { ProcessManager } from "../runtime/process-manager";
import { WorkbenchPublicError } from "./errors";
import { parseSpaceName } from "./input";
import type { SupervisorLifecycle } from "./lifecycle";
import { publicPluginVersion } from "./profile-probe";
import type { SpaceRunRegistry } from "./space-runs";

export interface SupervisorSpacesHost {
  home: string;
  registry: ProfileRegistry;
  lifecycle: SupervisorLifecycle;
  runs: SpaceRunRegistry;
  processes: () => ProcessManager | undefined;
  managerId: () => string | null;
  /** Presentation-only attention read; never consulted for authority. */
  attentionOf?: (id: string) => SpaceAttention;
}

/**
 * The registry-backed space inventory: what exists, what runs, and which
 * entries the supervisor may act on. Every read that can fail on a damaged
 * registry reports the same failure the composition root reported before.
 */
export class SupervisorSpaces {
  constructor(private readonly host: SupervisorSpacesHost) {}

  listSpaces(): WorkbenchSpace[] {
    let records: ReturnType<ProfileRegistry["scan"]> = [];
    try {
      records = this.host.registry.scan();
      const managerId = this.host.managerId();
      if (managerId && this.host.registry.has(managerId) && !records.some((row) => row.name === managerId)) {
        const spaces = this.host.registry.readSpaces();
        const path = join(this.host.registry.profilesDir(), managerId);
        records.push({
          name: managerId,
          path,
          hasWebApp: this.host.registry.hasWebApp(path),
          meta: spaces.meta[managerId] ?? defaultSpaceMeta(managerId),
          status: "stopped",
        });
        records.sort((a, b) => compareScannedProfiles(a, b, spaces.order));
      }
    } catch (error) {
      throw this.registryReadFailure(error);
    }
    return records
      .map((row) => {
        const leftover = this.host.runs.unmanaged.has(row.name);
        const status = leftover ? "unknown" : this.publicStatus(row.name);
        const view = this.host.runs.views.get(row.name);
        return {
          id: row.name,
          displayName: row.meta.displayName || row.name,
          isHost: row.name === this.host.managerId(),
          hasWebApp: row.hasWebApp,
          icon: row.meta.icon ?? "",
          base: row.meta.base,
          baseVersion: row.meta.baseVersion,
          status,
          generation: view?.generation ?? this.host.runs.generation(row.name),
          managed: Boolean(this.host.lifecycle.handle) && !leftover,
          attention: status === "running" ? this.host.attentionOf?.(row.name) ?? "unknown" : "unknown",
          dshVersion: row.name === this.host.managerId() ? null : (row.meta.dshVersion ?? null),
        } satisfies WorkbenchSpace;
      });
  }

  assertRegistryReadable(): void {
    try {
      this.host.registry.readSpaces();
    } catch (error) {
      throw this.registryReadFailure(error);
    }
  }

  registryReadFailure(error: unknown): WorkbenchPublicError {
    const detail = error instanceof Error ? error.message : "Unknown read failure.";
    const lifecycle = this.host.lifecycle;
    lifecycle.registryFailure ??= `Space registry could not be read: ${redactPublicReason(sanitizeLogText(detail))} Further changes are blocked.`;
    lifecycle.blocked = true;
    lifecycle.addReason(lifecycle.registryFailure);
    return new WorkbenchPublicError("workbench/unavailable", lifecycle.registryFailure);
  }

  publicStatus(name: string): WorkbenchSpace["status"] {
    const processes = this.host.processes();
    if (!processes) return "stopped";
    const status = processes.statusOf(name);
    if (status === "starting") return "starting";
    if (status === "running") return "running";
    if (status === "crashed") return "crashed";
    return "stopped";
  }

  statusOf(name: string): ProfileStatus {
    return this.host.processes()?.statusOf(name) ?? "stopped";
  }

  ownedSpaceIds(): string[] {
    return this.listSpaces()
      .filter((row) => row.managed && !this.host.runs.unmanaged.has(row.id))
      .map((row) => row.id);
  }

  homeProfileNames(): string[] {
    const names = this.host.registry.scan().map((row) => row.name);
    const managerId = this.host.managerId();
    if (managerId && !names.includes(managerId)) names.unshift(managerId);
    if (existsSync(join(this.host.home, "profiles", "web")) && !names.includes("web")) names.unshift("web");
    return names;
  }

  requireSpace(spaceId: string): string {
    const id = parseSpaceName(spaceId);
    const hit = this.listSpaces().find((row) => row.id === id) || (id === this.host.managerId() ? { id } : null);
    if (!hit) throw new WorkbenchPublicError("workbench/not-found");
    return id;
  }

  requireManaged(spaceId: string): string {
    const id = this.requireSpace(spaceId);
    if (!this.host.processes()) throw new WorkbenchPublicError("workbench/unmanaged");
    return id;
  }

  validateSpace(spaceId: string, allowManager = false): void {
    const id = this.requireSpace(spaceId);
    this.protectSpecial(id, { allowManager });
  }

  protectSpecial(id: string, options: { allowManager: boolean }): void {
    if (id === "web" || id === "desktop") throw new WorkbenchPublicError("workbench/protected");
    if (!options.allowManager && id === this.host.managerId()) throw new WorkbenchPublicError("workbench/protected");
  }

  readPlugins(name: string): SpaceDetail["plugins"] {
    try {
      const pkg = JSON.parse(readFileSync(join(this.host.home, "profiles", name, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      return Object.entries(pkg.dependencies ?? {}).map(([pluginName, version]) => ({
        name: pluginName,
        version: publicPluginVersion(version),
      }));
    } catch {
      return [];
    }
  }
}
