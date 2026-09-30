import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertPrivateWindowsAcl } from '../../core/storage/WindowsPrivateAcl';
import { readClientCredentialReference } from '../../server/auth/AuthStore';
import { connectionProfileSchema, type ConnectionProfile } from '../../shared/contracts/connections';

const origin = z.string().refine((value) => /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(value)
  && Number(new URL(value).port) <= 65535, 'Use an explicit numeric loopback SSH tunnel.');
const reference = z.string().refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
export const approvedConnectionProfileSchema = connectionProfileSchema.extend({ approved: z.literal(true),
  baseUrl: origin, credentialRef: reference }).strict();
const storeSchema = z.object({ version: z.literal(1), profiles: z.array(approvedConnectionProfileSchema).max(16) }).strict()
  .refine(({ profiles }) => new Set(profiles.map((profile) => profile.id)).size === profiles.length);
export type ApprovedConnectionProfile = z.infer<typeof approvedConnectionProfileSchema>;
const unavailable = () => new Error('Approved desktop connection profiles are unavailable.');

/** Host-local configuration only. No renderer method creates profiles, approves paths, or imports keys. */
export class ConnectionProfileStore {
  private readonly profiles: readonly ApprovedConnectionProfile[];
  constructor(profiles: readonly ApprovedConnectionProfile[] = [],
    private readonly readCredential: (approvedPath: string) => Promise<string> = readClientCredentialReference) {
    this.profiles = storeSchema.parse({ version: 1, profiles }).profiles;
  }
  static async fromFile(file: string): Promise<ConnectionProfileStore> {
    if (!path.isAbsolute(file) || path.normalize(file) !== file) throw unavailable();
    let before;
    try { before = await fs.lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new ConnectionProfileStore();
      throw unavailable();
    }
    try {
      const parent = await fs.lstat(path.dirname(file));
      if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 64 * 1024
        || !parent.isDirectory() || parent.isSymbolicLink()
        || process.platform !== 'win32' && ((before.mode | parent.mode) & 0o077) !== 0) throw unavailable();
      await assertPrivateWindowsAcl(path.dirname(file));
      await assertPrivateWindowsAcl(file);
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const live = await handle.stat();
        if (!live.isFile() || live.size !== before.size || live.dev !== before.dev || live.ino !== before.ino) throw unavailable();
        const bytes = Buffer.alloc(64 * 1024 + 1);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== before.size) throw unavailable();
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)));
        return new ConnectionProfileStore(storeSchema.parse(value).profiles);
      } finally { await handle.close(); }
    } catch { throw unavailable(); }
  }
  list(): readonly ConnectionProfile[] {
    return this.profiles.map(({ id, label, hostId }) => connectionProfileSchema.parse({ id, label, hostId }));
  }
  resolve(id: string): ApprovedConnectionProfile {
    const found = this.profiles.find((profile) => profile.id === id);
    if (!found) throw new Error('Select an approved desktop connection profile.');
    return { ...found };
  }
  async credential(id: string): Promise<string> {
    const profile = this.resolve(id);
    try {
      const credential = await this.readCredential(profile.credentialRef);
      if (!/^fc1_[A-Za-z0-9_-]{43}$/u.test(credential)) throw unavailable();
      return credential;
    } catch { throw new Error('The approved client credential is unavailable.'); }
  }
}
