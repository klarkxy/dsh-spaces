import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

/** This boundary excludes malicious processes running as the same user and OS administrators.
 * No ACL repair, identity cache, retries, or alternate implementation on failure. */
export class PrivateFileError extends Error {
  constructor(readonly reason: 'unsafe' | 'limit-exceeded' = 'unsafe') { super(`Private file ${reason}`); }
}

// Fixed program, embedded in every bundle. Only paths/operation flags travel through stdin;
// file contents and credentials never enter PowerShell arguments, output, or diagnostics.
const windowsOperation = String.raw`
function Invoke-PrivatePathRequest($request) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  function Attributes([string] $path) {
    try { return [System.IO.File]::GetAttributes($path) }
    catch {
      $cause = $_.Exception
      while ($cause.InnerException) { $cause = $cause.InnerException }
      if ($cause -is [System.IO.FileNotFoundException] -or $cause -is [System.IO.DirectoryNotFoundException]) { return $null }
      throw
    }
  }
  function Check([string] $path, [bool] $directory, [bool] $private) {
    $attributes = Attributes $path
    if ($null -eq $attributes) { return $false }
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
    if ((($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) -ne $directory) { throw 'unsafe' }
    if ($private) {
      if ($directory) { $acl = [System.IO.Directory]::GetAccessControl($path) }
      else { $acl = [System.IO.File]::GetAccessControl($path) }
      if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unsafe' }
      $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
      if ($null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -eq 0) { throw 'unsafe' }
      $ownerAllowed = $false
      foreach ($ace in $raw.DiscretionaryAcl) {
        # Reject callback/object/unknown ACEs rather than guessing their effective access.
        if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback) { throw 'unsafe' }
        if ($ace.AceQualifier -eq [System.Security.AccessControl.AceQualifier]::AccessAllowed) {
          if ($ace.SecurityIdentifier.Value -ne $sid.Value) { throw 'unsafe' }
          if (([int] $ace.AceFlags -band [int] [System.Security.AccessControl.AceFlags]::InheritOnly) -eq 0 -and $ace.AccessMask -ne 0) { $ownerAllowed = $true }
        } elseif ($ace.AceQualifier -ne [System.Security.AccessControl.AceQualifier]::AccessDenied) { throw 'unsafe' }
      }
      if (-not $ownerAllowed) { throw 'unsafe' }
    }
    return $true
  }
  $missing = New-Object 'System.Collections.Generic.List[string]'
  $ancestor = [string] $request.directory
  while ($ancestor) {
    if (-not (Check $ancestor $true ($ancestor -eq $request.directory))) { $missing.Add($ancestor) }
    $ancestor = [System.IO.Path]::GetDirectoryName($ancestor)
  }
  # Validate every pre-existing target before creating anything.
  foreach ($file in $request.files) { $null = Check $file $false $true }
  if ($request.createDirectory) {
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetOwner($sid)
    $security.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $security.AddAccessRule($rule)
    for ($i = $missing.Count - 1; $i -ge 0; $i--) {
      # Create with the restrictive descriptor; never create then tighten an inherited ACL.
      $info = New-Object System.IO.DirectoryInfo($missing[$i])
      $info.Create($security)
      $null = Check $missing[$i] $true $true
    }
  }
  if ($request.createFile) {
    $security = New-Object System.Security.AccessControl.FileSecurity
    $security.SetOwner($sid)
    $security.SetAccessRuleProtection($true, $false)
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
    $stream = New-Object System.IO.FileStream([string] $request.createFile, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $security)
    $stream.Dispose()
    $null = Check $request.createFile $false $true
  }
}
`;
const windowsScript = windowsOperation + String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Invoke-PrivatePathRequest ([Console]::In.ReadToEnd() | ConvertFrom-Json)
  [Console]::Out.Write('private-files-ok')
} catch { [Console]::Error.Write('Private file boundary rejected'); exit 1 }
`;
const windowsHelperScript = windowsOperation + String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  [Console]::Out.WriteLine('{"ready":1}')
  [Console]::Out.Flush()
  while ($true) {
    $line = New-Object System.Text.StringBuilder
    while ($true) {
      $char = [Console]::In.Read()
      if ($char -eq -1) { if ($line.Length -eq 0) { exit 0 }; throw 'truncated input' }
      if ($char -eq 10) { break }
      if ($line.Length -ge 65536) { throw 'input limit' }
      $null = $line.Append([char] $char)
    }
    $request = $line.ToString() | ConvertFrom-Json
    $keys = @($request.PSObject.Properties.Name)
    if ($keys.Count -ne 5) { throw 'invalid input' }
    foreach ($key in $keys) { if ($key -notin @('id', 'directory', 'files', 'createDirectory', 'createFile')) { throw 'invalid input' } }
    if ($request.id -isnot [int] -and $request.id -isnot [long]) { throw 'invalid id' }
    if ($request.id -lt 1 -or $request.directory -isnot [string] -or $request.files -isnot [array] -or $request.files.Count -gt 32 -or $request.createDirectory -isnot [bool]) { throw 'invalid input' }
    foreach ($file in $request.files) { if ($file -isnot [string]) { throw 'invalid input' } }
    if ($null -ne $request.createFile -and $request.createFile -isnot [string]) { throw 'invalid input' }
    $ok = 'true'
    try { Invoke-PrivatePathRequest $request } catch { $ok = 'false' }
    [Console]::Out.WriteLine('{"id":' + $request.id + ',"ok":' + $ok + '}')
    [Console]::Out.Flush()
  }
} catch { [Console]::Error.Write('Private file helper failed'); exit 1 }
`;

function windowsCommand(script: string): { file: string; args: string[] } {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:\\[^:]+$/i.test(systemRoot)) throw new PrivateFileError();
  return { file: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}


function validatePaths(directory: string, files: string[]): void {
  if (!isAbsolute(directory) || resolve(directory) !== directory || directory === parse(directory).root) throw new PrivateFileError();
  for (const file of files) if (!isAbsolute(file) || resolve(file) !== file || dirname(file) !== directory) throw new PrivateFileError();
  // No UNC/device namespaces or NTFS alternate data streams in private storage.
  if (process.platform === 'win32') for (const path of [directory, ...files]) {
    if (!/^[a-z]:\\/i.test(path) || path.slice(2).includes(':') || path.split('\\').some(part => /[. ]$/.test(part))) throw new PrivateFileError();
  }
}

function existing(path: string): BigIntStats | null {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function checkStat(stat: BigIntStats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) throw new PrivateFileError();
  if (process.platform !== 'win32' && (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n)) throw new PrivateFileError();
}
/** Cheap structural checks used again immediately before committing an operation. */
export function verifyPrivateIdentity(path: string, identity: BigIntStats, fd?: number): void {
  const current = lstatSync(path, { bigint: true });
  checkStat(current, identity.isDirectory());
  if (current.dev !== identity.dev || current.ino !== identity.ino) throw new PrivateFileError();
  if (fd !== undefined) {
    const opened = fstatSync(fd, { bigint: true }); checkStat(opened, false);
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw new PrivateFileError();
  }
}
function ancestors(directory: string): void {
  for (let path = directory;; path = dirname(path)) {
    const stat = existing(path);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new PrivateFileError();
    if (dirname(path) === path) break;
  }
}

/** Structural checks do not launch a helper or create paths. */
export function inspectPrivatePathStructure(directory: string, files: string[] = [], createFile?: string): Map<string, BigIntStats> {
  validatePaths(directory, [...files, ...(createFile ? [createFile] : [])]);
  ancestors(directory);
  const before = new Map<string, BigIntStats>();
  for (const path of [directory, ...files]) {
    const stat = existing(path);
    if (stat) { checkStat(stat, path === directory); before.set(path, stat); }
  }
  return before;
}
function completeInspection(directory: string, files: string[], before: Map<string, BigIntStats>): void {
  ancestors(directory);
  for (const [path, stat] of before) verifyPrivateIdentity(path, stat);
  for (const path of [directory, ...files]) { const stat = existing(path); if (stat) checkStat(stat, path === directory); }
}

/** One-off synchronous launch handoff only. Repeated store operations use PrivateFileAccess. */
export function inspectPrivatePaths(directory: string, files: string[] = [], createDirectory = false, createFile?: string): void {
  const before = inspectPrivatePathStructure(directory, files, createFile);
  if (process.platform === 'win32') {
    const command = windowsCommand(windowsScript);
    const result = spawnSync(command.file, command.args,
      { input: JSON.stringify({ directory, files, createDirectory, createFile: createFile ?? null }), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    if (result.error || result.status !== 0 || result.stdout !== 'private-files-ok') throw new PrivateFileError();
  } else if (createDirectory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  completeInspection(directory, files, before);
}

/** The creation operation is exclusive on both platforms, with a private ACL/mode from birth. */
export function createPrivateFile(directory: string, path: string, targets: string[] = []): { fd: number; identity: BigIntStats; directoryIdentity: BigIntStats } {
  validatePaths(directory, [path, ...targets]);
  inspectPrivatePaths(directory, targets, true, process.platform === 'win32' ? path : undefined);
  return openCreatedPrivateFile(directory, path);
}
function openCreatedPrivateFile(directory: string, path: string): { fd: number; identity: BigIntStats; directoryIdentity: BigIntStats } {
  const directoryIdentity = lstatSync(directory, { bigint: true });
  const identity = process.platform === 'win32' ? lstatSync(path, { bigint: true }) : undefined;
  const fd = openSync(path, constants.O_WRONLY | (process.platform === 'win32' ? 0 : constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW), 0o600);
  try {
    const opened = fstatSync(fd, { bigint: true }); checkStat(opened, false);
    verifyPrivateIdentity(path, identity ?? opened, fd);
    verifyPrivateIdentity(directory, directoryIdentity);
    return { fd, identity: opened, directoryIdentity };
  } catch (error) { closeSync(fd); throw error; }
}

export function readPrivateFile(directory: string, path: string, maximum: number): Buffer | null {
  inspectPrivatePaths(directory, [path]);
  return readCheckedPrivateFile(directory, path, maximum);
}
function readCheckedPrivateFile(directory: string, path: string, maximum: number): Buffer | null {
  const identity = existing(path); if (!identity) return null;
  const directoryIdentity = lstatSync(directory, { bigint: true });
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    verifyPrivateIdentity(path, identity, fd);
    if (fstatSync(fd, { bigint: true }).size > BigInt(maximum)) throw new PrivateFileError('limit-exceeded');
    const chunks: Buffer[] = []; let length = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, maximum + 1 - length));
      const count = readSync(fd, chunk); if (!count) break;
      length += count; if (length > maximum) throw new PrivateFileError('limit-exceeded');
      chunks.push(chunk.subarray(0, count));
    }
    verifyPrivateIdentity(path, identity, fd); verifyPrivateIdentity(directory, directoryIdentity);
    return Buffer.concat(chunks, length);
  } finally { closeSync(fd); }
}

export function flushPrivateDirectory(directory: string): void {
  // Windows Node cannot open/flush directory handles. File fsync and atomic rename remain;
  // directory metadata durability across power loss is not promised on that platform.
  if (process.platform === 'win32') return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

interface PrivatePathRequest { directory: string; files: string[]; createDirectory: boolean; createFile: string | null }
interface HelperPending { id: number; line: string; sent: boolean; timer: ReturnType<typeof setTimeout>; resolve(): void; reject(error: Error): void }
/** The only override is an internal test seam for subprocess/protocol faults, not product configuration. */
interface HelperTestOptions { launch?: () => ChildProcessWithoutNullStreams; requestTimeoutMs?: number; closeTimeoutMs?: number }

/** One store-owned, lazy process. Every request checks current ACLs; failure never launches another. */
export class WindowsPrivateFileHelper {
  private state: 'new' | 'starting' | 'ready' | 'failed' | 'closed' = 'new';
  private child: ChildProcessWithoutNullStreams | null = null;
  private childClosed = false;
  private nextId = 1;
  private pending = new Map<number, HelperPending>();
  private queue: HelperPending[] = [];
  private output = Buffer.alloc(0);
  private stderrBytes = 0;
  private backpressured = false;
  private closeResult: Promise<void> | null = null;
  private stopResult: Promise<void> | null = null;
  constructor(private readonly test: HelperTestOptions = {}) {}
  get status() { return this.state; }
  request(request: PrivatePathRequest): Promise<void> {
    if (this.state === 'failed' || this.state === 'closed') return Promise.reject(new PrivateFileError());
    if (this.pending.size >= 32 || this.nextId >= Number.MAX_SAFE_INTEGER) return Promise.reject(new PrivateFileError('limit-exceeded'));
    if (!Array.isArray(request.files) || request.files.length > 32 || typeof request.createDirectory !== 'boolean') return Promise.reject(new PrivateFileError());
    try { validatePaths(request.directory, [...request.files, ...(request.createFile === null ? [] : [request.createFile])]); }
    catch { return Promise.reject(new PrivateFileError()); }
    const id = this.nextId++;
    const line = JSON.stringify({ id, directory: request.directory, files: request.files, createDirectory: request.createDirectory, createFile: request.createFile }) + '\n';
    if (Buffer.byteLength(line) > 65536) return Promise.reject(new PrivateFileError('limit-exceeded'));
    return new Promise<void>((resolve, reject) => {
      // Starts before startup/queueing: there is no unbounded wait behind other requests.
      const timer = setTimeout(() => this.fail(), this.test.requestTimeoutMs ?? 5000);
      const pending = { id, line, sent: false, timer, resolve, reject };
      this.pending.set(id, pending); this.queue.push(pending);
      if (this.state === 'new') this.start();
      this.drain();
    });
  }
  private start(): void {
    this.state = 'starting';
    try {
      const launch = this.test.launch ?? (() => {
        const command = windowsCommand(windowsHelperScript);
        return spawn(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      });
      const child = this.child = launch();
      child.on('error', () => this.fail());
      child.once('exit', () => { if (this.state !== 'closed') this.fail(); });
      child.once('close', () => { this.childClosed = true; if (this.state !== 'closed') this.fail(); });
      child.stdin.on('error', () => this.fail());
      child.stdin.on('drain', () => { this.backpressured = false; this.drain(); });
      child.stdout.on('error', () => this.fail());
      child.stderr.on('error', () => this.fail());
      child.stdout.on('data', (data: Buffer) => this.receive(data));
      child.stderr.on('data', (data: Buffer) => { this.stderrBytes += data.length; if (this.stderrBytes > 65536) this.fail(); });
    } catch { this.fail(); }
  }
  private drain(): void {
    if (this.state !== 'ready' || this.backpressured || !this.child) return;
    while (this.queue.length && this.state === 'ready' && !this.backpressured) {
      const pending = this.queue.shift()!; pending.sent = true;
      try { this.backpressured = !this.child.stdin.write(pending.line, error => { if (error) this.fail(); }); }
      catch { this.fail(); }
    }
  }
  private receive(data: Buffer): void {
    if (this.state === 'closed' || this.state === 'failed') return;
    // At most 32 small replies can be pending. Never retain an unbounded partial line.
    if (this.output.length + data.length > 4096) { this.fail(); return; }
    this.output = Buffer.concat([this.output, data]);
    for (;;) {
      const end = this.output.indexOf(10);
      if (end < 0) { if (this.output.length > 128) this.fail(); return; }
      if (end > 128) { this.fail(); return; }
      const line = this.output.subarray(0, end).toString('utf8'); this.output = this.output.subarray(end + 1);
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); }
      catch { this.fail(); return; }
      if (!row || typeof row !== 'object' || Array.isArray(row)) { this.fail(); return; }
      if (JSON.stringify(row) !== line.replace(/\r$/, '')) { this.fail(); return; }
      const keys = Object.keys(row);
      if (this.state === 'starting') {
        if (keys.length !== 1 || row.ready !== 1) { this.fail(); return; }
        this.state = 'ready'; this.drain();
      } else {
        if (keys.length !== 2 || !keys.includes('id') || !keys.includes('ok') || !Number.isSafeInteger(row.id) || typeof row.ok !== 'boolean') { this.fail(); return; }
        const pending = this.pending.get(row.id as number);
        if (!pending?.sent) { this.fail(); return; }
        clearTimeout(pending.timer); this.pending.delete(pending.id);
        if (row.ok) pending.resolve(); else pending.reject(new PrivateFileError());
      }
    }
  }
  private rejectPending(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new PrivateFileError()); }
    this.pending.clear(); this.queue = []; this.output = Buffer.alloc(0);
  }
  private fail(): void {
    if (this.state === 'failed' || this.state === 'closed') return;
    this.state = 'failed'; this.rejectPending();
    // A corrupted/dead helper is terminal. Kill the exact child; never relaunch or replay.
    void this.stop(true).catch(() => {});
  }
  private stop(force: boolean): Promise<void> {
    if (this.stopResult) return this.stopResult;
    const child = this.child;
    if (!child || this.childClosed) return this.stopResult = Promise.resolve();
    this.stopResult = new Promise<void>((resolve, reject) => {
      let killed = false;
      const kill = () => { if (!killed && !this.childClosed && child.exitCode === null && child.signalCode === null) { killed = true; try { child.kill('SIGKILL'); } catch {} } };
      const grace = setTimeout(kill, Math.min(250, this.test.closeTimeoutMs ?? 2000));
      const deadline = setTimeout(() => { cleanup(); reject(new PrivateFileError()); }, this.test.closeTimeoutMs ?? 2000);
      const done = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(grace); clearTimeout(deadline); child.off('close', done); };
      child.once('close', done);
      if (force) kill();
      try { child.stdin.end(); } catch { kill(); }
    });
    return this.stopResult;
  }
  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    this.state = 'closed'; this.rejectPending();
    return this.closeResult = this.stop(false);
  }
}

/** Node-side identities surround every asynchronous ACL operation, inside the caller's owner lease. */
export class PrivateFileAccess {
  private helper = process.platform === 'win32' ? new WindowsPrivateFileHelper() : null;
  constructor(private readonly guard: () => void) {}
  async inspect(directory: string, files: string[] = [], createDirectory = false, createFile?: string): Promise<void> {
    this.guard(); const before = inspectPrivatePathStructure(directory, files, createFile);
    if (this.helper) {
      await this.helper.request({ directory, files, createDirectory, createFile: createFile ?? null });
      this.guard();
    } else if (createDirectory) mkdirSync(directory, { recursive: true, mode: 0o700 });
    completeInspection(directory, files, before); this.guard();
  }
  async create(directory: string, path: string, targets: string[] = []): Promise<{ fd: number; identity: BigIntStats; directoryIdentity: BigIntStats }> {
    validatePaths(directory, [path, ...targets]);
    await this.inspect(directory, targets, true, this.helper ? path : undefined);
    this.guard(); return openCreatedPrivateFile(directory, path);
  }
  async read(directory: string, path: string, maximum: number): Promise<Buffer | null> {
    await this.inspect(directory, [path]);
    this.guard(); return readCheckedPrivateFile(directory, path, maximum);
  }
  close(): Promise<void> { return this.helper?.close() ?? Promise.resolve(); }
}
