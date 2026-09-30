import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
// SID comparison avoids localized account names. Reject unknown inherited or
// explicit allow entries, even if the host would otherwise let us open a file.
// This is a conservative privacy gate, not a sandbox against the same OS user.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$p = $env:FATE_PRIVATE_ACL_PATH
if ([string]::IsNullOrEmpty($p)) { exit 2 }
$a = Get-Acl -LiteralPath $p
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
if ($allowed -notcontains $a.GetOwner([Security.Principal.SecurityIdentifier]).Value) { exit 3 }
foreach ($rule in $a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $allowed -notcontains $rule.IdentityReference.Value) { exit 4 }
}
[Console]::Out.Write('PRIVATE')
`;

const treeScript = String.raw`
$ErrorActionPreference = 'Stop'
$root = $env:FATE_PRIVATE_ACL_PATH
if ([string]::IsNullOrEmpty($root)) { exit 2 }
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($root)
$count = 0
while ($pending.Count -gt 0) {
  $p = $pending.Pop()
  $count++
  if ($count -gt 10000) { exit 5 }
  $item = Get-Item -LiteralPath $p -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 6 }
  $a = Get-Acl -LiteralPath $p
  if ($allowed -notcontains $a.GetOwner([Security.Principal.SecurityIdentifier]).Value) { exit 3 }
  foreach ($rule in $a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $allowed -notcontains $rule.IdentityReference.Value) { exit 4 }
  }
  if ($item.PSIsContainer) {
    foreach ($child in (Get-ChildItem -LiteralPath $p -Force)) { $pending.Push($child.FullName) }
  }
}
[Console]::Out.Write('PRIVATE')
`; 

/** Windows mode bits do not validate an NTFS DACL. Reject startup when the
 * operating system cannot verify that only this user, SYSTEM, or local admins
 * have allow rules. Never repair an operator-supplied path by widening access. */
async function verify(target: string, command: string): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: 30_000, maxBuffer: 4096,
      env: { ...process.env, FATE_PRIVATE_ACL_PATH: target },
    });
    if (stdout !== 'PRIVATE') throw new Error('ACL verification was incomplete.');
  } catch {
    throw new Error('Private Windows storage ACL cannot be verified.');
  }
}
export async function assertPrivateWindowsAcl(target: string): Promise<void> { return verify(target, script); }
/** Before host startup, inspect every existing descendant, not just the owner
 * key. A provider token or journal under a private parent may have its own
 * unsafe explicit DACL. A reparse point, unverifiable item, or excessive tree
 * blocks startup rather than being silently skipped. */
export async function assertPrivateWindowsTree(target: string): Promise<void> { return verify(target, treeScript); }
