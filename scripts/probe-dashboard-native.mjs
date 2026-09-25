/** Read installed SDK declarations and test contextual service binding; no user Home. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.DSH_DASHBOARD_SDK_ROOT;
if (!root) throw new Error('An explicit SDK fixture is required');
const require = createRequire(join(resolve(root), 'package.json'));
for (const [name, files] of [
  ['@deepseek-ai/cordis', ['fiber.d.ts', 'service.d.ts']],
  ['@deepseek-ai/dsh-client-connection', ['rpc.d.ts', 'rpc-host.d.ts']],
  ['@deepseek-ai/dsh-cmdline', ['index.d.ts']],
  ['@deepseek-ai/dsh-credentials', ['index.d.ts']],
]) {
  const entry = require.resolve(name);
  let directory = dirname(entry);
  while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory);
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== name) throw new Error('Wrong SDK identity');
  console.log('PACKAGE', name, pkg.version);
  const types = dirname(join(directory, pkg.exports['.'].types));
  for (const file of files) if (existsSync(join(types, file))) console.log('DECLARATION', name, file, readFileSync(join(types, file), 'utf8').slice(0, 18000));
}
const { Context, Service } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const ctx = new Context();
class BoundProbe extends Service {
  constructor(ctx) { super(ctx, 'boundProbe'); }
  inspect() { return this.ctx.fiber.name; }
}
await ctx.plugin(BoundProbe);
await ctx.plugin({ name: 'dashboard-probe-consumer', inject: ['boundProbe'], apply(plugin) {
  assert.equal(plugin.boundProbe.inspect(), plugin.fiber.name);
  assert.equal(plugin.fiber.name, 'dashboard-probe-consumer');
  console.log('PASS contextual caller identity', plugin.fiber.name);
} });
console.log('Native seam inspection only, not installed-plugin acceptance.');
