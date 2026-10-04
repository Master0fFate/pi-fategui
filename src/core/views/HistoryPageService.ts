import { randomUUID } from 'node:crypto';
import type { PiSessionRepository } from '../../main/pi/PiSessionRepository';
import { historyPageSchema, historyScopeSchema, SNAPSHOT_PAGE_BYTES, SNAPSHOT_TTL_MS,
  type HistoryPage, type HistoryScope } from '../../shared/protocol/snapshots';

interface Cursor { scope: HistoryScope; offset: number; stamp: string; expiresAt: number }

/** The adapter supplies a trusted project/session binding. Page IDs disclose no path or file offset. */
export class HistoryPageService {
  private readonly cursors = new Map<string, Cursor>();
  private readonly activeReads = new Set<string>();
  constructor(private readonly repository: Pick<PiSessionRepository, 'readHistoryPage'>, private readonly now: () => number = Date.now) {}

  async read(input: HistoryScope, pageId?: string): Promise<HistoryPage> {
    const scope = historyScopeSchema.parse(input);
    const client = JSON.stringify([scope.principalId, scope.clientId]);
    // One disk scan per client; a bounded service-wide pool prevents read storms.
    if (this.activeReads.has(client) || this.activeReads.size >= 16) throw new Error('BUSY');
    this.activeReads.add(client);
    try { return await this.readPage(scope, pageId); }
    finally { this.activeReads.delete(client); }
  }

  private async readPage(scope: HistoryScope, pageId?: string): Promise<HistoryPage> {
    const now = this.now();
    for (const [id, cursor] of this.cursors) if (cursor.expiresAt <= now) this.cursors.delete(id);
    const cursor = pageId ? this.cursors.get(pageId) : undefined;
    if (pageId && (!cursor || !sameScope(cursor.scope, scope))) throw new Error('RESYNC_REQUIRED');
    // Reserve before the async disk read: concurrent use must not replay a cursor.
    if (pageId) this.cursors.delete(pageId);
    const result = await this.repository.readHistoryPage(scope.projectPath, scope.sessionId, cursor?.offset ?? 0, cursor?.stamp);
    if (!result) throw new Error('The saved session history is unavailable; no empty history was inferred.');
    if (cursor && cursor.expiresAt <= this.now()) throw new Error('RESYNC_REQUIRED');
    // An async read cannot retain authority after the caller changed its binding;
    // the adapter must also recheck its trusted workspace handle before delivery.
    const nextPageId = result.nextOffset === null ? null : randomUUID();
    const page = historyPageSchema.parse({ version: 1, sessionId: scope.sessionId, items: result.items,
      nextPageId, mediaOmitted: result.mediaOmitted, oversizedItems: result.oversizedItems });
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > SNAPSHOT_PAGE_BYTES) throw new Error('RESULT_TOO_LARGE');
    if (nextPageId && result.nextOffset !== null) {
      // At most two pending history cursors per client, even if requests race.
      const client = `${scope.principalId}\0${scope.clientId}`;
      for (const [id, existing] of this.cursors) {
        if (`${existing.scope.principalId}\0${existing.scope.clientId}` === client) this.cursors.delete(id);
      }
      while (this.cursors.size >= 16) this.cursors.delete(this.cursors.keys().next().value!);
      this.cursors.set(nextPageId, { scope, offset: result.nextOffset, stamp: result.stamp, expiresAt: this.now() + SNAPSHOT_TTL_MS });
    }
    return page;
  }
}

function sameScope(a: HistoryScope, b: HistoryScope): boolean {
  return a.principalId === b.principalId && a.clientId === b.clientId && a.workspaceId === b.workspaceId
    && a.workspaceGeneration === b.workspaceGeneration && a.serverEpoch === b.serverEpoch
    && a.projectPath === b.projectPath && a.sessionId === b.sessionId && a.selectionRevision === b.selectionRevision;
}
