import { execFile, spawn } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = pathToFileURL(path.join(projectRoot, 'tests/v2/helpers/nodeGuard.mjs')).href;

// A subprocess failure can leave exit/ownership genuinely unconfirmed. Keep
// that private root, including nested isolated runners, instead of deleting
// the retained fixture through an outer runner's unconditional cleanup.
async function containsRetainedOwnedWork(root) {
  const pending = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    if (++visited > 256) return true; // An incomplete ownership scan must retain.
    const { directory, depth } = pending.pop();
    for (const marker of ['.fate-retained-owned-work.json', '.fate-owned-cli-guard']) {
      try { await lstat(path.join(directory, marker)); return true; }
      catch (error) { if (error.code !== 'ENOENT') return true; }
    }
    let entries;
    try { entries = await readdir(path.join(directory, 'tmp'), { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') return true; continue; }
    for (const entry of entries) {
      if (!/^fate-v2-/u.test(entry.name)) continue;
      // Never follow an uncertain owned-root link or silently truncate nesting.
      if (entry.isSymbolicLink()) return true;
      if (entry.isDirectory()) {
        if (depth >= 8) return true;
        pending.push({ directory: path.join(directory, 'tmp', entry.name), depth: depth + 1 });
      }
    }
  }
  return false;
}

// Deliberately an allowlist: new provider credentials, proxies, Git config and
// NODE_OPTIONS/NODE_PATH must not silently enter the child as integrations grow.
export async function createIsolatedEnvironment(inherited = process.env) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fate-v2-'));
  try {
    if (process.platform === 'win32') {
      // A disposable test HOME must really be private. Windows ignores POSIX
      // mode bits, and CI/temp roots can inherit grants for other local users.
      const script = String.raw`$ErrorActionPreference='Stop'; $env:PSModulePath="$PSHOME\Modules"; $p=$env:FATE_TEST_PRIVATE_ROOT; $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$false); foreach($r in @($a.Access)){[void]$a.RemoveAccessRuleAll($r)}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $r=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a`;
      await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, FATE_TEST_PRIVATE_ROOT: root }, windowsHide: true, timeout: 20_000,
      }, (error) => error ? reject(error) : resolve()));
    }
    const env = {};
    const safe = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TERM', 'CI', 'NO_COLOR', 'FORCE_COLOR']);
    for (const [key, value] of Object.entries(inherited)) {
      if (value !== undefined && safe.has(key.toUpperCase())) env[key] = value;
    }
    const inheritedPath = Object.entries(inherited).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
    env.PATH = [...new Set([...(path.isAbsolute(process.execPath) ? [path.dirname(process.execPath)] : []), ...inheritedPath.split(path.delimiter)
      .filter((entry) => path.isAbsolute(entry) && !entry.includes('\0'))])].join(path.delimiter);
    const locations = {
      HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata',
      XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state',
      XDG_RUNTIME_DIR: 'runtime', PI_CODING_AGENT_DIR: 'pi/agent', FATE_GUI_DATA_DIR: 'fate',
      TMP: 'tmp', TEMP: 'tmp', TMPDIR: 'tmp',
    };
    for (const [key, relative] of Object.entries(locations)) {
      env[key] = path.join(root, relative);
      await mkdir(env[key], { recursive: true, mode: 0o700 });
    }
    if (process.platform === 'win32') {
      // Windows resolves known folders from USERPROFILE, not from LOCALAPPDATA.
      // If they are missing under the private home the lookup returns an empty
      // path, and a helper such as Windows PowerShell then writes its module
      // cache relative to the working directory: the verified source tree.
      for (const folder of ['Local', 'Roaming']) await mkdir(path.join(env.USERPROFILE, 'AppData', folder), { recursive: true, mode: 0o700 });
    }
    Object.assign(env, {
      FATE_V2_TEST_ROOT: root, PI_OFFLINE: '1', NODE_ENV: 'test',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'),
      GIT_TERMINAL_PROMPT: '0', TZ: 'UTC',
    });
    return { root, env, cleanup: async ({ retain = false } = {}) => {
      if (retain) {
        process.stderr.write(`TEST_FIXTURE_RETAINED: failed or unconfirmed run at ${root}\n`);
        return;
      }
      if (await containsRetainedOwnedWork(root)) {
        process.stderr.write(`OWNED_TEST_WORK_UNCONFIRMED: private fixture retained at ${root}\n`);
        return;
      }
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    } };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function buildV2Command(args) {
  return [path.join(projectRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'runner', '--config', path.join(projectRoot, 'vitest.v2.config.ts'), ...args];
}

// Exported for subprocess probes. Never modifies the launcher's own environment.
export async function runIsolated(entryArgs, options = {}) {
  const isolated = await createIsolatedEnvironment(options.env ?? process.env);
  let child, observedCode;
  const forward = (signal) => child?.kill(signal);
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  try {
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    observedCode = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, ['--import', guard, ...entryArgs], {
        cwd: projectRoot, env: isolated.env, stdio: 'inherit', shell: false,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
    return observedCode;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    await isolated.cleanup({ retain: observedCode !== 0 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runIsolated(buildV2Command(process.argv.slice(2)));
}
