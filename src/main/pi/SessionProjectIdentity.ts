import { isAbsolute, resolve } from 'node:path';

/** Pi's session-directory encoding is lossy: /a-b and /a/b can share a folder.
 * Only a stored absolute cwd matching the host-bound project identifies a session.
 * Do not resolve untrusted header paths through the filesystem or accept relative cwd.
 */
export function sessionProjectMatches(storedCwd: unknown, projectPath: string): boolean {
  if (typeof storedCwd !== 'string' || !storedCwd || storedCwd.includes('\0') || !isAbsolute(storedCwd)) return false;
  const stored = resolve(storedCwd);
  const expected = resolve(projectPath);
  return process.platform === 'win32' ? stored.toLowerCase() === expected.toLowerCase() : stored === expected;
}
