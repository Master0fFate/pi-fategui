import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerProfile } from '../core/storage/ServerProfile';
import { canonicalFuturePath, lockName } from '../core/ownership/OwnerLock';
import { uuidSchema } from '../shared/protocol/requestIds';
import { readHostProfile } from './profile';
import { createHostAdminClient } from './adminClient';

/** Read-only observations. A lock record never proves liveness or permits recovery. */
export async function doctor(profileId: string): Promise<unknown> {
  const paths = await createServerProfile({ profileId });
  const root = path.dirname(paths.dataRoot);
  const exists = (file: string) => fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false; throw new Error('Host state is unreadable.');
  });
  const lock = path.join(paths.lockRoot, `profile-${lockName(await canonicalFuturePath(root))}.lock`);
  let hostId: string | null = null;
  const identity = path.join(root, 'host-id');
  if (await exists(identity)) {
    const before = await fs.lstat(identity);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 64) throw new Error('Host identity is unreadable.');
    const handle = await fs.open(identity, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const live = await handle.stat();
      if (live.ino !== before.ino || live.dev !== before.dev || live.size !== before.size) throw new Error('Host identity changed.');
      const bytes = Buffer.alloc(65), result = await handle.read(bytes, 0, bytes.length, 0);
      hostId = uuidSchema.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead)).trim());
    } finally { await handle.close(); }
  }
  const dependencies = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@modelcontextprotocol/sdk/client/index.js', 'ws', 'node-pty']
    .map(async (name) => { try { await fs.access(fileURLToPath(import.meta.resolve(name))); return { name, resolution: 'available' }; }
      catch { return { name, resolution: 'unavailable' }; } });
  let ownerResponse = 'unobserved';
  let provider = await exists(path.join(paths.dataRoot, 'auth.json')) ? 'unverified' : 'auth-required';
  let profileConfiguration = 'unavailable';
  let capabilities: { terminal: boolean; browser: boolean } | null = null;
  try {
    const profile = await readHostProfile(profileId);
    profileConfiguration = 'valid'; capabilities = profile.config.flags;
    const response = await createHostAdminClient(paths, profile.config.port).execute({ method: 'provider.state', input: {} });
    if (response.method === 'provider.state') {
      ownerResponse = 'authenticated-owner-response';
      if (response.result.providers.length) provider = response.result.providers.some((item) => item.configured) ? 'configured-unvalidated' : 'auth-required';
    }
  } catch { /* Missing owner or configuration is diagnostic only. No second runtime is created. */ }
  return { profile: profileId, profileConfiguration, node: process.version, platform: process.platform, arch: process.arch,
    protocol: 1, hostId, ownership: await exists(lock) ? 'owner-record-present' : 'no-owner-record',
    ownerResponse, provider, capabilities, dependencies: await Promise.all(dependencies), nativeAbi: process.versions.modules,
    nativeExecution: 'Use smoke:server-package for an actual PTY probe.' };
}
