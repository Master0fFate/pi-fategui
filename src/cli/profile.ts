import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FatePaths } from '../core/FatePaths';
import { createServerProfile } from '../core/storage/ServerProfile';
import { OwnerLock, canonicalFuturePath } from '../core/ownership/OwnerLock';
import { assertPrivateWindowsAcl, assertPrivateWindowsTree } from '../core/storage/WindowsPrivateAcl';
import { parseServerConfig, type ServerConfig } from '../server/config';
import { permissionLevelSchema, type PermissionLevel } from '../shared/contracts/ipc';
import { statePersistenceBackendSchema, type StatePersistenceBackend } from '../shared/v2FeaturePolicy';

const descriptorSchema = z.object({ version: z.literal(1), profileId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u),
  workspaces: z.array(z.string().min(1).max(32_768)).min(1).max(8), host: z.literal('127.0.0.1'),
  port: z.number().int().min(1).max(65_535), maxPermission: permissionLevelSchema,
  statePersistence: statePersistenceBackendSchema.optional(),
  workspaceTrustAccepted: z.literal(true), flags: z.object({ terminal: z.boolean(),
    terminalWarningAccepted: z.literal(true).optional(), browser: z.literal(false) }).strict()
    .refine((flags) => !flags.terminal || flags.terminalWarningAccepted === true,
      'Manual terminal requires explicit unsandboxed-shell acknowledgement.') }).strict()
  .refine((descriptor) => !descriptor.flags.terminal || descriptor.maxPermission !== 'read-only',
    'Manual terminal requires an explicit edit or full-access host maximum.');
type HostDescriptor = z.output<typeof descriptorSchema>;
export interface HostProfile { readonly paths: FatePaths; readonly config: ServerConfig; readonly input: unknown }
const unavailable = (): never => { throw new Error('Host profile is unavailable. Run explicit init and check private host storage.'); };
function profileOptions(profileId: string, home?: string) { return { profileId, ...(home === undefined ? {} : { home }) }; }
function descriptorPath(paths: FatePaths): string { return path.join(path.dirname(paths.dataRoot), 'server.json'); }
async function privateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory).catch(unavailable);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0
    || process.getuid && stat.uid !== process.getuid())) unavailable();
  await assertPrivateWindowsAcl(directory);
}
export async function assertPrivateOutputPath(target: string): Promise<void> {
  if (!path.isAbsolute(target) || path.normalize(target) !== target || /[\u0000\r\n]/u.test(target)) unavailable();
  // Reject aliases in existing parents, even if the final directory is private.
  if (await fs.realpath(path.dirname(target)).catch(unavailable) !== path.dirname(target)) unavailable();
  await privateDirectory(path.dirname(target));
  try { await fs.lstat(target); unavailable(); }
  catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
}
async function syncDirectory(directory: string): Promise<void> {
  try { const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  catch (error) {
    if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error)
      || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes(String(error.code))) throw error;
  }
}
/** Private output only. This cannot overwrite or follow an existing file. */
export async function writePrivateHostOutput(target: string, value: string): Promise<void> {
  await assertPrivateOutputPath(target);
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await assertPrivateWindowsAcl(target);
  await syncDirectory(path.dirname(target));
}
function serverInput(descriptor: HostDescriptor, home?: string): unknown {
  return { profile: profileOptions(descriptor.profileId, home), workspaces: descriptor.workspaces, host: descriptor.host,
    port: descriptor.port, flags: descriptor.flags, maxPermission: descriptor.maxPermission,
    ...(descriptor.statePersistence === undefined ? {} : { statePersistence: descriptor.statePersistence }) };
}
/** No engine, auth store or credential copy. The profile lock covers the descriptor write. */
export async function initializeHostProfile(input: { readonly profileId: string; readonly workspace: string; readonly trustAccepted: boolean;
  readonly port?: number; readonly home?: string; readonly statePersistence?: StatePersistenceBackend;
  readonly maxPermission?: PermissionLevel; readonly manualTerminal?: boolean; readonly acceptUnsandboxedShell?: boolean }): Promise<HostProfile> {
  if (!input.trustAccepted) throw new Error('Explicit workspace trust is required.');
  const descriptor = descriptorSchema.parse({ version: 1, profileId: input.profileId, workspaces: [path.resolve(input.workspace)],
    host: '127.0.0.1', port: input.port ?? 47819, maxPermission: input.maxPermission ?? 'read-only', workspaceTrustAccepted: true,
    ...(input.statePersistence === undefined ? {} : { statePersistence: input.statePersistence }),
    flags: { terminal: input.manualTerminal ?? false, browser: false,
      ...(input.acceptUnsandboxedShell === true ? { terminalWarningAccepted: true } : {}) } });
  const raw = serverInput(descriptor, input.home);
  const config = await parseServerConfig(raw);
  const paths = config.paths;
  const root = path.dirname(paths.dataRoot);
  const owner = await OwnerLock.acquire(paths.lockRoot, 'profile', await canonicalFuturePath(root));
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await privateDirectory(root);
    await assertPrivateWindowsTree(root);
    const saved = { ...descriptor, workspaces: [...config.workspaces] };
    await writePrivateHostOutput(descriptorPath(paths), `${JSON.stringify(saved, null, 2)}\n`);
    return { paths, config, input: serverInput(saved, input.home) };
  } finally { await owner.release(); }
}
/** Owner-local read only. A missing profile is never replaced by a temporary runtime. */
export async function readHostProfile(profileId: string, home?: string): Promise<HostProfile> {
  const paths = await createServerProfile(profileOptions(profileId, home));
  const target = descriptorPath(paths);
  await privateDirectory(path.dirname(target));
  const before = await fs.lstat(target).catch(unavailable);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 65_536
    || process.platform !== 'win32' && ((before.mode & 0o077) !== 0 || process.getuid && before.uid !== process.getuid())) unavailable();
  await assertPrivateWindowsAcl(target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(unavailable);
  let descriptor: HostDescriptor;
  try {
    const live = await handle.stat();
    if (!live.isFile() || live.nlink !== 1 || live.size !== before.size || live.dev !== before.dev || live.ino !== before.ino) unavailable();
    const bytes = Buffer.alloc(65_537);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== before.size) unavailable();
    descriptor = descriptorSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead))));
  } finally { await handle.close(); }
  if (descriptor.profileId !== profileId) unavailable();
  const raw = serverInput(descriptor, home);
  return { paths, config: await parseServerConfig(raw), input: raw };
}
