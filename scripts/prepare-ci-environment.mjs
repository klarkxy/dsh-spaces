import { appendFileSync } from 'node:fs';
import { createCheckEnvironment } from './check-all.mjs';

if (!process.env.GITHUB_ENV || !process.env.RUNNER_TEMP) throw new Error('This entry requires a GitHub Actions environment');
const isolated = createCheckEnvironment({ tempRoot: process.env.RUNNER_TEMP });
const keys = ['TMP', 'TEMP', 'TMPDIR', 'DSH_HOME', 'DSH_SPACES_HOME', 'DSH_SPACES_WEB_HOME',
  'npm_config_cache', 'npm_config_store_dir', 'pnpm_config_store_dir', 'pnpm_config_cache_dir'];
appendFileSync(process.env.GITHUB_ENV, keys.map(key => `${key}=${isolated.env[key]}\n`).join(''));
console.log('Prepared canonical temporary paths, an isolated DSH Home and package-manager caches.');
