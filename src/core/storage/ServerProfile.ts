import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FatePaths } from '../FatePaths';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { fateDataRoot } from '../../main/pi/FateProviderStorage';
import { assertPrivateWindowsTree, withPrivateWindowsAclScope } from './WindowsPrivateAcl';

export interface ServerProfileOptions {
  readonly home?: string;
  readonly profileId?: string;
  /** Existing private, canonical directory; never provided by a network request. */
  readonly profileRoot?: string;
}

/** Host startup only. Do not create dataRoot: provider first-run detection owns that mkdir. */
export async function createServerProfile(options: ServerProfileOptions = {}): Promise<FatePaths> {
  const profileId = options.profileId ?? 'default';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(profileId)) throw new Error('Invalid server profile identity.');
  const home = await fs.realpath(options.home ?? os.homedir());
  const base = path.join(home, '.pi', 'fate-server');
  const requested = options.profileRoot ?? path.join(base, profileId);
  if (!path.isAbsolute(requested) || requested.includes('\0') || path.normalize(requested) !== requested) throw new Error('Server profile path must be canonical and absolute.');
  const root = path.resolve(requested);
  if (process.platform === 'win32' && (root.startsWith('\\\\') || home.startsWith('\\\\'))) {
    throw new Error('Server credentials require a local profile directory.');
  }
  // An operator-supplied custom root must not alias, contain, or sit inside
  // either desktop store. Checking both directions prevents nested profiles.
  const overlaps = (left: string, right: string): boolean => {
    const a = process.platform === 'win32' ? path.resolve(left).toLowerCase() : path.resolve(left);
    const b = process.platform === 'win32' ? path.resolve(right).toLowerCase() : path.resolve(right);
    const relative = path.relative(a, b);
    const reverse = path.relative(b, a);
    const inside = (value: string) => value === '' || value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value);
    return inside(relative) || inside(reverse);
  };
  for (const desktopRoot of [getAgentDir(), fateDataRoot(), path.join(home, '.pi', 'agent'), path.join(home, '.pi', 'fateGUI')]) {
    if (overlaps(root, desktopRoot)) throw new Error('A server profile must not overlap desktop Pi or Fate storage.');
  }
  // Reject symlinks in the profile's existing path components, not just at its leaf.
  let ancestor = root;
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = await fs.lstat(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Server profile path must contain only real directories.');
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0 && (ancestor === root || missing.length > 0 && ancestor.startsWith(base))) {
        throw new Error('Server profile directory must be private.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(ancestor);
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (options.profileRoot && missing.length) throw new Error('Custom server profile directory must already exist and be private.');
  const lockRoot = path.join(base, '.locks');
  // Both finite preflight walks share one helper process; each walk stays live.
  await withPrivateWindowsAclScope(async () => {
    if (missing.length === 0) await assertPrivateWindowsTree(root);
    try { await fs.lstat(lockRoot); await assertPrivateWindowsTree(lockRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  });
  // Never mkdir the profile, the Pi directory, or the provider data root here.
  return new FatePaths({
    profileId,
    profileKind: 'server',
    dataRoot: path.join(root, 'data'),
    piAgentDir: path.join(root, 'pi'),
    sessionsRoot: path.join(root, 'pi', 'sessions'),
    attachmentRoot: path.join(root, 'attachments'),
    lockRoot: path.join(base, '.locks'),
  });
}
