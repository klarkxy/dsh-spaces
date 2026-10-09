import { fail, plain, forbidden, parseJson } from './json.mjs';
export const PACKAGE = '@klarkxy/dsh-blueprint';
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const exactVersion = value => typeof value === 'string' && VERSION.test(value);
export function closed(value, keys, label) {
  if (!plain(value) || Object.keys(value).some(k => !keys.includes(k))) fail('shape', `Invalid ${label}.`);
}
export function text(value, label, max = 512) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f]/.test(value)) fail('field', `Invalid ${label}.`);
  return value;
}
export function array(value, label, max = 512) {
  if (!Array.isArray(value) || value.length > max) fail('field', `Invalid ${label}.`); return value;
}
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function validate(value) {
  // Also reject cycles, non-finite values, exotic objects and undefined before JSON conversion.
  function json(v, depth = 0) {
    if (depth > 64) fail('depth', 'Blueprint too deeply nested.');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))) return;
    if (!Array.isArray(v) && !plain(v)) fail('json', 'Blueprint must contain JSON data only.');
    if (Array.isArray(v) && Object.keys(v).length !== v.length) fail('json', 'Sparse or decorated arrays are not supported.');
    for (const [k, x] of Object.entries(v)) { if (forbidden(k)) fail('key', 'Unsafe object key.'); json(x, depth + 1); }
  }
  json(value); value = parseJson(JSON.stringify(value));
  if (!plain(value)) fail('shape', 'Invalid blueprint.');
  closed(value, ['kind', 'formatVersion', 'metadata', 'packages', 'bundles'], 'blueprint');
  if (value.kind !== 'dsh-blueprint' || value.formatVersion !== 2) fail('version', 'Expected dsh-blueprint v2.');
  closed(value.metadata, ['name', 'description'], 'metadata'); text(value.metadata.name, 'name', 120);
  if (value.metadata.description !== undefined) text(value.metadata.description, 'description', 4000);
  const names = new Set();
  for (const p of array(value.packages, 'packages', 128)) {
    closed(p, ['name', 'version', 'source'], 'package');
    if (typeof p.name !== 'string' || !NAME.test(p.name) || p.name.length > 214 || p.name === PACKAGE || names.has(p.name)) fail('package', 'Invalid, duplicate or self-referencing package.');
    if (!exactVersion(p.version) || !['npm', 'builtin'].includes(p.source)) fail('package', 'Packages require exact versions and known sources.');
    names.add(p.name);
  }
  const bundles = array(value.bundles, 'bundles', 128);
  if (new Set(bundles).size !== bundles.length || bundles.some(n => !names.has(n))) fail('bundle', 'Bundle order must reference unique selected packages.');
  return value;
}
