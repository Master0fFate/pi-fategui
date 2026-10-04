import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
// SID comparison avoids localized account names. Reject unknown inherited or
// explicit allow entries, even if the host would otherwise let us open a file.
// This is a conservative privacy gate, not a sandbox against the same OS user.
// Windows PowerShell must not auto-load incompatible PowerShell 7 or user
// modules inherited from its parent. Use only this shell's system modules.
const shellSetup = String.raw`$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules"
`;
const checkAcl = String.raw`
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
function Assert-PrivateAcl([string]$p) {
  if ([string]::IsNullOrEmpty($p)) { exit 2 }
  $a = Get-Acl -LiteralPath $p
  if ($allowed -notcontains $a.GetOwner([Security.Principal.SecurityIdentifier]).Value) { exit 3 }
  foreach ($rule in $a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $allowed -notcontains $rule.IdentityReference.Value) { exit 4 }
  }
}
`;
const script = shellSetup + checkAcl + String.raw`
Assert-PrivateAcl $env:FATE_PRIVATE_ACL_PATH
[Console]::Out.Write('PRIVATE')
`;
const batchScript = shellSetup + checkAcl + String.raw`
$paths = ConvertFrom-Json $env:FATE_PRIVATE_ACL_PATH
if ($paths.Count -lt 1 -or $paths.Count -gt 32) { exit 2 }
foreach ($p in $paths) { Assert-PrivateAcl $p }
[Console]::Out.Write('PRIVATE')
`;

const checkTree = String.raw`
function Assert-PrivateTree([string]$root) {
  if ([string]::IsNullOrEmpty($root)) { exit 2 }
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($root)
  $count = 0
  while ($pending.Count -gt 0) {
    $p = $pending.Pop()
    $count++
    if ($count -gt 10000) { exit 5 }
    $item = Get-Item -LiteralPath $p -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 6 }
    Assert-PrivateAcl $p
    if ($item.PSIsContainer) {
      foreach ($child in (Get-ChildItem -LiteralPath $p -Force)) { $pending.Push($child.FullName) }
    }
  }
}
`;
const treeScript = shellSetup + checkAcl + checkTree + String.raw`
Assert-PrivateTree $env:FATE_PRIVATE_ACL_PATH
[Console]::Out.Write('PRIVATE')
`;

// Only fixed queries cross stdin, never PowerShell source. Reuse module/process
// startup, not authority: Assert-PrivateAcl/Get-Acl runs anew for EVERY request.
const workerScript = shellSetup + checkAcl + checkTree + String.raw`
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Length -gt 65536) { exit 2 }
  $request = ConvertFrom-Json -InputObject $line
  if ($null -eq $request -or @($request.PSObject.Properties).Count -ne 3 -or
      $request.id -isnot [string] -or $request.id -notmatch '^[1-9][0-9]{0,15}$' -or
      $request.kind -isnot [string] -or $request.target -isnot [string] -or
      [string]::IsNullOrEmpty($request.target) -or $request.target.Length -gt 32768 -or
      $request.target.IndexOf([char]0) -ge 0) { exit 2 }
  switch -Exact ($request.kind) {
    'single' { Assert-PrivateAcl $request.target }
    'batch' {
      $paths = ConvertFrom-Json -InputObject $request.target
      if ($request.target.Length -gt 16384 -or $paths.Count -lt 1 -or $paths.Count -gt 32) { exit 2 }
      foreach ($p in $paths) {
        if ($p -isnot [string] -or $p.IndexOf([char]0) -ge 0) { exit 2 }
        Assert-PrivateAcl $p
      }
    }
    'tree' { Assert-PrivateTree $request.target }
    default { exit 2 }
  }
  [Console]::Out.WriteLine('PRIVATE ' + $request.id)
  [Console]::Out.Flush()
}
`;
const ACL_TIMEOUT_MS = 30_000;
/** The one fixed failure for a refused, failed or unconfirmed ACL query. */
export class WindowsAclUnverifiedError extends Error {
  constructor() { super('Private Windows storage ACL cannot be verified.'); this.name = 'WindowsAclUnverifiedError'; }
}
const aclFailure = (): Error => new WindowsAclUnverifiedError();
type QueryKind = 'single' | 'batch' | 'tree';
interface PendingQuery {
  readonly bytes: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** A bounded, operation-owned transport. Nothing here stores an ACL decision. */
class WindowsAclQueryProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private joined: Promise<void> | undefined;
  private closed = false;
  private finishing = false;
  private terminationRequested = false;
  private failure: Error | undefined;
  private sequence = 0;
  private output = '';
  private readonly pending = new Map<string, PendingQuery>();
  private pendingBytes = 0;

  private fail(): void {
    this.failure ??= aclFailure();
    for (const query of this.pending.values()) { clearTimeout(query.timer); query.reject(this.failure); }
    this.pending.clear(); this.pendingBytes = 0;
    if (this.child && !this.closed && !this.terminationRequested) {
      this.terminationRequested = true;
      // A signal is only a request. Even a kill error must not release scope
      // before the close listener has confirmed actual process settlement.
      try { this.child.kill(); } catch { /* finish still awaits close. */ }
    }
  }
  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', workerScript], {
      windowsHide: true, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.child = child;
    this.joined = new Promise<void>((resolve) => child.once('close', (code) => {
      this.closed = true;
      if (!this.finishing || code !== 0 || this.pending.size || this.output) this.fail();
      resolve();
    }));
    child.once('error', () => this.fail());
    child.stdin.on('error', () => this.fail());
    child.stdout.on('error', () => this.fail());
    child.stderr.on('error', () => this.fail());
    // The protocol has no stderr messages. Do not retain potentially sensitive
    // OS diagnostics or allow unbounded output from a malfunctioning helper.
    child.stderr.on('data', () => this.fail());
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.failure) return;
      this.output += chunk;
      if (Buffer.byteLength(this.output) > 4096) { this.fail(); return; }
      for (;;) {
        const newline = this.output.indexOf('\n'); if (newline < 0) return;
        const line = this.output.slice(0, newline).replace(/\r$/u, ''); this.output = this.output.slice(newline + 1);
        const id = this.pending.keys().next().value;
        if (!id || line !== `PRIVATE ${id}`) { this.fail(); return; }
        const query = this.pending.get(id)!;
        this.pending.delete(id); this.pendingBytes -= query.bytes; clearTimeout(query.timer); query.resolve();
      }
    });
    return child;
  }
  check(target: string, kind: QueryKind): Promise<void> {
    if (this.failure || this.finishing) return Promise.reject(this.failure ?? aclFailure());
    const id = String(++this.sequence);
    const input = JSON.stringify({ id, kind, target }) + '\n'; const bytes = Buffer.byteLength(input);
    if (!target || target.length > 32768 || target.includes('\0') || !Number.isSafeInteger(this.sequence)
      || bytes > 65_536 || this.pending.size >= 32 || this.pendingBytes + bytes > 131_072) {
      this.fail(); return Promise.reject(this.failure);
    }
    let child: ChildProcessWithoutNullStreams;
    try { child = this.start(); } catch { this.fail(); return Promise.reject(this.failure); }
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { bytes, resolve, reject, timer: setTimeout(() => this.fail(), ACL_TIMEOUT_MS) });
      this.pendingBytes += bytes;
      child.stdin.write(input, 'utf8', (error) => { if (error) this.fail(); });
    });
  }
  async finish(): Promise<void> {
    this.finishing = true;
    // An escaped/unawaited assertion must not turn into a successful scope.
    if (this.pending.size) this.fail();
    if (this.child && !this.closed) {
      this.child.stdin.end();
      const timer = setTimeout(() => this.fail(), ACL_TIMEOUT_MS);
      // Even after kill, wait for actual close (stdio and process both settled),
      // not merely a sent signal. An unconfirmed helper cannot release its scope.
      try { await this.joined; } finally { clearTimeout(timer); }
    }
    if (this.failure) throw this.failure;
  }
}
const queryScope = new AsyncLocalStorage<WindowsAclQueryProcess>();
/** Host-only scope; nested calls borrow the current transport, never its answers.
 * Queries outside the callback (including escaped async work) are fenced. */
export async function withPrivateWindowsAclScope<T>(operation: () => Promise<T>): Promise<T> {
  if (process.platform !== 'win32' || queryScope.getStore()) return operation();
  const queries = new WindowsAclQueryProcess();
  return queryScope.run(queries, async () => {
    let failed = false;
    try { return await operation(); }
    catch (error) { failed = true; throw error; }
    finally {
      // Always join. Preserve an original migration/storage error if the query
      // failure already caused it; a swallowed query failure still fails scope.
      try { await queries.finish(); } catch (error) { if (!failed) throw error; }
    }
  });
}

/** One refused query ends a shared helper and every later query in its scope.
 * A READ-ONLY operation that reports an unsafe item as a result (rather than
 * failing) may repeat itself here: every query then uses its own process. */
export function withIndependentWindowsAclQueries<T>(operation: () => Promise<T>): Promise<T> {
  return queryScope.run(undefined as unknown as WindowsAclQueryProcess, operation);
}
/** True while a caller's shared helper scope is active (a nested call borrows it). */
export function insidePrivateWindowsAclScope(): boolean { return Boolean(queryScope.getStore()); }

/** Windows mode bits do not validate an NTFS DACL. Reject startup when the
 * operating system cannot verify that only this user, SYSTEM, or local admins
 * have allow rules. Never repair an operator-supplied path by widening access. */
async function verify(target: string, command: string): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    const scope = queryScope.getStore();
    if (scope) return await scope.check(target, command === script ? 'single' : command === batchScript ? 'batch' : 'tree');
    const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: ACL_TIMEOUT_MS, maxBuffer: 4096,
      env: { ...process.env, FATE_PRIVATE_ACL_PATH: target },
    });
    if (stdout !== 'PRIVATE') throw new Error('ACL verification was incomplete.');
  } catch {
    throw aclFailure();
  }
}
export async function assertPrivateWindowsAcl(target: string): Promise<void> { return verify(target, script); }
/** One subprocess for a bounded same-stage batch; no cached ACL decisions. */
export async function assertPrivateWindowsAcls(targets: readonly string[]): Promise<void> {
  if (process.platform !== 'win32' || targets.length === 0) return;
  const encoded = JSON.stringify(targets);
  if (targets.length > 32 || encoded.length > 16_384 || targets.some((target) => !target || target.includes('\0'))) {
    throw new Error('Private Windows storage ACL batch exceeds its bounds.');
  }
  await verify(encoded, batchScript);
}
/** Before host startup, inspect every existing descendant, not just the owner
 * key. A provider token or journal under a private parent may have its own
 * unsafe explicit DACL. A reparse point, unverifiable item, or excessive tree
 * blocks startup rather than being silently skipped. */
export async function assertPrivateWindowsTree(target: string): Promise<void> { return verify(target, treeScript); }
