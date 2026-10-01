import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Same conservative SID allowlist as production WindowsPrivateAcl. Read-only:
// never repair/widen supplied credential ACLs or treat mode bits as an NTFS DACL.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$root = $env:FATE_FIXTURE_ACL_PATH
if ([string]::IsNullOrEmpty($root)) { exit 2 }
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($root)
$count = 0
while ($pending.Count -gt 0) {
  $p = $pending.Pop(); $count++
  if ($count -gt 10000) { exit 5 }
  $item = Get-Item -LiteralPath $p -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 6 }
  $a = Get-Acl -LiteralPath $p
  if ($allowed -notcontains $a.GetOwner([Security.Principal.SecurityIdentifier]).Value) { exit 3 }
  foreach ($rule in $a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $allowed -notcontains $rule.IdentityReference.Value) { exit 4 }
  }
  if ($env:FATE_FIXTURE_ACL_TREE -eq '1' -and $item.PSIsContainer) {
    foreach ($child in (Get-ChildItem -LiteralPath $p -Force)) { $pending.Push($child.FullName) }
  }
}
[Console]::Out.Write('PRIVATE')
`;
export async function assertNoIndirectFixturePath(target, { missingLeaf = false } = {}) {
  const absolute = path.resolve(target);
  for (let current = absolute; ; current = path.dirname(current)) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Fixture path has an indirect ancestor; refusing alias/junction use');
    } catch (error) {
      if (!(missingLeaf && current === absolute && error.code === 'ENOENT')) throw error;
    }
    if (path.dirname(current) === current) break;
  }
  if (!missingLeaf && await fs.realpath(absolute) !== absolute) throw new Error('Fixture path is not canonical');
  return absolute;
}
export async function assertPrivateFixtureStorage(target, { directory = false, tree = false } = {}) {
  target = await assertNoIndirectFixturePath(target);
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('Fixture storage is not a regular private path');
  if (process.platform !== 'win32') {
    if (stat.mode & 0o077 || stat.uid !== process.getuid()) throw new Error('Fixture storage must be private and owned by this fixture user');
    if (tree && directory) for (const entry of await fs.readdir(target, { withFileTypes: true })) await assertPrivateFixtureStorage(path.join(target, entry.name), { directory: entry.isDirectory(), tree: true });
    return { platform: process.platform, target: path.resolve(target), proof: 'POSIX private mode', mode: stat.mode & 0o777 };
  }
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout, stderr } = await promisify(execFile)(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 10000, maxBuffer: 4096,
      env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', FATE_FIXTURE_ACL_PATH: path.resolve(target), FATE_FIXTURE_ACL_TREE: tree ? '1' : '0' },
    });
    if (stdout !== 'PRIVATE') throw Object.assign(new Error('Incomplete ACL proof despite process exit 0'), { code: 0, stdout, stderr });
    return { platform: 'win32', target: path.resolve(target), proof: 'read-only NTFS SID/DACL', tree, exitCode: 0, stdout, stderr };
  } catch (error) { throw new Error(`Private Windows fixture ACL cannot be verified (probe exit=${String(error.code ?? 'unavailable')}, stdout=${JSON.stringify(error.stdout ?? '')}, stderr=${JSON.stringify(error.stderr ?? '')}); refusing activation/storage use`, { cause: error }); }
}
