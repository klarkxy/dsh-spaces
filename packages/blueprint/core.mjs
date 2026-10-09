import { decode, encode, fail } from './codec.mjs';
import { validate, closed, array, text } from './blueprint.mjs';
export { validate } from './blueprint.mjs';

/** Protocol operations require neither a profile nor an interface. */
export function parseBlueprint(code) { return validate(decode(code)); }
export function encodeBlueprint(document) { return { code: encode(validate(document)) }; }

/** Read-only profile operations. Installation and merge decisions belong to the Agent. */
export class BlueprintCore {
  constructor(port) { this.port = port; }
  async catalog(signal) {
    signal?.throwIfAborted();
    const snapshot = await this.port.snapshot();
    signal?.throwIfAborted();
    return { packages: snapshot.packages, order: snapshot.order, stamp: snapshot.stamp };
  }
  async generate(request, signal) {
    closed(request, ['packages', 'name'], 'export request');
    const selection = array(request.packages, 'selected packages', 128).map(n => text(n, 'package'));
    if (new Set(selection).size !== selection.length) fail('package', 'Duplicate selected package.');
    const snapshot = await this.catalog(signal);
    const packages = selection.map(name => {
      const p = snapshot.packages.find(p => p.name === name);
      if (!p || p.readonly || !p.source || p.reason) fail('package', 'Cannot export ' + name + '; inspect its status in the plugin manager.');
      return { name, version: p.version, source: p.source };
    });
    return encodeBlueprint({ kind: 'dsh-blueprint', formatVersion: 2,
      metadata: { name: text(request.name, 'name', 120) }, packages,
      bundles: selection.filter(name => snapshot.order.includes(name)) });
  }
}
