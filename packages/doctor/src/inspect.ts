import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOME_CONTROL_DIR_NAME,
  HomeController,
  defaultPidAlive,
  type HomeControlInspect,
} from "../../../src/adapters/node/home-controller.ts";
import {
  WORKBENCH_JOBS_DIR_NAME,
} from "../../../src/adapters/node/workbench-jobs.ts";
import { HomeOperationLock, type HomeLockInspect } from "../../../src/adapters/node/home-operation-lock.ts";
import { normalizeSpacesFile } from "../../../src/core/domain/registry.ts";
import { RESTORE_STAGE_DIR } from "../../../src/shared/snapshots.ts";
import { PROFILE_NAME_RE, type SpacesFile } from "../../../src/shared/types.ts";
import {
  CONTROL_INSTANCES_DIR,
  CONTROL_PLANS_DIR,
  MUTATION_JOURNAL,
  PLUGIN_MUTATION_FILE,
  PLUGIN_MUTATION_FILES_DIR,
  UPGRADE_JOURNAL_FILE,
  UPGRADE_STAGE_DIR,
  containedPath,
  exactChildDir,
  inspectNamedDir,
  inspectNamedFile,
  lexists,
  type Json,
} from "./common.ts";
import { publicRuntime, type BoundCli, type ResolvedResources } from "./resources.ts";

const UNFINISHED_JOB = new Set(["queued", "running", "recovery-required"]);

export interface InstanceRow {
  spaceId: string;
  liveness: "alive" | "dead" | "ambiguous" | "unreadable";
  schema: "ok" | "unsupported" | "unreadable";
  path: string;
  pid?: number;
  startedAt?: string;
}

export function publicLock(row: HomeLockInspect): Json {
  if (!row.held) return { held: false };
  if ("reclaim" in row && row.reclaim) return { held: true, reclaim: true };
  if ("incomplete" in row && row.incomplete) return { held: true, incomplete: true };
  if ("ambiguous" in row && row.ambiguous) return { held: true, ambiguous: true, reason: row.reason };
  if ("owner" in row) return { held: true, owner: row.owner };
  return { held: true, incomplete: true };
}

export function publicControl(row: HomeControlInspect): Json {
  if (!row.held) return { held: false };
  if ("reclaim" in row && row.reclaim) return { held: true, reclaim: true };
  if ("incomplete" in row && row.incomplete) return { held: true, incomplete: true };
  if ("ambiguous" in row && row.ambiguous) return { held: true, ambiguous: true, reason: row.reason };
  if ("owner" in row) {
    return { held: true, kind: row.owner.kind, liveness: row.liveness };
  }
  return { held: true, incomplete: true };
}

export function readRegistry(home: string): Json {
  const hubPath = join(home, "hub");
  const filePath = join(hubPath, "spaces.json");
  if (!lexists(hubPath) && !lexists(filePath)) return { status: "missing" };
  if (lexists(hubPath) && !exactChildDir(home, "hub")) return { status: "invalid", code: "UNREADABLE" };
  const file = containedPath(home, ["hub", "spaces.json"], "file");
  if (!file) return lexists(filePath) ? { status: "invalid", code: "UNREADABLE" } : { status: "missing" };
  try {
    const parsed = normalizeSpacesFile(JSON.parse(readFileSync(file, "utf8")) as SpacesFile);
    const order = parsed.order.filter((name) => name === "web" || PROFILE_NAME_RE.test(name));
    return { status: "ok", version: parsed.version, onboarded: Boolean(parsed.onboarded), order };
  } catch (error) {
    const text = error instanceof Error ? error.message : "";
    return { status: "invalid", code: /version/i.test(text) || /版本/.test(text) ? "UNSUPPORTED_VERSION" : "UNREADABLE" };
  }
}

export function readMutationJournal(home: string): Json | null {
  const path = join(home, MUTATION_JOURNAL);
  const state = inspectNamedFile(path);
  if (state === "missing") return null;
  if (state !== "ok") return { present: true, unreadable: true, code: state.toUpperCase() };
  const file = containedPath(home, [MUTATION_JOURNAL], "file");
  if (!file) return { present: true, unreadable: true };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const op = parsed.op === "create" || parsed.op === "verify" ? parsed.op : "unknown";
    const phase = typeof parsed.phase === "string" && /^[a-z0-9-]{1,32}$/.test(parsed.phase) ? parsed.phase : "unknown";
    const spaceId =
      typeof parsed.spaceId === "string" && (parsed.spaceId === "web" || PROFILE_NAME_RE.test(parsed.spaceId))
        ? parsed.spaceId
        : "unknown";
    return { present: true, op, phase, spaceId };
  } catch {
    return { present: true, unreadable: true };
  }
}

export function readRestoreJournal(home: string): Json {
  const stage = join(home, RESTORE_STAGE_DIR);
  const dirState = inspectNamedDir(stage);
  if (dirState === "missing" && inspectNamedFile(join(stage, "journal.json")) === "missing") return { needed: false };
  if (dirState === "unreadable") return { needed: true, unreadable: true, code: "UNREADABLE" };
  if (dirState !== "ok" && dirState !== "missing") return { needed: true, unreadable: true };
  const file = containedPath(home, [RESTORE_STAGE_DIR, "journal.json"], "file");
  if (!file) {
    const journalState = inspectNamedFile(join(stage, "journal.json"));
    if (journalState === "missing") return { needed: false };
    return { needed: true, unreadable: true };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { phase?: unknown };
    const phase =
      parsed.phase === "copying" || parsed.phase === "swapping" || parsed.phase === "swapped" ? parsed.phase : "unknown";
    return phase === "unknown" ? { needed: true, phase, unreadable: true } : { needed: true, phase };
  } catch {
    return { needed: true, unreadable: true };
  }
}

export function readUpgradeJournal(home: string): Json {
  const path = join(home, UPGRADE_STAGE_DIR, UPGRADE_JOURNAL_FILE);
  const dirState = inspectNamedDir(join(home, UPGRADE_STAGE_DIR));
  if (dirState === "missing" && inspectNamedFile(path) === "missing") return { needed: false };
  if (dirState === "unreadable") return { needed: true, unreadable: true, code: "UNREADABLE" };
  const fileState = inspectNamedFile(path);
  if (fileState === "missing") return { needed: false };
  if (fileState !== "ok") return { needed: true, unreadable: true, code: fileState.toUpperCase() };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { phase?: unknown };
    if (parsed.phase === "preparing" || parsed.phase === "committing") return { needed: true, phase: parsed.phase };
    return { needed: true, phase: "unknown", unreadable: true };
  } catch {
    return { needed: true, unreadable: true };
  }
}

export function readPluginMutationRecord(home: string): {
  status: "none" | "open" | "unreadable";
  planId?: string;
  spaceIds?: string[];
  phase?: string;
} {
  const path = join(home, HOME_CONTROL_DIR_NAME, PLUGIN_MUTATION_FILE);
  const state = inspectNamedFile(path);
  if (state === "missing") return { status: "none" };
  if (state !== "ok") return { status: "unreadable" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.spaceIds)) return { status: "unreadable" };
    const phase =
      parsed.phase === "prepared" || parsed.phase === "mutating" || parsed.phase === "failed" ? parsed.phase : undefined;
    if (!phase) return { status: "unreadable" };
    return {
      status: "open",
      phase,
      planId: typeof parsed.planId === "string" && parsed.planId.trim() ? parsed.planId : undefined,
      spaceIds: parsed.spaceIds.filter((item): item is string => typeof item === "string"),
    };
  } catch {
    return { status: "unreadable" };
  }
}

export function readPluginMutation(home: string): Json {
  const path = join(home, HOME_CONTROL_DIR_NAME, PLUGIN_MUTATION_FILE);
  const state = inspectNamedFile(path);
  if (state === "missing") return { present: false };
  if (state !== "ok") return { present: true, unreadable: true, code: state.toUpperCase() };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.spaceIds)) {
      return { present: true, unreadable: true, code: "UNSUPPORTED_SCHEMA" };
    }
    const phase =
      parsed.phase === "prepared" || parsed.phase === "mutating" || parsed.phase === "failed" ? parsed.phase : "unknown";
    if (phase === "unknown") return { present: true, unreadable: true, code: "UNSUPPORTED_SCHEMA" };
    const files = inspectNamedDir(join(home, HOME_CONTROL_DIR_NAME, PLUGIN_MUTATION_FILES_DIR));
    return {
      present: true,
      phase,
      spaces: parsed.spaceIds.length,
      evidence: files === "ok" || files === "missing" ? files : "unreadable",
      rollbackRequired: true,
    };
  } catch {
    return { present: true, unreadable: true };
  }
}

export function readManager(controller: HomeController): Json {
  try {
    const identityPath = join(controller.controlDir, "manager.json");
    const state = inspectNamedFile(identityPath);
    if (state === "missing") return { status: "missing" };
    if (state === "unreadable") return { status: "damaged", code: "UNREADABLE" };
    if (state !== "ok") return { status: "damaged", code: "AMBIGUOUS" };
    try {
      const parsed = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
      if (parsed.version !== 1 || typeof parsed.profileId !== "string") {
        return { status: "damaged", code: "UNSUPPORTED_SCHEMA" };
      }
      const role = controller.roleOf(parsed.profileId);
      return { status: "ok", role, profileReserved: true };
    } catch {
      return { status: "damaged", code: "UNREADABLE" };
    }
  } catch {
    return { status: "damaged", code: "UNREADABLE" };
  }
}

export function readJobs(home: string): Json {
  const dir = join(home, HOME_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME);
  const state = inspectNamedDir(dir);
  if (state === "missing") return { status: "missing", unfinished: 0 };
  if (state === "unreadable") return { status: "unreadable", code: "UNREADABLE" };
  if (state !== "ok") return { status: "unreadable", code: "AMBIGUOUS" };
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"));
  } catch {
    return { status: "unreadable", code: "UNREADABLE" };
  }
  const unfinished: Json[] = [];
  let unreadable = 0;
  let unsupported = 0;
  for (const name of names) {
    const path = join(dir, name);
    const fileState = inspectNamedFile(path);
    if (fileState !== "ok") {
      unreadable += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (parsed.schemaVersion !== 1) {
        unsupported += 1;
        continue;
      }
      const status = typeof parsed.status === "string" ? parsed.status : "unknown";
      const kind = typeof parsed.kind === "string" ? parsed.kind : "unknown";
      const phase = typeof parsed.phase === "string" ? parsed.phase : "unknown";
      if (UNFINISHED_JOB.has(status) || status === "unknown") {
        unfinished.push({ kind, status, phase });
      }
    } catch {
      unreadable += 1;
    }
  }
  return {
    status: unreadable || unsupported || unfinished.length ? "recovery-required" : "ok",
    count: names.length,
    unfinished: unfinished.length,
    unreadable,
    unsupportedSchema: unsupported,
    jobs: unfinished,
  };
}

export function readInstances(home: string): { public: Json; rows: InstanceRow[]; recoveryMode: boolean } {
  const dir = join(home, HOME_CONTROL_DIR_NAME, CONTROL_INSTANCES_DIR);
  const state = inspectNamedDir(dir);
  if (state === "missing") {
    return { public: { status: "missing", live: 0, dead: 0, ambiguous: 0 }, rows: [], recoveryMode: false };
  }
  if (state !== "ok") {
    return {
      public: { status: "unreadable", code: state.toUpperCase(), live: 0, dead: 0, ambiguous: 1 },
      rows: [],
      recoveryMode: true,
    };
  }
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return {
      public: { status: "unreadable", code: "UNREADABLE", live: 0, dead: 0, ambiguous: 1 },
      rows: [],
      recoveryMode: true,
    };
  }
  const rows: InstanceRow[] = [];
  let live = 0;
  let dead = 0;
  let ambiguous = 0;
  let unreadable = 0;
  for (const name of names) {
    const path = join(dir, name);
    const fileState = inspectNamedFile(path);
    const spaceFromName = name.slice(0, -".json".length);
    if (fileState !== "ok") {
      unreadable += 1;
      ambiguous += 1;
      rows.push({ spaceId: spaceFromName, liveness: "unreadable", schema: "unreadable", path });
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (parsed.version !== 1) {
        unreadable += 1;
        ambiguous += 1;
        rows.push({ spaceId: spaceFromName, liveness: "unreadable", schema: "unsupported", path });
        continue;
      }
      const spaceId = typeof parsed.spaceId === "string" ? parsed.spaceId : spaceFromName;
      if (spaceId !== spaceFromName || typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") {
        ambiguous += 1;
        rows.push({ spaceId, liveness: "ambiguous", schema: "ok", path });
        continue;
      }
      const liveness = defaultPidAlive(parsed.pid, parsed.startedAt);
      if (liveness === "alive") live += 1;
      else if (liveness === "dead") dead += 1;
      else ambiguous += 1;
      rows.push({
        spaceId,
        liveness,
        schema: "ok",
        path,
        pid: parsed.pid,
        startedAt: parsed.startedAt,
      });
    } catch {
      unreadable += 1;
      ambiguous += 1;
      rows.push({ spaceId: spaceFromName, liveness: "unreadable", schema: "unreadable", path });
    }
  }
  const recoveryMode = live > 0 || ambiguous > 0 || unreadable > 0;
  return {
    public: { status: names.length ? "present" : "empty", live, dead, ambiguous, unreadable },
    rows,
    recoveryMode,
  };
}

export function readPlans(home: string): Json[] {
  const dir = join(home, HOME_CONTROL_DIR_NAME, CONTROL_PLANS_DIR);
  if (inspectNamedDir(dir) !== "ok") return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const plans: Json[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (inspectNamedFile(path) !== "ok") continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (parsed.schemaVersion !== 1) continue;
      const command = parsed.command && typeof parsed.command === "object" ? (parsed.command as Record<string, unknown>) : {};
      plans.push({
        id: typeof parsed.id === "string" ? parsed.id : name.slice(0, -".json".length),
        status: typeof parsed.status === "string" ? parsed.status : "unknown",
        kind: typeof command.kind === "string" ? command.kind : "unknown",
        snapshotId: typeof command.snapshotId === "string" ? command.snapshotId : undefined,
      });
    } catch {
      /* leave bytes; diagnosis does not rewrite plans */
    }
  }
  return plans;
}

export function recoveryBlocksVerify(home: string): boolean {
  const mutation = readMutationJournal(home);
  const restore = readRestoreJournal(home);
  const upgrade = readUpgradeJournal(home);
  const plugin = readPluginMutation(home);
  return Boolean(mutation) || restore.needed === true || upgrade.needed === true || plugin.present === true;
}

export function findingsFromInspect(input: {
  restore: Json;
  upgrade: Json;
  plugin: Json;
  lock: Json;
  control: Json;
  manager: Json;
  jobs: Json;
  instances: Json;
  toolchain: Json;
}): string[] {
  const findings: string[] = [];
  if (input.restore.needed === true) {
    findings.push(
      input.restore.unreadable
        ? "A restore journal is present and unreadable. Original bytes were left in place."
        : "A whole-home restore journal is unfinished.",
    );
  }
  if (input.upgrade.needed === true) {
    findings.push(
      input.upgrade.unreadable
        ? "An upgrade journal is present and unreadable. Original bytes were left in place."
        : "An upgrade journal is unfinished.",
    );
  }
  if (input.plugin.present === true) {
    findings.push(
      input.plugin.unreadable
        ? "Plugin-mutation evidence is unreadable and was not treated as absent."
        : "Plugin mutation evidence is present. Do not restore a single manifest; use a whole-home snapshot rollback.",
    );
  }
  if (input.lock.held === true) findings.push("The home transaction lock is held or incomplete.");
  if (input.control.held === true) findings.push("Home run-control is held, reclaiming, or ambiguous.");
  if (input.manager.status === "damaged") {
    findings.push("Manager identity is damaged and was not rebuilt.");
  }
  if (input.jobs.status === "recovery-required" || input.jobs.status === "unreadable") {
    findings.push("Persistent workbench jobs need recovery and were not cleared.");
  }
  if ((input.instances.live as number) > 0 || (input.instances.ambiguous as number) > 0) {
    findings.push("Leftover instances are live or identity-ambiguous. Recovery mode: directories were not swapped and PIDs were not killed.");
  }
  if (Array.isArray(input.toolchain.missing) && input.toolchain.missing.length) {
    findings.push("Trusted snapshotRoot/runtimeRoot/cli fields are missing. Pass flags; production app data was not guessed.");
  }
  return findings;
}

export function inspectHome(
  lock: HomeOperationLock,
  cli: BoundCli | undefined,
  toolchain: Json,
  cliError?: ResolvedResources["cliError"],
): Json {
  const controller = new HomeController(lock.home);
  const restore = readRestoreJournal(lock.home);
  const upgrade = readUpgradeJournal(lock.home);
  const plugin = readPluginMutation(lock.home);
  const control = publicControl(controller.inspect());
  const manager = readManager(controller);
  const jobs = readJobs(lock.home);
  const instances = readInstances(lock.home);
  const body = {
    registry: readRegistry(lock.home),
    journals: { mutation: readMutationJournal(lock.home), restore, upgrade, pluginMutation: plugin },
    lock: publicLock(lock.inspect()),
    control,
    manager,
    jobs,
    instances: instances.public,
    runtime: publicRuntime(cli, cliError),
    toolchain,
    findings: [] as string[],
  };
  body.findings = findingsFromInspect({
    restore,
    upgrade,
    plugin,
    lock: body.lock,
    control,
    manager,
    jobs,
    instances: instances.public,
    toolchain,
  });
  return body;
}
