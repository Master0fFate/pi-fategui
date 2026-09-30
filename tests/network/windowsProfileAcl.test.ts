import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { startAuthenticatedNodeServerWithFactory } from '../../src/server/http/startAuthenticatedNodeServer';
import { privateTestRoot } from '../v2/helpers/isolatedEnvironment';

const execute = promisify(execFile);
describe('Windows profile ACL listener preflight', () => {
  it.skipIf(process.platform !== 'win32')('refuses an unsafe provider file before the core or listener starts', async () => {
    const root = await fs.mkdtemp(path.join(privateTestRoot(), 'unsafe-server-profile-'));
    try {
      const home = path.join(root, 'home');
      const providerRoot = path.join(home, '.pi', 'fate-server', 'acl-case', 'data');
      const workspace = path.join(root, 'workspace');
      await fs.mkdir(providerRoot, { recursive: true });
      await fs.mkdir(workspace);
      const provider = path.join(providerRoot, 'auth.json');
      await fs.writeFile(provider, '{"fake":"private"}');
      const script = String.raw`$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:FATE_PRIVATE_ACL_PATH; $sid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'); $r=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); Set-Acl -LiteralPath $env:FATE_PRIVATE_ACL_PATH -AclObject $a`;
      await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, FATE_PRIVATE_ACL_PATH: provider }, windowsHide: true, timeout: 10_000,
      });
      let coreStarted = false;
      await expect(startAuthenticatedNodeServerWithFactory({ profile: { profileId: 'acl-case', home },
        workspaces: [workspace], host: '127.0.0.1', port: 42_000, flags: { terminal: false, browser: false } },
      async () => { coreStarted = true; throw new Error('Unsafe provider data reached core initialization.'); }, () => {}))
        .rejects.toThrow('Private Windows storage ACL cannot be verified.');
      expect(coreStarted).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  }, 45_000);
});
