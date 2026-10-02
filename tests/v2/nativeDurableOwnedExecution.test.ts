import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { OwnerLock } from '../../src/core/ownership/OwnerLock';
import { openComposedPiExecution, openOwnedNativeExecution } from '../../src/main/pi/durable/OwnedNativeExecution';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fate-native-execution-'));
  roots.push(root);
  const dataRoot = path.join(root, 'profile');
  await mkdir(dataRoot, { mode: 0o700 });
  const owner = await OwnerLock.acquire(path.join(root, 'owners'), 'profile', dataRoot);
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses([fauxAssistantMessage('Native persisted answer'), fauxAssistantMessage('Second answer')]);
  const models = createModels(); models.setProvider(faux.provider);
  const options = { dataRoot, profileOwner: owner, models, cwd: root, model: { provider: 'faux', modelId: 'faux-1' }, systemPrompt: 'Host-approved synthetic fixture.', settings: { retry: { enabled: false }, compaction: { enabled: false } } };
  return { root, owner, options };
}

describe('owned production native execution composition', () => {
  it('uses real owned WAL/FULL SQLite and preserves quiescent history across reopen without touching JSONL', async () => {
    const { root, owner, options } = await fixture();
    const legacy = path.join(root, 'legacy-session.jsonl');
    const legacyBytes = '{"type":"session","id":"legacy"}\n';
    await writeFile(legacy, legacyBytes, { mode: 0o600 });
    const first = await openComposedPiExecution({ backend: 'native-durable', options: { ...options, source: { kind: 'new-native', sessionId: 'native-session-1' } } });
    expect(first.backend).toBe('native-durable');
    if (first.backend !== 'native-durable') throw new Error('Wrong backend');
    const id = await first.runtime.submit({ type: 'input', requestId: 'request-1', content: 'First question' });
    expect((await first.runtime.wait(id)).status).toBe('done');
    const before = (await first.runtime.entries()).items;
    await expect(openOwnedNativeExecution({ ...options, source: { kind: 'resume-native', sessionId: 'native-session-1' } })).rejects.toThrow();
    await first.runtime.close();
    await expect(openOwnedNativeExecution({ ...options, source: { kind: 'new-native', sessionId: 'native-session-1' } })).rejects.toThrow('must not reuse');
    const second = await openOwnedNativeExecution({ ...options, source: { kind: 'resume-native', sessionId: 'native-session-1' } });
    expect((await second.entries()).items).toEqual(before);
    expect((await second.wait(await second.submit({ type: 'input', requestId: 'request-2', content: 'Second question' }))).status).toBe('done');
    expect(await readFile(legacy, 'utf8')).toBe(legacyBytes);
    await second.close();
    await owner.release();
  });

  it('chooses exactly one backend and never falls back when the native branch fails', async () => {
    let legacyOpens = 0;
    const legacy = await openComposedPiExecution({ backend: 'legacy-sdk', open: async () => { legacyOpens++; return { actualSdkIdentity: 'fixture' }; } });
    expect(legacy).toEqual({ backend: 'legacy-sdk', runtime: { actualSdkIdentity: 'fixture' } });
    const { owner, options } = await fixture();
    await expect(openComposedPiExecution({ backend: 'native-durable', options: { ...options, source: { kind: 'resume-native', sessionId: 'missing' } } })).rejects.toThrow('does not exist');
    expect(legacyOpens).toBe(1);
    await owner.release();
  });
});
