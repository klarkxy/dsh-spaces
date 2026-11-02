/** Product versions belong to a base; the framework pin is an implementation dependency. */
import { isExactRuntimeVersion } from './runtime';
export type SpaceBase = 'web' | 'browser';

export interface SpaceBaseSelection {
  base?: SpaceBase;
  baseVersion?: string;
}

export interface SpaceBaseVersions {
  base: SpaceBase;
  versions: string[];
  preferred: string | null;
}

export function parseSpaceBaseSelection(value: { base?: unknown; baseVersion?: unknown }): SpaceBaseSelection {
  if (value.base === undefined && value.baseVersion === undefined) return {};
  if ((value.base !== 'web' && value.base !== 'browser') || typeof value.baseVersion !== 'string' || !isExactRuntimeVersion(value.baseVersion)) {
    throw new Error('Invalid space base identity. Both base and exact baseVersion are required.');
  }
  return { base: value.base, baseVersion: value.baseVersion };
}
