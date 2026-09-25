/** Inspect only source files in the explicitly installed SDK fixture. */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.DSH_DASHBOARD_SDK_ROOT;
if (!root) throw new Error('An explicit SDK fixture is required');
const require = createRequire(join(resolve(root), 'package.json'));
for (const [name, files] of [
  ['@deepseek-ai/cordis', ['src/context.ts', 'src/scope.ts']],
  ['@deepseek-ai/dsh-client-connection', ['src/rpc.ts', 'src/rpc-host.ts']],
  ['@deepseek-ai/dsh-cmdline', ['src/index.ts']],
  ['@deepseek-ai/dsh-storage-domain', []],
  ['@deepseek-ai/dsh-client-modules', ['package.json']],
]) {
  const entry = require.resolve(name);
  let directory = dirname(entry);
  while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory);
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== name) throw new Error('Wrong SDK identity');
  console.log('PACKAGE', name, pkg.version, JSON.stringify(pkg.exports));
  for (const file of files) {
    if (existsSync(join(directory, file))) console.log('SOURCE', name, file, readFileSync(join(directory, file), 'utf8').slice(0, 22000));
  }
}
const { Context, Service } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const ctx = new Context();
class BoundProbe extends Service {
  constructor(ctx) { super(ctx, 'boundProbe'); }
  inspect() {
    const scope = this.ctx.scope;
    console.log('CALLER_SCOPE', Object.keys(scope), 'uid', scope.uid, 'runtimeName', scope.runtime?.name, 'runtimeKeys', Object.keys(scope.runtime ?? {}));
    return scope;
  }
}
await ctx.plugin(BoundProbe);
await ctx.plugin({ name: 'dashboard-probe-consumer', inject: ['boundProbe'], apply(plugin) { plugin.boundProbe.inspect(); } });
console.log('Native seam inspection only, not installed-plugin acceptance.');
