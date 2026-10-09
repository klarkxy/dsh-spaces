/** Read-only official profile adapter. Mutations are owned by native tools and the guarded order adapter. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PACKAGE, exactVersion } from './blueprint.mjs';
import { parseJson, fail } from './codec.mjs';
export function officialPort(ctx) {
  const manager = ctx.pluginManager;
  if (typeof manager?.listBundles !== 'function') fail('capability', 'Official pluginManager.listBundles is required.');
  if (!ctx.profileContext?.dir) fail('capability', 'An official profile directory is required.');
  const manifestPath = join(ctx.profileContext.dir, 'package.json');
  return { async snapshot() {
    const before = readFileSync(manifestPath, 'utf8');
    const manifest = parseJson(before);
    const nativeBundles = await manager.listBundles();
    const packages = nativeBundles.map(b => {
      const readonly = Boolean(b.readOnlyReason || b.name === PACKAGE || b.rows.some(r => r.moduleName === PACKAGE)
        || !b.installed && !b.optional);
      const spec = manifest.dependencies?.[b.name];
      const registry = typeof spec === 'string' && /^[0-9A-Za-z*~^<>=|.+ -]+$/.test(spec);
      const source = b.installed ? registry ? 'npm' : null : 'builtin';
      const reason = b.error ? 'native-bundle-error' : !exactVersion(b.version) ? 'unknown-exact-version' : !source ? 'non-registry-source' : null;
      return { name: b.name, version: b.version ?? null, source, enabled: b.enabled, readonly, reason };
    });
    const order = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(order) || order.some(n => typeof n !== 'string')) fail('profile', 'No native ordered bundle manifest.');
    if (readFileSync(manifestPath, 'utf8') !== before) fail('stale', 'Profile changed while reading the catalog.');
    const stamp = createHash('sha256').update(JSON.stringify({ manifest: before, packages: [...packages].sort((a, b) => a.name.localeCompare(b.name)) })).digest('hex');
    return { packages, order, stamp };
  } };
}
