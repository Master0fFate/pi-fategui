import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertPrivatePath } from './isolatedEnvironment';

const execute = promisify(execFile);
/** Changes only a disposable test fixture, never an operator-supplied path. */
export async function setOtherLocalUsersRead(target: string, enabled: boolean): Promise<void> {
  await assertPrivatePath(target);
  const script = String.raw`$ErrorActionPreference='Stop'; $env:PSModulePath="$PSHOME\Modules"; $a=Get-Acl -LiteralPath $env:FATE_PRIVATE_ACL_PATH; $sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'); $r=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow); if($env:FATE_TEST_GRANT_READ -eq 'yes'){$a.AddAccessRule($r)}else{$a.RemoveAccessRuleSpecific($r)}; Set-Acl -LiteralPath $env:FATE_PRIVATE_ACL_PATH -AclObject $a`;
  await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FATE_PRIVATE_ACL_PATH: target, FATE_TEST_GRANT_READ: enabled ? 'yes' : 'no' }, windowsHide: true, timeout: 10_000,
  });
}
