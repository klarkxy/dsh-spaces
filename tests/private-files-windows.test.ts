import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { createPrivateFile, inspectPrivatePaths, readPrivateFile, verifyPrivateIdentity } from '../src/shared/node/private-files.ts';
import { HomeDashboardFileStore } from '../src/adapters/node/dashboard/file-store.ts';
import { writeDashboardBootstrap } from '../src/adapters/node/dashboard/bootstrap.ts';
import { readPublisherBootstrap } from '../packages/dashboard/src/host/home-publisher.ts';

const windows = process.platform === 'win32';
function fixture() { mkdirSync('.sandbox', { recursive: true }); return mkdtempSync(resolve('.sandbox/private-files-test-')); }
function put(root: string, name: string, content: string) {
  const path = join(root, name), created = createPrivateFile(root, path);
  try { writeFileSync(created.fd, content); } finally { closeSync(created.fd); }
  return path;
}
const bootstrap = { protocolVersion: 1 as const, origin: 'http://127.0.0.1:12345', runId: 'test-run', bearer: 'a'.repeat(64) };

// Test-only, fixed program. The fixtures are repository-local; never change a real Home ACL.
function acl(path: string, operation: 'read' | 'broaden' | 'null-dacl' | 'wrong-owner' = 'read'): string {
  assert.ok(resolve(path).startsWith(resolve('.sandbox') + '\\'));
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$r = [Console]::In.ReadToEnd() | ConvertFrom-Json
function ReadAcl { if ([System.IO.Directory]::Exists($r.path)) { return [System.IO.Directory]::GetAccessControl($r.path) }; return [System.IO.File]::GetAccessControl($r.path) }
function WriteAcl($security) { if ([System.IO.Directory]::Exists($r.path)) { [System.IO.Directory]::SetAccessControl($r.path, $security) } else { [System.IO.File]::SetAccessControl($r.path, $security) } }
$acl = ReadAcl
if ($r.operation -eq 'broaden') {
  $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'ReadAndExecute', 'Allow')
  $acl.AddAccessRule($rule)
  WriteAcl $acl
} elseif ($r.operation -eq 'null-dacl') {
  $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
  $raw.DiscretionaryAcl = $null
  $bytes = New-Object byte[] $raw.BinaryLength
  $raw.GetBinaryForm($bytes, 0)
  $acl.SetSecurityDescriptorBinaryForm($bytes, [System.Security.AccessControl.AccessControlSections]::Access)
  WriteAcl $acl
} elseif ($r.operation -eq 'wrong-owner') {
  $acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  try { WriteAcl $acl }
  catch {
    $cause = $_.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    if ($cause -is [System.InvalidOperationException] -or $cause -is [System.UnauthorizedAccessException] -or $cause -is [System.Security.AccessControl.PrivilegeNotHeldException]) {
      [Console]::Out.Write('owner-fixture-unavailable'); exit 0
    }
    throw
  }
}
[Console]::Out.Write((ReadAcl).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All))
`;
  const result = spawnSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: JSON.stringify({ path, operation }), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout;
}

test('private file creation, bounded reads and descriptor identity work on the real platform', t => {
  const base = fixture(); try {
    const root = join(base, 'new', "私有 ' literal $path"); const start = performance.now();
    const path = put(root, 'payload.json', '{"ok":true}'); const createdMs = performance.now() - start;
    const readStart = performance.now(); assert.equal(readPrivateFile(root, path, 64)?.toString(), '{"ok":true}');
    t.diagnostic(`platform=${process.platform}; private create=${createdMs.toFixed(1)}ms; checked read=${(performance.now() - readStart).toFixed(1)}ms`);
    assert.throws(() => readPrivateFile(root, path, 2), /limit-exceeded/);
    const identity = statSync(path, { bigint: true }); renameSync(path, join(root, 'old.json')); put(root, 'payload.json', 'replacement');
    assert.throws(() => verifyPrivateIdentity(path, identity));
    if (windows) {
      assert.match(acl(root), /D:P/); assert.match(acl(path), /D:P/);
      assert.doesNotMatch(acl(path), /;;;(?:WD|BU|AU|BA|SY)\)/);
    } else { assert.equal(statSync(root).mode & 0o777, 0o700); assert.equal(statSync(path).mode & 0o777, 0o600); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('read-only discovery never creates absent roots and rejected existing roots remain unchanged', async () => {
  const base = fixture(); try {
    const missing = join(base, 'missing'); assert.equal(readPrivateFile(missing, join(missing, 'file'), 12), null); assert.equal(existsSync(missing), false);
    const broad = join(base, 'broad'); mkdirSync(broad, { mode: 0o755 });
    if (windows) acl(broad, 'broaden'); else chmodSync(broad, 0o755);
    const before = windows ? acl(broad) : statSync(broad).mode;
    await assert.rejects(async () => {
      const store = new HomeDashboardFileStore(broad, () => {});
      try { await store.readPolicies(); } finally { await store.close(); }
    });
    assert.throws(() => writeDashboardBootstrap(broad, bootstrap, () => {}));
    assert.equal(windows ? acl(broad) : statSync(broad).mode, before); assert.deepEqual(readdirSync(broad), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('Windows broadened leaf ACL denies read, write, delete and bootstrap consumption without repair', { skip: !windows }, async () => {
  const base = fixture(); try {
    const root = join(base, 'private'), store = new HomeDashboardFileStore(root, () => {});
    await store.writePolicies({ schemaVersion: 1, policies: [] });
    const policyPath = join(root, 'policies.json'), before = readFileSync(policyPath), descriptor = acl(policyPath, 'broaden');
    await assert.rejects(store.readPolicies()); await assert.rejects(store.writePolicies({ schemaVersion: 1, policies: [] }));
    assert.deepEqual(readFileSync(policyPath), before); assert.equal(acl(policyPath), descriptor); assert.deepEqual(readdirSync(root), ['policies.json']);
    const projectionPath = put(root, `projection-${createHash('sha256').update(JSON.stringify(['space', 'provider'])).digest('hex')}.json`, '{"keep":true}');
    const projectionAcl = acl(projectionPath, 'broaden');
    await assert.rejects(store.deleteProjection('space', 'provider'));
    assert.equal(readFileSync(projectionPath, 'utf8'), '{"keep":true}'); assert.equal(acl(projectionPath), projectionAcl);
    const credential = writeDashboardBootstrap(join(base, 'bootstrap'), bootstrap, () => {});
    const credentialBytes = readFileSync(credential.path), credentialAcl = acl(credential.path, 'broaden');
    assert.throws(() => readPublisherBootstrap(credential.path)); assert.throws(() => credential.dispose());
    assert.deepEqual(readFileSync(credential.path), credentialBytes); assert.equal(acl(credential.path), credentialAcl);
    await store.close();
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('Windows null DACL is rejected and retained', { skip: !windows }, () => {
  const base = fixture(); try {
    const root = join(base, 'private'), path = put(root, 'payload', 'keep');
    const descriptor = acl(path, 'null-dacl');
    // .NET Framework can serialize a null DACL by omitting the D: section entirely.
    assert.ok(!descriptor.includes('D:') || descriptor.includes('NO_ACCESS_CONTROL'));
    assert.throws(() => readPrivateFile(root, path, 20));
    assert.equal(acl(path), descriptor); assert.equal(readFileSync(path, 'utf8'), 'keep');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('Windows owner SID must match the running user even when that user retains file access', { skip: !windows }, t => {
  const base = fixture(); try {
    const root = join(base, 'private'), path = put(root, 'payload', 'keep');
    const descriptor = acl(path, 'wrong-owner');
    if (descriptor === 'owner-fixture-unavailable') { t.skip('Current Windows token cannot assign a foreign owner; requires an elevated fixture identity'); return; }
    assert.match(descriptor, /^O:BA/);
    assert.throws(() => readPrivateFile(root, path, 20));
    assert.equal(acl(path), descriptor); assert.equal(readFileSync(path, 'utf8'), 'keep');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('private creation is exclusive and rejects a mismatched open descriptor', () => {
  const base = fixture(); try {
    const root = join(base, 'private'), path = put(root, 'payload', 'keep');
    assert.throws(() => createPrivateFile(root, path)); assert.equal(readFileSync(path, 'utf8'), 'keep');
    const other = createPrivateFile(root, join(root, 'other'));
    try { assert.throws(() => verifyPrivateIdentity(path, statSync(path, { bigint: true }), other.fd)); }
    finally { closeSync(other.fd); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('junction or symlink ancestors and hardlinked files are rejected without changing targets', () => {
  const base = fixture(); try {
    const root = join(base, 'private'), path = put(root, 'payload', 'keep');
    const linked = join(base, 'linked'); symlinkSync(root, linked, windows ? 'junction' : 'dir');
    assert.throws(() => inspectPrivatePaths(join(linked, 'absent')));
    assert.throws(() => createPrivateFile(join(linked, 'absent'), join(linked, 'absent', 'payload')));
    assert.throws(() => readPrivateFile(linked, join(linked, 'payload'), 20));
    const hardlink = join(root, 'other'); linkSync(path, hardlink);
    assert.throws(() => readPrivateFile(root, path, 20)); assert.throws(() => readPrivateFile(root, hardlink, 20));
    assert.equal(readFileSync(path, 'utf8'), 'keep'); assert.equal(existsSync(join(root, 'absent')), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('bootstrap malformed JSON, unknown fields, non-loopback origins and oversized files fail unchanged', () => {
  const base = fixture(); try {
    const root = join(base, 'private');
    for (const [index, bytes] of ['{bad', JSON.stringify({ ...bootstrap, unexpected: true }), JSON.stringify({ ...bootstrap, origin: 'http://example.com:80' }), 'x'.repeat(8193)].entries()) {
      const path = put(root, `${index}.json`, bytes); assert.throws(() => readPublisherBootstrap(path)); assert.equal(readFileSync(path, 'utf8'), bytes);
    }
    assert.throws(() => readPublisherBootstrap(join(root, 'missing.json')));
    if (windows) assert.throws(() => readPublisherBootstrap(join(root, '0.json:stream')));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('bootstrap disposal refuses a replaced credential and owner loss blocks commits', async () => {
  const base = fixture(); try {
    const credential = writeDashboardBootstrap(join(base, 'bootstrap'), bootstrap, () => {});
    renameSync(credential.path, join(dirname(credential.path), 'saved.json')); put(dirname(credential.path), credential.path.split(/[\\/]/).at(-1)!, 'replacement');
    assert.throws(() => credential.dispose()); assert.equal(readFileSync(credential.path, 'utf8'), 'replacement');
    let owned = true; const root = join(base, 'store');
    const store = new HomeDashboardFileStore(root, () => { if (!owned) throw new Error('lost owner'); });
    owned = false; await assert.rejects(store.writePolicies({ schemaVersion: 1, policies: [] }), /lost owner/); assert.equal(existsSync(root), false);
    await store.close();
  } finally { rmSync(base, { recursive: true, force: true }); }
});
