import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpaceBase } from '../../../shared/space-base';
import { isExactRuntimeVersion } from '../../../shared/runtime';

/** Read the profile's explicit product identity, never infer it from installed plugins. */
export function profileBase(home: string, name: string): SpaceBase {
  const path = join(home, 'profiles', name, 'package.json');
  if (!existsSync(path)) return 'web';
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const base = pkg.dsh?.profile?.spacesBase;
  if (base === undefined || base === 'web') return 'web';
  if (base === 'browser') return base;
  throw new Error('Invalid space base in profile manifest.');
}

/** A Browser release owns its framework dependency; starting never silently aligns it. */
export function assertBrowserRelease(home: string, name: string, runtimeVersion: string): void {
  const dir = join(home, 'profiles', name);
  const profile = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dsh?.profile;
  const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', '@dsh-spaces', 'browser', 'package.json'), 'utf8'));
  if (profile?.spacesBase !== 'browser' || !isExactRuntimeVersion(profile.baseVersion)
    || pkg.name !== '@dsh-spaces/browser' || pkg.version !== profile.baseVersion
    || pkg.dsh?.spacesBase?.runtimeVersion !== runtimeVersion) {
    throw new Error('The Browser release or its required DSH framework does not match this space.');
  }
}
