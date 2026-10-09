/** Permutation-only profile ordering. Approval belongs to the native tool boundary. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { officialPort } from './official.mjs';
import { fail } from './codec.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cancelled = signal => signal?.aborted === true;
const outcome = (saved, application, code) => ({ saved, changed: saved, application, ...(code ? { code } : {}) });

/**
 * Native installation/enablement must finish before calling this adapter.
 * Optional flat injected helpers are for offline tests, never user input.
 * saved means the atomic manifest commit completed, not that live application succeeded.
 * Validation conflicts throw before commit; operational failures return a saved/application report.
 */
export async function applyBundleOrder(ctx, request, signal, injected = {}) {
  if (cancelled(signal)) return outcome(false, 'cancelled', 'interrupted');
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => !['order', 'stamp'].includes(key))) fail('order', 'Expected only order and stamp.');
  const { stamp } = request;
  if (typeof stamp !== 'string' || !stamp) fail('stale', 'A current profile stamp is required.');
  if (!Array.isArray(request.order) || request.order.some(name => typeof name !== 'string' || !name)
      || new Set(request.order).size !== request.order.length) fail('order', 'Expected unique bundle names.');
  // Detach caller-owned input before waiting on either queue.
  const order = [...request.order];
  const profile = ctx.profileContext;
  if (!profile?.dir) fail('capability', 'An official profile directory is required.');
  const snapshot = injected.snapshot ?? officialPort(ctx).snapshot;
  const withFileLock = injected.withFileLock ?? (await import('@deepseek-ai/dsh-atomic-write')).withFileLock;
  const saveManifest = injected.saveManifest ?? (await import('@deepseek-ai/dsh-plugin-manager/operations')).saveManifest;
  const hmr = ctx.get?.('hmr');
  if (typeof withFileLock !== 'function' || typeof saveManifest !== 'function'
      || hmr !== undefined && typeof hmr?.runExclusive !== 'function') {
    fail('capability', 'Official atomic save, file lock and optional HMR queue are required.');
  }
  let saved = false;
  const perform = () => withFileLock(join(profile.dir, 'package.json'), async () => {
    if (cancelled(signal)) return outcome(false, 'cancelled', 'interrupted');
    const current = await snapshot();
    if (cancelled(signal)) return outcome(false, 'cancelled', 'interrupted');
    if (current.stamp !== stamp) fail('stale', 'Profile changed after the catalog snapshot.');
    if (!Array.isArray(current.order) || new Set(current.order).size !== current.order.length
        || order.length !== current.order.length || order.some(name => !current.order.includes(name))) {
      fail('order', 'Ordering cannot add, remove, enable or disable bundles.');
    }
    for (const [index, name] of current.order.entries()) {
      const pkg = current.packages.find(item => item.name === name);
      if (!pkg || pkg.reason || pkg.enabled !== true || typeof pkg.readonly !== 'boolean') {
        fail('order', 'Selected bundle is missing, disabled or unsupported in the official catalog.');
      }
      if (pkg.readonly) {
        if (order[index] !== name) fail('protected', 'Protected bundle positions cannot change.');
        // Keep movable layers on the same side of each protected layer: even a
        // fixed index alone could let a later override cross its protection boundary.
        const before = new Set(current.order.slice(0, index));
        if (order.slice(0, index).some(item => !before.has(item))) fail('protected', 'Bundles cannot cross protected layers.');
      }
    }
    const manifest = JSON.parse(await readFile(join(profile.dir, 'package.json'), 'utf8'));
    if (!same(manifest.dsh?.profile?.bundles, current.order)) fail('stale', 'Manifest changed while validating order.');
    if (cancelled(signal)) return outcome(false, 'cancelled', 'interrupted');
    if (same(order, current.order)) return outcome(false, 'applied');
    // Resolve live helpers before commit; missing capabilities must not cause a partial save.
    let readProfilePatches, reconcileProfilePatches;
    if (hmr !== undefined) {
      if (!ctx.root) fail('capability', 'Live reconciliation requires the booted root context.');
      const boot = injected.readProfilePatches && injected.reconcileProfilePatches
        ? injected : await import('@deepseek-ai/dsh-app-boot');
      readProfilePatches = injected.readProfilePatches ?? boot.readProfilePatches;
      reconcileProfilePatches = injected.reconcileProfilePatches ?? boot.reconcileProfilePatches;
      if (typeof readProfilePatches !== 'function' || typeof reconcileProfilePatches !== 'function') {
        fail('capability', 'Official live reconciliation helpers are required.');
      }
    }
    if (cancelled(signal)) return outcome(false, 'cancelled', 'interrupted');
    const updated = { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: order } } };
    await saveManifest(profile.dir, updated);
    saved = true;
    // An abort cannot undo a committed manifest. Do not rollback or retry.
    if (cancelled(signal)) return outcome(true, 'cancelled', 'interrupted');
    if (hmr === undefined) return outcome(true, 'restart-required');
    try {
      const patches = await readProfilePatches('dsh', profile);
      if (cancelled(signal)) return outcome(true, 'cancelled', 'interrupted');
      const warnings = await reconcileProfilePatches(ctx.root, patches, 'dsh');
      return { ...outcome(true, 'applied'), ...(warnings?.length ? { warnings } : {}) };
    } catch {
      // Never expose arbitrary runtime diagnostics (possibly private configuration).
      return outcome(true, 'failed', 'application-failed');
    }
  });
  try {
    return await (typeof hmr?.runExclusive === 'function' ? hmr.runExclusive(perform) : perform());
  } catch (error) {
    if (!saved && ['stale', 'order', 'protected', 'capability'].includes(error?.code)) throw error;
    return outcome(saved, 'failed', saved ? 'application-failed' : 'save-failed');
  }
}
