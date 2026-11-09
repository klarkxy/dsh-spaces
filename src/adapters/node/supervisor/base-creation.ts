import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gte, rcompare } from 'semver';
import { isExactRuntimeVersion, SPACES_MIN_DSH_VERSION } from '../../../shared/runtime';
import type { SpaceBase, SpaceBaseVersions } from '../../../shared/space-base';
import { atomicWrite } from '../atomic';
import { devComponentDir } from '../payload/dev-checkout';
import { spawnBoundCli, type BoundCliRunner } from '../products/spaces-service';
import type { RuntimeStore } from '../runtime/runtime-store';
import type { BoundCli, WorkbenchSupervisorOptions } from './types';
import { WorkbenchPublicError } from './errors';

export interface BaseCreationHost {
  home: string;
  nodeExe: string;
  options: WorkbenchSupervisorOptions;
  cli(): BoundCli | null;
  runtimes(): RuntimeStore | undefined;
}

export class SpaceBaseCreation {
  constructor(private readonly host: BaseCreationHost) {}

  private browserRelease(): { version: string; runtimeVersion: string } {
    const { componentPayloadRoot, browserArtifact, viewBridgeArtifact, devCheckoutRoot } = this.host.options;
    if (!componentPayloadRoot || (devCheckoutRoot === undefined && (!browserArtifact || !viewBridgeArtifact))) {
      throw new WorkbenchPublicError('workbench/unavailable', 'The Browser base payload is unavailable.');
    }
    const pkg = JSON.parse(readFileSync(join(componentPayloadRoot, 'browser', 'package.json'), 'utf8'));
    const runtimeVersion = pkg.dsh?.spacesBase?.runtimeVersion;
    if (pkg.name !== '@dsh-spaces/browser' || !isExactRuntimeVersion(pkg.version) || !isExactRuntimeVersion(runtimeVersion)) {
      throw new Error('Invalid Browser base release metadata.');
    }
    return { version: pkg.version, runtimeVersion };
  }

  async versions(base: SpaceBase): Promise<SpaceBaseVersions> {
    if (base === 'browser') {
      const { version } = this.browserRelease();
      return { base, versions: [version], preferred: version };
    }
    const store = this.host.runtimes();
    if (!store) throw new WorkbenchPublicError('workbench/unavailable');
    const catalog = await store.catalog();
    const hostVersion = this.host.cli()?.version;
    const versions = [...new Set([...catalog.versions.map(row => row.version), ...(hostVersion ? [hostVersion] : [])])]
      .filter(version => gte(version, SPACES_MIN_DSH_VERSION)).sort(rcompare);
    const preferred = hostVersion && versions.includes(hostVersion) ? hostVersion : versions[0] ?? null;
    return { base, versions, preferred };
  }

  async prepare(base: SpaceBase, requested?: string, onInstall?: (version: string) => void) {
    const cli = this.host.cli();
    if (!cli) throw new WorkbenchPublicError('workbench/incompatible');
    const release = base === 'browser' ? this.browserRelease() : null;
    const baseVersion = requested ?? release?.version ?? cli.version;
    if (!isExactRuntimeVersion(baseVersion) || (release && baseVersion !== release.version)) {
      throw new WorkbenchPublicError('workbench/invalid-input', 'The selected base version is unavailable.');
    }
    const runtimeVersion = release?.runtimeVersion ?? baseVersion;
    if (!gte(runtimeVersion, SPACES_MIN_DSH_VERSION)) throw new WorkbenchPublicError('workbench/incompatible');
    let bin = this.host.runtimes()?.installedBin(runtimeVersion);
    if (!bin) {
      const store = this.host.runtimes();
      if (!store) throw new WorkbenchPublicError('workbench/unavailable');
      onInstall?.(runtimeVersion);
      bin = (await store.install(runtimeVersion)).bin;
    }
    const runCli: BoundCliRunner = this.host.options.runCli ?? (args => spawnBoundCli(
      this.host.nodeExe, bin!, this.host.home, { ...process.env, DSH_HOME: this.host.home }, args));
    return {
      base, baseVersion, runtimeVersion, runCli,
      initialize: base === 'browser' ? async (name: string) => {
        const dir = join(this.host.home, 'profiles', name);
        mkdirSync(dir, { recursive: false });
        atomicWrite(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module',
          dsh: { profile: { bundles: [], spacesBase: base, baseVersion } } }, null, 2) + '\n');
        atomicWrite(join(dir, 'cordis.patch.yml'), '[]\n');
        // The official plugin installer owns dependencies and bundle registration.
        const specs = this.host.options.devCheckoutRoot !== undefined
          ? [devComponentDir(this.host.options.devCheckoutRoot, 'browser'), devComponentDir(this.host.options.devCheckoutRoot, 'view-bridge')]
          : [this.host.options.browserArtifact!, this.host.options.viewBridgeArtifact!];
        for (const artifact of specs) {
          const added = await runCli(['plugin', '--profile', name, 'add', artifact]);
          if (added.code !== 0) throw new Error(`Browser base installation failed (exit ${added.code}): ${added.stderr.slice(-2000)}`);
        }
        // The Browser base never uses the dev-index preinstall; a final
        // disabled row overrides whatever the installed bundle patches inserted.
        atomicWrite(join(dir, 'cordis.patch.yml'), `- id: credentials\n  config:\n    path: !!js dshHomePath('hub/${name}/.credentials.yaml')\n- id: dsh-dev-index\n  disabled: true\n- id: dsh-space-control\n  disabled: true\n`);
      } : undefined,
    };
  }
}
