/** Opt-in official DSH Web acceptance in a disposable Home; never prints launch tokens. */
import assert from 'node:assert/strict';
import { spawn, fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpaceMessageRouter } from '../src/adapters/node/message-bus/router.ts';
import { dshSessionCookie } from '../src/adapters/node/runtime/dsh-endpoint.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliEnv = process.env.DSH_WEB_CLI;
const artifactsEnv = process.env.DSH_WEB_ARTIFACT_DIR;
if (!cliEnv || !artifactsEnv) throw new Error('Set DSH_WEB_CLI to official dsh lib/bin.js and DSH_WEB_ARTIFACT_DIR to the packed Spaces tarball directory.');
const cli = cliEnv;
const artifacts = artifactsEnv;
const temp = mkdtempSync(join(tmpdir(), 'dsh-spaces-browser-web-'));
const home = join(temp, 'home');
const packDir = join(temp, 'artifacts');
const data = join(temp, 'pnpm-data');
const cache = join(temp, 'npm-cache');
for (const path of [home, packDir, data, cache]) mkdirSync(path, { recursive: true });
const env = { ...process.env, DSH_HOME: home, XDG_DATA_HOME: data, npm_config_cache: cache, npm_config_update_notifier: 'false' };
const router = new SpaceMessageRouter();
const children: ChildProcess[] = [];
const clean = (value: string): string => value.replace(/([?&]token=)[^\s&]+/gi, '$1[redacted]');

function command(bin: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(bin, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', fail);
    child.once('exit', code => code === 0 ? ok(stdout) : fail(new Error(`${bin} failed (${code}): ${clean(stderr).slice(-2000)}`)));
  });
}

async function makeProfile(id: string): Promise<void> {
  await command(process.execPath, [cli, '--profile', id, '--from-default-profile', 'web', '--dump-config']);
}
async function install(id: string, tgz: string): Promise<void> {
  await command(process.execPath, [cli, 'plugin', '--profile', id, 'add', tgz]);
}
function start(id: string, patch?: string): { child: ChildProcess; url: Promise<string>; stderr: () => string } {
  const viewEnv = {
    ...env, BROWSER_ACCEPT_TARGET: 'browser-accept', DSH_SPACES_VIEW_PARENT_ORIGIN: 'http://127.0.0.1:30999', DSH_SPACES_VIEW_ID: id,
    DSH_SPACES_VIEW_GENERATION: '1', DSH_SPACES_VIEW_CHANNEL: 'accept123',
    DSH_SPACES_VIEW_SERVICE_EPOCH: 'a'.repeat(64),
  };
  const child = fork(cli, ['--profile', id, ...(patch ? ['--patch', patch] : []), '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { env: viewEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  children.push(child); router.attach(id, child);
  let stdout = '', stderr = '';
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const url = new Promise<string>((ok, fail) => {
    let settled = false;
    const finish = (value: string | Error): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (typeof value === 'string') ok(value); else fail(value);
    };
    const timer = setTimeout(() => finish(new Error(`DSH ${id} startup timed out: ${clean(stderr)}`)), 20_000);
    const poll = (): void => {
      if (settled) return;
      const match = stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
      if (match) finish(match[1]!);
      else if (child.exitCode !== null || child.signalCode !== null) finish(new Error(`DSH ${id} exited: ${clean(stderr)}`));
      else setTimeout(poll, 30);
    };
    poll();
  });
  return { child, url, stderr: () => stderr };
}
function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => { child.off('exit', exited); fail(new Error('Owned DSH Host did not exit; disposable Home was retained.')); }, 5000);
    const exited = (): void => { clearTimeout(timer); ok(); };
    child.once('exit', exited);
    child.kill();
  });
}
function query(child: ChildProcess, message: Record<string, unknown>): Promise<any> {
  const id = crypto.randomUUID();
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => { child.off('message', receive); fail(new Error('Space request timed out')); }, 5000);
    const receive = (raw: any): void => {
      if (raw?.test !== 'browser-live-result' || raw.id !== id) return;
      clearTimeout(timer); child.off('message', receive); ok(raw);
    };
    child.on('message', receive);
    child.send({ test: 'browser-live-query', id, ...message });
  });
}
async function rpc(url: string, cookie: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  const origin = new URL(url).origin, rpcId = crypto.randomUUID();
  const response = await fetch(`${origin}/api/spacesBrowser/${method}`, {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: `spacesBrowser/${method}`, payload: { args } }),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json() as { rpcId: string; result: { ok: boolean; value?: unknown } };
  assert.equal(envelope.rpcId, rpcId); assert.equal(envelope.result.ok, true);
  return envelope.result.value;
}

try {
  const browserTgz = join(resolve(artifacts), 'dsh-spaces-browser-0.4.0.tgz');
  const bridgeTgz = join(resolve(artifacts), 'dsh-spaces-view-bridge-0.4.0.tgz');
  const callerName = (await command('npm', ['pack', join(root, 'tests/fixtures/browser-web-caller'), '--ignore-scripts', '--pack-destination', packDir])).trim().split('\n').at(-1)!;
  await Promise.all([makeProfile('browser-accept'), makeProfile('coding-accept')]);
  await install('browser-accept', bridgeTgz); await install('browser-accept', browserTgz);
  await install('coding-accept', bridgeTgz); await install('coding-accept', join(packDir, callerName));
  const caller = start('coding-accept'); await caller.url;
  let browser = start('browser-accept'); let browserUrl = await browser.url;
  assert.doesNotMatch(clean(browser.stderr()), /did not activate|TYPERT\.model/);
  assert.deepEqual((await query(caller.child, { kind: 'capabilities' })).value, []);
  assert.equal((await query(caller.child, { kind: 'request', operation: 'browser.listTabs', params: null })).error, 'unauthorized');
  await stop(browser.child);
  const patch = join(temp, 'browser-allow.patch.yml');
  writeFileSync(patch, '- id: dsh-spaces-browser\n  config:\n    allowedSpaces: [coding-accept]\n');
  browser = start('browser-accept', patch); browserUrl = await browser.url;
  assert.doesNotMatch(clean(browser.stderr()), /did not activate|TYPERT\.model/);
  const cookie = await dshSessionCookie(browserUrl, fetch, new AbortController().signal);
  assert.ok(cookie, 'official DSH must issue a session cookie');
  const htmlResponse = await fetch(new URL(browserUrl).origin + '/', { headers: { cookie } });
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  assert.ok(html.includes('__DSH_SPACES_VIEW__'), 'view hint was not injected');
  assert.ok(html.includes('@dsh-spaces/browser'), 'Browser client was not injected');
  const initial = await rpc(browserUrl, cookie, 'listTabs', {}) as any[];
  assert.equal(initial.length, 1); assert.equal(initial[0]?.url, null);
  const caps = await query(caller.child, { kind: 'capabilities' });
  assert.deepEqual(caps.value.map((item: { operation: string }) => item.operation), ['browser.listTabs', 'browser.openURL']);
  const opened = await query(caller.child, { kind: 'request', operation: 'browser.openURL', params: { url: 'https://example.org' } });
  assert.equal(opened.ok, true); assert.equal(opened.value.url, 'https://example.org/');
  const listed = await query(caller.child, { kind: 'request', operation: 'browser.listTabs', params: null });
  assert.equal(listed.ok, true); assert.deepEqual(listed.value.map((tab: { url: string | null }) => tab.url), [null, 'https://example.org/']);
  assert.deepEqual(await rpc(browserUrl, cookie, 'listTabs', {}), listed.value);
  console.log('PASS official DSH Web profiles, package activation, authenticated RPC, default deny, filtered capabilities, cross-Space openURL/listTabs');
  console.log('NOTE root election is covered by browser-space.test.ts; Chromium GUI is not exercised here.');
} finally {
  router.close();
  const settled = await Promise.allSettled(children.map(stop));
  const failures = settled.filter(result => result.status === 'rejected');
  if (failures.length > 0) {
    process.exitCode = 1;
    console.error('An owned DSH Host did not exit; disposable Home was retained for inspection.');
  } else rmSync(temp, { recursive: true, force: true });
}
