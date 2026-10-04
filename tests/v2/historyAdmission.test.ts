import { describe, expect, it, vi } from 'vitest';
import { HistoryPageService } from '../../src/core/views/HistoryPageService';
import type { HistoryScope } from '../../src/shared/protocol/snapshots';
import type { PiSessionRepository } from '../../src/main/pi/PiSessionRepository';

const scope: HistoryScope = { principalId: 'owner', clientId: 'client', workspaceId: 'workspace', workspaceGeneration: 1,
  serverEpoch: 'epoch', sessionId: 'session', projectPath: 'trusted-project', selectionRevision: 1 };
const result = { items: [], nextOffset: 1, stamp: 'stable', mediaOmitted: false, oversizedItems: 0 };
function fixture() {
  const read = vi.fn<PiSessionRepository['readHistoryPage']>(async () => result);
  return { read, service: new HistoryPageService({ readHistoryPage: read }) };
}
describe('history disk admission and cursor scope', () => {
  it('admits one disk scan per client and does not duplicate a one-use page', async () => {
    const f = fixture();
    const first = await f.service.read(scope);
    let finish!: () => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(result); }));
    const pending = f.service.read(scope, first.nextPageId!);
    await expect(f.service.read(scope, first.nextPageId!)).rejects.toThrow('BUSY');
    expect(f.read).toHaveBeenCalledTimes(2); // first page plus exactly one follow-on scan
    finish(); await pending;
    await expect(f.service.read(scope, first.nextPageId!)).rejects.toThrow('RESYNC_REQUIRED');
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it('bounds simultaneous disk scans across clients and releases capacity after failure', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.read.mockImplementation(async () => { await gate; throw new Error('disk failed'); });
    const reads = Array.from({ length: 16 }, (_, index) => f.service.read({ ...scope, clientId: `client-${index}` }).catch(() => undefined));
    await expect(f.service.read({ ...scope, clientId: 'extra' })).rejects.toThrow('BUSY');
    expect(f.read).toHaveBeenCalledTimes(16);
    release(); await Promise.all(reads);
    f.read.mockResolvedValue(result);
    await expect(f.service.read(scope)).resolves.toMatchObject({ sessionId: scope.sessionId });
  });
  it('refuses a cursor after A-to-B-to-A selection or a workspace/client change without reading disk', async () => {
    const f = fixture();
    const first = await f.service.read(scope);
    for (const changed of [{ ...scope, selectionRevision: 3 }, { ...scope, workspaceGeneration: 2 }, { ...scope, clientId: 'other' }]) {
      await expect(f.service.read(changed, first.nextPageId!)).rejects.toThrow('RESYNC_REQUIRED');
    }
    expect(f.read).toHaveBeenCalledOnce();
    await expect(f.service.read(scope, first.nextPageId!)).resolves.toMatchObject({ sessionId: scope.sessionId });
  });
});
