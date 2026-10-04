import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Bind verification and packages to actual source bytes, including uncommitted inputs. */
export async function sourceIdentity(root) {
  // These two Git reads need neither a runtime HOME nor a private fixture tree.
  // Omit credentials/config redirects and disable system/user config and fsmonitor.
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const git = (args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    { cwd: root, env, encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']).trim();
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0');
  // Reports/private fixtures and generated output are not source inputs.
  const names = [...new Set(listed.filter((name) => name && !/^(?:plans|node_modules|dist|release|\.test-dist|test-results|playwright-report|coverage)(?:\/|$)/u.test(name)
    && !/^COMPACT-HANDOFF-(?:MANIFEST\.json|README\.md)$/u.test(name)))].sort();
  const digest = createHash('sha256');
  for (const name of names) {
    let stat;
    try { stat = await lstat(path.join(root, name)); }
    catch (error) { if (error.code === 'ENOENT') { digest.update(`${name}\0deleted\0`); continue; } throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Verification source must be a regular file: ${name}`);
    digest.update(name).update('\0').update(createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')).update('\0');
  }
  return { head, files: names.length, sha256: digest.digest('hex') };
}
