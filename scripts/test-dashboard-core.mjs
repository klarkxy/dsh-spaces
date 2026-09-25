/** Self-contained domain tests. Does not install/run DSH or access any Home. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// Explicit override is for a preinstalled compiler in offline test environments, never production discovery.
const compiler = process.env.DSH_DASHBOARD_TSC ?? require.resolve('typescript/bin/tsc');
mkdirSync(join(root, '.sandbox'), { recursive: true });
const temporary = mkdtempSync(join(root, '.sandbox/dashboard-core-'));
let status = 1;
try {
  const build = join(temporary, 'build');
  const compile = spawnSync(process.execPath, [compiler, '-p', join(root, 'tsconfig.dashboard.json'), '--noEmit', 'false', '--outDir', build], { cwd: root, stdio: 'inherit' });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) status = compile.status ?? 1;
  else {
    writeFileSync(join(build, 'package.json'), '{"type":"commonjs"}\n');
    const test = spawnSync(process.execPath, ['--test', join(root, 'tests/dashboard-core.test.cjs')], {
      cwd: root, stdio: 'inherit', env: { ...process.env, DSH_DASHBOARD_TEST_BUILD: build },
    });
    if (test.error) throw test.error;
    status = test.status ?? 1;
  }
} finally {
  // Only this invocation's mkdtemp directory is ours to remove.
  rmSync(temporary, { recursive: true, force: true });
}
process.exitCode = status;
