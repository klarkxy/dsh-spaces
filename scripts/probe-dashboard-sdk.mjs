/** Read only the explicitly named installed SDK packages, never a DSH Home or user configuration. */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const packages = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-atomic-write', '@deepseek-ai/dsh-host-webserver'];
for (const name of packages) {
  let entry;
  try { entry = require.resolve(name); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    console.log(JSON.stringify({ package: name, installed: false }));
    continue;
  }
  let root = dirname(entry);
  while (!existsSync(join(root, 'package.json'))) {
    const parent = dirname(root); if (parent === root) throw new Error('Package identity unavailable'); root = parent;
  }
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (metadata.name !== name) throw new Error('Unexpected package identity');
  console.log(JSON.stringify({ package: name, version: metadata.version, exports: metadata.exports, types: metadata.types }));
  const module = await import(name);
  console.log(JSON.stringify({ package: name, exportedNames: Object.keys(module), prototypes: Object.fromEntries(Object.entries(module).filter(([, value]) => typeof value === 'function' && value.prototype).map(([key, value]) => [key, Object.getOwnPropertyNames(value.prototype)])) }));
  // Bounded published declarations are needed to bind adapters to the installed version,
  // rather than assuming that upstream master describes the pinned alpha release.
  const dir = dirname(entry);
  const files = readdirSync(dir).filter(file => file.endsWith('.d.ts')).sort();
  let budget = 24000;
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const excerpt = text.slice(0, Math.min(text.length, budget));
    if (excerpt) console.log(`DECLARATION ${name}/${file}\n${excerpt}`);
    budget -= excerpt.length; if (budget <= 0) break;
  }
}
console.log('SDK inspection only; this is not plugin installation or P0 acceptance.');
