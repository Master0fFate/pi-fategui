import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { assertPrivateWindowsAcl, assertPrivateWindowsTree } from '../../src/core/storage/WindowsPrivateAcl';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const execute = promisify(execFile);
async function grantOtherLocalUsersRead(target: string): Promise<void> {
  const script = String.raw`$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:FATE_PRIVATE_ACL_PATH; $sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'); $r=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); Set-Acl -LiteralPath $env:FATE_PRIVATE_ACL_PATH -AclObject $a`;
  await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FATE_PRIVATE_ACL_PATH: target }, windowsHide: true, timeout: 10_000,
  });
}
describe('Windows server credential privacy', () => {
  it.skipIf(process.platform !== 'win32')('refuses a profile directory with an allow rule for other local users', async () => {
    const directory = await fs.mkdtemp(path.join(privateTestRoot(), 'untrusted-acl-'));
    try {
      await grantOtherLocalUsersRead(directory);
      await expect(assertPrivateWindowsAcl(directory)).rejects.toThrow('Private Windows storage ACL cannot be verified.');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  it.skipIf(process.platform !== 'win32')('rejects an unsafe provider file inside an otherwise private profile', async () => {
    const directory = await fs.mkdtemp(path.join(privateTestRoot(), 'nested-acl-'));
    try {
      const data = path.join(directory, 'data');
      await fs.mkdir(data);
      const provider = path.join(data, 'auth.json');
      await fs.writeFile(provider, '{"fake":"private"}');
      await assertPrivateWindowsTree(directory);
      await grantOtherLocalUsersRead(provider);
      await expect(assertPrivateWindowsTree(directory)).rejects.toThrow('Private Windows storage ACL cannot be verified.');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }, 30_000);
});
