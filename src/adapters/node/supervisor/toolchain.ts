import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lstatSync, realpathSync } from "../../../shared/node/filesystem";
import type { SnapshotRuntime } from "../../../shared/snapshots";
import { atomicWrite } from "../atomic";
import { inspectHomeToolchain } from "../home/control-residue";
import type { HomeOperationLock } from "../home/home-operation-lock";
import { setManagedCliPrefix, setManagedNodeExecutable, setSelectedDshResolver } from "../runtime/dsh-cli";
import { managedCliPrefix } from "../runtime/dsh-cli";
import { archiveAbsPath } from "../products/plugin-library";
import { pluginAdd, pluginLinkDirectory } from "../products/plugin-ops";
import { installedComponentMatches } from "../profile/profile-alpha-migration";
import { assertOwnedProfilePath } from "../profile/profile-settings";
import { SESSION_ROW_ID, STORAGE_ROW_ID, extractRoot } from "../profile/patch-writer";
import type { ProfileRegistry } from "../profile/profile-registry";
import { alignmentArchiveId } from "../payload/component-cli";
import { validateComponentPayload, type ValidatedComponentPayload } from "../payload/component-payload";
import { devComponentDir, devComponentLinked, type SpacesComponent } from "../payload/dev-checkout";
import { describeRuntime, readRuntimeRef } from "../runtime/runtime-descriptor";
import type { RuntimeStore } from "../runtime/runtime-store";
import { setToolchainRoot } from "../runtime/toolchain";
import type { SpacesLoaderView } from "../products/spaces-service";
import { NodeSpacesService } from "../products/spaces-service";
import { WorkbenchPublicError, WORKBENCH_ERROR } from "./errors";
import type { SupervisorLifecycle } from "./lifecycle";
import { bindSelectedCli } from "./payload";
import { profileHasViewBridge } from "./profile-probe";
import type { BoundCli, WorkbenchSupervisorOptions } from "./types";

export const VIEW_BRIDGE_ID = "dsh-spaces-view-bridge";

const COMPONENT_ARCHIVE_PREFIX: Record<SpacesComponent, string> = {
  plugin: "dsh-spaces-plugin",
  "view-bridge": VIEW_BRIDGE_ID,
  "llm-bridge": "dsh-spaces-llm-bridge",
  browser: "dsh-spaces-browser",
};

export interface SupervisorToolchainHost {
  home: string;
  controlDir: string;
  nodeExe: string;
  lifecycle: SupervisorLifecycle;
  lock: HomeOperationLock;
  registry: ProfileRegistry;
  options: WorkbenchSupervisorOptions;
  now: () => Date;
  cli: () => BoundCli | null;
  setCli: (cli: BoundCli | null) => void;
  managerId: () => string | null;
  selectedPayload: () => ValidatedComponentPayload | undefined;
  runtimeStore: () => RuntimeStore | undefined;
  observeChildWork: <T>(action: () => T) => T;
}

/**
 * The bound DSH toolchain: the CLI binding, the runtime a space runs on, and
 * the component artifacts installed into a profile. The binding is written
 * once at startup and rewritten only when the manager is reinitialized.
 */
export class SupervisorToolchain {
  constructor(private readonly host: SupervisorToolchainHost) {}

  bindToolchain(): void {
    let cli: BoundCli;
    try {
      const recorded = inspectHomeToolchain(this.host.home);
      if (recorded.kind === "invalid") throw new Error(recorded.reason);
      // A stale record (host update replaced the bound binary) keeps its
      // directories; the CLI below binds the current host and rewrites it.
      if (recorded.kind === "verified" || recorded.kind === "stale") {
        this.host.options.controlToolRoot = recorded.toolchainRoot ?? this.host.options.controlToolRoot;
        this.host.options.runtimeRoot = recorded.runtimeRoot ?? this.host.options.runtimeRoot;
        this.host.options.snapshotRoot = recorded.snapshotRoot ?? this.host.options.snapshotRoot;
      }
      cli = bindSelectedCli(this.host.options.bin);
    } catch (error) {
      this.host.setCli(null);
      this.host.lifecycle.blocked = true;
      this.host.lifecycle.reasons = [
        error instanceof WorkbenchPublicError ? error.message : WORKBENCH_ERROR["workbench/incompatible"],
      ];
      return;
    }
    this.host.setCli(cli);
    mkdirSync(this.host.controlDir, { recursive: true });
    const toolRoot = this.host.options.controlToolRoot ?? join(this.host.controlDir, "toolchain");
    setToolchainRoot(toolRoot);
    setManagedCliPrefix(this.host.options.controlToolRoot ?? join(this.host.controlDir, "cli"));
    setManagedNodeExecutable(this.host.nodeExe);
    setSelectedDshResolver((profile) => this.resolveCliBin(profile));
    atomicWrite(
      join(this.host.controlDir, "toolchain.json"),
      `${JSON.stringify(
        {
          version: 1,
          bin: cli.bin,
          nodeExe: this.host.nodeExe,
          dshVersion: cli.version,
          toolchainRoot: resolve(toolRoot),
          runtimeRoot: this.runtimeRoot(),
          snapshotRoot: this.snapshotRoot(),
          boundAt: this.host.now().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }

  snapshotRoot(): string {
    if (this.host.options.snapshotRoot) return resolve(this.host.options.snapshotRoot);
    return join(resolve(this.host.home, ".."), `${basename(this.host.home)}-snapshots`);
  }

  runtimeRoot(): string {
    return resolve(this.host.options.runtimeRoot ?? this.host.options.controlToolRoot ?? join(this.host.controlDir, "runtimes"));
  }

  currentRuntime(): SnapshotRuntime {
    const selected = this.host.runtimeStore()?.current();
    const cli = this.host.cli();
    const ref = selected
      ? { bin: selected.bin, version: selected.version }
      : readRuntimeRef(cli?.bin) ?? (cli ? { bin: cli.bin, version: cli.version } : undefined);
    return describeRuntime(ref, selected?.origin === "store" ? join(this.runtimeRoot(), "versions", selected.version) : selected?.origin === "managed" ? managedCliPrefix() : undefined);
  }

  pinnedDshVersion(spaceId: string): string | undefined {
    return this.host.registry.scan().find((row) => row.name === spaceId)?.meta.dshVersion;
  }

  /** The DSH runtime a profile runs on: the host CLI for the manager/web, else its pin. */
  resolveSpaceRuntime(spaceId: string): { bin: string; version: string } {
    const cli = this.host.cli();
    if (!cli) throw new WorkbenchPublicError("workbench/incompatible");
    const pinned = spaceId === this.host.managerId() || spaceId === "web" ? cli.version : this.pinnedDshVersion(spaceId);
    if (!pinned) {
      throw new WorkbenchPublicError(
        "workbench/incompatible",
        "This space has no pinned DSH version. Choose one in the space settings.",
      );
    }
    const version = pinned;
    if (version === cli.version) return { bin: cli.bin, version };
    const installed = this.host.runtimeStore()?.installedBin(version);
    if (installed) return { bin: installed, version };
    const legacy = this.host.runtimeStore()?.current();
    if (legacy && legacy.version === version) return { bin: legacy.bin, version };
    throw new WorkbenchPublicError(
      "workbench/incompatible",
      `DSH ${version} for this space is not installed. Install it from the space settings.`,
    );
  }

  resolveCliBin(profile?: string): string | undefined {
    if (!profile || profile === "web" || profile === this.host.managerId()) return this.host.cli()?.bin;
    return this.resolveSpaceRuntime(profile).bin;
  }

  async readDump(profile: string): Promise<string | undefined> {
    if (this.host.options.dumpConfig) {
      try {
        return await this.host.options.dumpConfig(profile);
      } catch {
        return undefined;
      }
    }
    try {
      const result = await this.runBoundCli(["--profile", profile, "--dump-config"], profile);
      return result.code === 0 ? result.stdout : undefined;
    } catch {
      return undefined;
    }
  }

  async runBoundCli(args: readonly string[], profile?: string) {
    if (this.host.options.runCli) return this.host.options.runCli(args);
    const bin = this.resolveCliBin(profile);
    if (!bin) throw new WorkbenchPublicError("workbench/incompatible");
    const { spawnBoundCli } = await import("../products/spaces-service.ts");
    return spawnBoundCli(this.host.nodeExe, bin, this.host.home, { ...process.env, DSH_HOME: this.host.home }, args);
  }

  artifactDigest(artifact: string): string {
    return createHash("sha256").update(readFileSync(artifact)).digest("hex").slice(0, 20);
  }

  /** Whether this launch can provide a component: always true for a linked checkout, else its artifact. */
  hasComponent(component: SpacesComponent): boolean {
    if (this.host.options.devCheckoutRoot !== undefined) return true;
    return this.componentArtifact(component) !== undefined;
  }

  /**
   * Dev checkouts link the component directory in place; the packaged path
   * installs the artifact tarball under the same archive ids as before.
   */
  async installComponent(profileId: string, component: SpacesComponent): Promise<void> {
    const checkout = this.host.options.devCheckoutRoot;
    if (checkout !== undefined) {
      const add = this.host.options.pluginLink ?? pluginLinkDirectory;
      await add(this.host.home, profileId, devComponentDir(checkout, component), `@dsh-spaces/${component}`);
      return;
    }
    const artifact = this.componentArtifact(component);
    if (!artifact) {
      throw new Error(`The selected ${component} archive is unavailable.`);
    }
    await this.installArtifact(profileId, artifact, `${COMPONENT_ARCHIVE_PREFIX[component]}-${this.artifactDigest(artifact)}`);
  }

  /**
   * Dev checkouts align by link identity; packaged installs align on installed
   * content (plugin payload digest, bridge/component file bytes).
   */
  componentAligned(profileId: string, component: SpacesComponent): boolean {
    const checkout = this.host.options.devCheckoutRoot;
    if (checkout !== undefined) {
      return devComponentLinked(this.host.home, profileId, checkout, component);
    }
    const selected = this.host.selectedPayload();
    if (!selected) return false;
    if (component === "plugin") {
      const lib = this.installedManagerPluginLib(profileId);
      if (!lib) return false;
      try {
        return validateComponentPayload(lib).digest === selected.digest;
      } catch {
        return false;
      }
    }
    return installedComponentMatches(this.host.home, profileId, selected.payloadRootLib, component);
  }

  private componentArtifact(component: SpacesComponent): string | undefined {
    switch (component) {
      case "plugin": return this.host.options.pluginArtifact;
      case "view-bridge": return this.host.options.viewBridgeArtifact;
      case "llm-bridge": return this.host.options.llmBridgeArtifact;
      case "browser": return this.host.options.browserArtifact;
    }
  }

  async installArtifact(profileId: string, artifact: string, id: string): Promise<void> {
    const profileDir = join(this.host.home, "profiles", profileId);
    const canonicalDest = archiveAbsPath(this.host.home, id);
    // A malformed profile manifest fails before the copy and the one add.
    // The dependency path may be the canonical archive or the same source digest with -r1.
    // Installed content is the alignment coordinate, not that path.
    const chosen = alignmentArchiveId(profileDir, id, canonicalDest);
    const dest = archiveAbsPath(this.host.home, chosen);
    assertOwnedProfilePath(this.host.home, dest);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(resolve(artifact), dest);
    const add = this.host.options.pluginAdd ?? pluginAdd;
    await add(this.host.home, profileId, dest);
  }

  async ensureViewBridge(profileId: string): Promise<void> {
    if (!this.hasComponent("view-bridge")) return;
    if (profileId === this.host.managerId()) return;
    const checkout = this.host.options.devCheckoutRoot;
    if (checkout !== undefined
      ? devComponentLinked(this.host.home, profileId, checkout, "view-bridge")
      : profileHasViewBridge(this.host.home, profileId)) return;
    await this.installComponent(profileId, "view-bridge");
  }

  async alignManagerPlugin(profileId: string): Promise<void> {
    const pluginAligned = this.componentAligned(profileId, "plugin");
    const bridgeAligned = !this.hasComponent("view-bridge") || this.componentAligned(profileId, "view-bridge");
    if (pluginAligned && bridgeAligned) return;
    await this.host.lock.run("manager.align", () => this.host.observeChildWork(async () => {
      if (!pluginAligned) {
        await this.installComponent(profileId, "plugin");
      }
      if (!bridgeAligned) {
        await this.installComponent(profileId, "view-bridge");
      }
      if (!this.componentAligned(profileId, "plugin")) {
        throw new Error("The installed manager plugin payload does not match the selected component group.");
      }
      if (this.hasComponent("view-bridge") && !this.componentAligned(profileId, "view-bridge")) {
        throw new Error("The installed manager view bridge does not match the selected component group.");
      }
    }));
  }

  installedManagerPluginLib(profileId: string): string | undefined {
    const target = join(this.host.home, "profiles", profileId, "node_modules", "@dsh-spaces", "plugin", "lib", "index.js");
    let st;
    try {
      st = lstatSync(target);
    } catch {
      return undefined;
    }
    if (st.isSymbolicLink() || !st.isFile()) return undefined;
    try {
      const real = realpathSync(target);
      const rel = relative(resolve(this.host.home), real);
      if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return undefined;
      return dirname(real);
    } catch {
      return undefined;
    }
  }

  async syncLoader(profileId: string, bootstrapDump?: string): Promise<SpacesLoaderView | undefined> {
    // `bootstrapDump` may only be the dump bootstrapManager just read for this
    // same profile in this same run; otherwise (other profile, no bootstrap
    // dump, later re-sync) the dump is read fresh.
    const dump = bootstrapDump ?? await this.readDump(profileId);
    if (!dump) return undefined;
    try {
      const session = extractRoot(dump, SESSION_ROW_ID);
      const storage = extractRoot(dump, STORAGE_ROW_ID);
      if (!session || !storage) return undefined;
      const entries = [
        { id: SESSION_ROW_ID, options: { id: SESSION_ROW_ID, config: { root: session } } },
        { id: STORAGE_ROW_ID, options: { id: STORAGE_ROW_ID, config: { root: storage } } },
      ];
      return { entries: () => entries };
    } catch {
      return undefined;
    }
  }

  createSpacesServiceWithLoader(loader?: SpacesLoaderView): NodeSpacesService | undefined {
    const cli = this.host.cli();
    const managerId = this.host.managerId();
    if (!cli || !managerId) return undefined;
    return new NodeSpacesService({
      home: this.host.home,
      allowRealHome: this.host.options.allowRealHome,
      argv: [this.host.nodeExe, cli.bin, "--profile", managerId],
      env: { ...process.env, DSH_HOME: this.host.home },
      execPath: this.host.nodeExe,
      baseUrl: join(this.host.home, "profiles", managerId),
      loader,
      snapshotRoot: this.snapshotRoot(),
      lock: this.host.lock,
      runCli: this.host.options.runCli ?? ((args) => this.runBoundCli(args)),
    });
  }
}
