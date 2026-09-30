import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readClientCredentialReference } from '../../server/auth/AuthStore';
import { connectionProfileSchema, type ConnectionProfile } from '../../shared/contracts/connections';
import { saveSshProfileSchema } from '../../shared/contracts/connectionEditor';
import type { ConnectionProfileStore } from './ConnectionProfileStore';

/** Native chooser authority stays in main. The renderer has only a short-lived opaque handle. */
export class ConnectionProfileEditor {
  private readonly choices = new Map<string, { path: string; owner: number; live: () => boolean; expiresAt: number }>();
  constructor(private readonly store: ConnectionProfileStore, private readonly storeFile: string,
    private readonly choose: (owner: number) => Promise<string | null>) {}
  async pick(owner: number, live: () => boolean): Promise<{ selectionId: string } | null> {
    if (!live()) throw new Error('The initiating document changed.');
    const file = await this.choose(owner);
    if (!live()) throw new Error('The initiating document changed.');
    if (!file) return null;
    if (!path.isAbsolute(file) || await fs.realpath(file) !== file) throw new Error('Choose a private regular credential file.');
    await readClientCredentialReference(file);
    if (!live()) throw new Error('The initiating document changed.');
    for (const [id, choice] of this.choices) if (choice.owner === owner || !choice.live() || choice.expiresAt <= Date.now()) this.choices.delete(id);
    if (this.choices.size >= 4) throw new Error('Complete or cancel the current credential selection.');
    const selectionId = randomUUID();
    this.choices.set(selectionId, { path: file, owner, live, expiresAt: Date.now() + 300_000 });
    return { selectionId };
  }
  async save(owner: number, live: () => boolean, input: unknown): Promise<ConnectionProfile> {
    const value = saveSshProfileSchema.parse(input), choice = this.choices.get(value.selectionId);
    this.choices.delete(value.selectionId);
    if (!choice || choice.owner !== owner || !choice.live() || !live() || choice.expiresAt <= Date.now()) throw new Error('Choose the client credential again.');
    if (await fs.realpath(choice.path) !== choice.path) throw new Error('Choose the client credential again.');
    await readClientCredentialReference(choice.path);
    if (!choice.live() || !live()) throw new Error('The initiating document changed.');
    const { selectionId: _selection, trust: _trust, ...publicFields } = value;
    const profile = { ...publicFields, id: randomUUID(), approved: true as const, transport: 'ssh' as const, credentialRef: choice.path };
    // The private store validates before persisting. No credentials are copied or returned.
    await this.store.saveSsh(profile, this.storeFile, () => choice.live() && live());
    return connectionProfileSchema.parse({ id: profile.id, label: profile.label, hostId: profile.hostId });
  }
}
