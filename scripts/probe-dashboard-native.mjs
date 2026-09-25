/** Inspect the explicitly installed SDK fixture. No user Home or credentials are read. */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.DSH_DASHBOARD_SDK_ROOT;
if (!root) throw new Error('An explicit SDK fixture is required');
const require = createRequire(join(resolve(root), 'package.json'));
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-cmdline', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-client-modules']) {
  const entry = require.resolve(name);
  let directory = dirname(entry);
  while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory);
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== name) throw new Error('Wrong SDK identity');
  console.log('PACKAGE', name, pkg.version);
  const files = readdirSync(dirname(entry)).filter(file => /(?:rpc|index|context|scope|service|cmdline).*\.d\.ts$/.test(file));
  let budget = 20000;
  for (const file of files) {
    const text = readFileSync(join(dirname(entry), file), 'utf8').slice(0, budget);
    console.log('DECLARATION', name, file, text); budget -= text.length;
    if (budget <= 0) break;
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
await ctx.plugin({ name: 'dashboard-probe-consumer', apply(plugin) { plugin.boundProbe.inspect(); } });
console.log('Native seam inspection only, not installed-plugin acceptance.');
