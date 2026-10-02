import { randomUUID } from 'node:crypto';
import type { RuntimeState } from '../../shared/contracts/ipc';
import type { EventCursor } from '../../shared/protocol/events';
import { SNAPSHOT_PAGE_BYTES, SNAPSHOT_TOTAL_BYTES, SNAPSHOT_TTL_MS, snapshotPageSchema, snapshotScopeSchema,
  type SnapshotHeader, type SnapshotItem, type SnapshotPage, type SnapshotScope } from '../../shared/protocol/snapshots';

export interface SnapshotView {
  state: RuntimeState;
  goal: { id: string; revision: number; status: string; phase: string; objective?: string; executionState?: string;
    continuation?: { pending: boolean }; criteria?: readonly { id: string; title: string; status: string; required: boolean }[] } | null;
  tasks: readonly { id: string; title: string; status: string; detail?: string; required?: boolean; verified?: boolean }[];
  taskRevision?: number | null;
  /** True when the canonical task list has not loaded, rather than an empty list. */
  tasksReady?: boolean;
  goalReady?: boolean;
}
interface Transaction { scope: SnapshotScope; sessionId: string | null; expiresAt: number; pages: readonly string[]; ids: readonly string[] }
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const text = (value: string, max = 200) => value.slice(0, max);
/** UTF-8 clipping avoids treating 4-byte characters as a one-byte quota. */
export function clipUtf8(value: string, byteLimit = 4096): { text: string; clipped: boolean } {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= byteLimit) return { text: value, clipped: false };
  let end = byteLimit;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return { text: encoded.subarray(0, end).toString('utf8'), clipped: true };
}

/** A synchronous capture owns its complete copied page set before control returns to the event loop. */
export class WorkspaceSnapshotService {
  private readonly transactions = new Map<string, Transaction>();
  private readonly pageOwners = new Map<string, string>();
  constructor(private readonly flush: () => void, private readonly view: () => SnapshotView, private readonly now: () => number = Date.now) {}

  capture(input: SnapshotScope, captureHighWater?: () => EventCursor, selectionRevision?: number): SnapshotPage {
    const scope = snapshotScopeSchema.parse(input);
    // An accessor, clock, or projection hook can synchronously publish events.
    // Sample around the COMPLETE immutable page copy, not just the view getter.
    // A changed position invalidates this attempt without publishing its pages.
    for (let attempt = 0; attempt < 3; attempt++) {
    this.flush();
    const eventStream = captureHighWater?.();
    const source = this.view(); // No await between the event boundary and the entire copied projection.
    if (!source.state.project?.trusted || source.state.project.path !== scope.projectPath
      || !source.state.sessionId || source.state.sessionId !== scope.sessionId
      || source.tasksReady === false || source.goalReady === false) {
      throw new Error('SNAPSHOT_NOT_READY');
    }
    const state = source.state;
    const capturedAt = this.now();
    const snapshotId = randomUUID();
    const items: SnapshotItem[] = [];
    let media = false;
    let clippedItems = 0;
    for (const message of state.messages.slice(-5_000)) {
      const clipped = clipUtf8(message.text);
      const hasMedia = Boolean(message.images?.length);
      media ||= hasMedia;
      clippedItems += Number(clipped.clipped || Boolean(message.reasoning) || hasMedia);
      items.push({ kind: 'message', id: text(message.id, 500), role: message.role === 'tool' ? 'system' : message.role,
        text: clipped.text, timestamp: message.timestamp, clipped: clipped.clipped || Boolean(message.reasoning), mediaOmitted: hasMedia,
        ...(message.historyOmitted ? { historyOmitted: message.historyOmitted } : {}) });
    }
    for (const tool of (state.tools ?? []).slice(-5_000)) {
      const clipped = clipUtf8(tool.output);
      const hasMedia = Boolean(tool.images?.length);
      media ||= hasMedia;
      clippedItems += Number(clipped.clipped || tool.outputTruncated || hasMedia);
      items.push({ kind: 'tool', id: text(tool.id, 500), name: text(tool.name), status: tool.status,
        text: clipped.text, timestamp: tool.updatedAt, clipped: clipped.clipped || tool.outputTruncated, mediaOmitted: hasMedia });
    }
    items.sort((a, b) => a.timestamp - b.timestamp);
    // Retain the newest display items if both Pi's bounded message and tool
    // windows would exceed one transaction. Never drop a recent pending item
    // merely because old transcript rows consumed the transaction budget.
    let retainedBytes = items.reduce((sum, item) => sum + bytes(item) + 2, 0);
    let discardedOldItems = 0;
    while (retainedBytes > 24 * 1024 * 1024 && discardedOldItems < items.length) {
      retainedBytes -= bytes(items[discardedOldItems]!) + 2;
      discardedOldItems++;
    }
    if (discardedOldItems) {
      items.splice(0, discardedOldItems);
      clippedItems = items.filter((item) => item.clipped || item.mediaOmitted).length;
      media = items.some((item) => item.mediaOmitted);
    }
    const agents = [
      ...(state.subagents ?? []).map((agent) => ({ id: `subagent:${agent.id}`, title: agent.agentName, status: agent.status })),
      ...(state.subagentWorkflows ?? []).map((workflow) => ({ id: `workflow:${workflow.id}`, title: 'Workflow', status: workflow.status })),
      ...(state.agentTeams ?? []).flatMap((team) => [
        { id: `team:${team.id}`, title: team.name, status: team.status },
        ...team.nodes.map((node) => ({ id: `team-node:${team.id}:${node.id}`, title: node.path, status: node.status })),
      ]),
    ];
    const agentRows = agents.length > 500;
    const taskRows = source.tasks.length > 200;
    const warnings: string[] = [];
    if (state.queue?.recovered?.length) warnings.push('A recovered queue item needs review before any new execution.');
    if (state.queue?.recovered?.length || state.queue?.items?.length || state.queue?.held?.length) warnings.push('Queue text and attachments are omitted from this display snapshot.');
    if (state.queue?.items?.length || state.queue?.steering || state.queue?.followUp) warnings.push('Pending queue items are not a completed run.');
    if (state.queue?.held?.length) warnings.push('Queued work is held behind a goal or compaction gate.');
    if (state.error) warnings.push('The runtime reports an error; inspect its detail before continuing.');
    if (source.goal && ['blocked', 'paused', 'failed', 'budget-limited', 'usage-limited'].includes(source.goal.status)) {
      warnings.push('The goal needs review before continuation.');
    }
    const pageIds = [randomUUID()];
    const header: SnapshotHeader = {
      version: 1, snapshotId, capturedAt, expiresAt: capturedAt + SNAPSHOT_TTL_MS,
      workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration, serverEpoch: scope.serverEpoch,
      sessionId: state.sessionId, eventCursor: state.eventCursor ?? null, ...(eventStream ? { eventStream } : {}),
      ...(selectionRevision === undefined ? {} : { selectionRevision }), pageIds,
      controls: { status: state.status, streaming: state.streaming, activeSessionRunning: state.activeSessionRunning ?? false,
        runningSessionCount: state.runningSessionCount ?? 0, permissionLevel: state.permissionLevel ?? 'read-only', thinkingLevel: state.thinkingLevel,
        model: state.model ? { provider: state.model.provider, id: state.model.id } : null,
        pendingModel: state.pendingModel ? { provider: state.pendingModel.provider, id: state.pendingModel.id } : null,
        pendingThinkingLevel: state.pendingThinkingLevel ?? null, sessionOperation: state.sessionOperation ?? false,
        queue: { steering: state.queue?.steering ?? 0, followUp: state.queue?.followUp ?? 0, pending: state.queue?.items?.length ?? 0,
          held: state.queue?.held?.length ?? 0, recovered: state.queue?.recovered?.length ?? 0 } },
      goal: source.goal ? { id: text(source.goal.id, 500), revision: source.goal.revision, status: text(source.goal.status, 60), phase: text(source.goal.phase, 60),
        ...(source.goal.objective ? { objective: text(source.goal.objective, 500) } : {}),
        ...(source.goal.executionState ? { executionState: text(source.goal.executionState, 60) } : {}),
        ...(source.goal.continuation ? { continuationPending: source.goal.continuation.pending } : {}),
        ...(source.goal.criteria ? { criteria: source.goal.criteria.slice(0, 32).map((criterion) => ({
          id: text(criterion.id, 500), title: text(criterion.title, 240), status: text(criterion.status, 60), required: criterion.required })) } : {}) } : null,
      taskRevision: source.taskRevision ?? null,
      tasks: source.tasks.slice(0, 200).map((task) => ({ id: text(task.id, 500), title: text(task.title, 240), status: text(task.status, 60),
        ...(task.detail ? { detail: text(task.detail, 300) } : {}), ...(task.required === undefined ? {} : { required: task.required }),
        ...(task.verified === undefined ? {} : { verified: task.verified }) })),
      agents: agents.slice(0, 500).map((agent) => ({ id: text(agent.id, 500), title: text(agent.title), status: text(agent.status, 60) })),
      omissions: { history: discardedOldItems > 0 || state.messages.length >= 5_000 || state.messages.some((message) => Boolean(message.historyOmitted)),
        media, clippedItems, agentRows, taskRows,
        goalText: Boolean(source.goal?.objective && source.goal.objective.length > 500),
        taskText: source.tasks.some((task) => Boolean(task.detail && task.detail.length > 300)),
        agentText: agents.some((agent) => agent.title.length > 200),
        queueContents: Boolean(state.queue?.items?.length || state.queue?.held?.length || state.queue?.recovered?.length) }, warnings,
    };
    const itemPages: SnapshotItem[][] = [[]];
    let totalEstimate = bytes(header) + 2048;
    for (const item of items) {
      const size = bytes(item) + 2;
      let current = itemPages.at(-1)!;
      const pageHeaderBytes = itemPages.length === 1 ? bytes(header) : 0;
      if (size + bytes(current) + pageHeaderBytes + 4096 > SNAPSHOT_PAGE_BYTES) {
        if (itemPages.length === 32) { header.omissions.history = true; break; }
        current = [];
        itemPages.push(current);
      }
      if (totalEstimate + size + 2048 > SNAPSHOT_TOTAL_BYTES) { header.omissions.history = true; break; }
      current.push(item);
      totalEstimate += size;
    }
    while (pageIds.length < itemPages.length) pageIds.push(randomUUID());
    const pages = itemPages.map((pageItems, index): SnapshotPage => snapshotPageSchema.parse({ version: 1, snapshotId,
      pageId: pageIds[index]!, index, ...(index === 0 ? { header } : {}), items: pageItems, nextPageId: pageIds[index + 1] ?? null }));
    if (pages.some((page) => bytes(page) > SNAPSHOT_PAGE_BYTES) || pages.reduce((sum, page) => sum + bytes(page), 0) > SNAPSHOT_TOTAL_BYTES) {
      throw new Error('RESULT_TOO_LARGE');
    }
    // Store wire bytes, not references to mutable state or consumer-editable output objects.
    const stored = pages.map((page) => JSON.stringify(page));
    const end = captureHighWater?.();
    if (eventStream && (!end || end.serverEpoch !== eventStream.serverEpoch || end.workspaceId !== eventStream.workspaceId
      || end.workspaceGeneration !== eventStream.workspaceGeneration || end.streamId !== eventStream.streamId
      || end.sequence !== eventStream.sequence)) {
      if (attempt === 2) throw new Error('RESYNC_REQUIRED');
      continue;
    }
    this.prune(capturedAt);
    const client = `${scope.principalId}\0${scope.clientId}`;
    const owned = [...this.transactions.entries()].filter(([, tx]) => `${tx.scope.principalId}\0${tx.scope.clientId}` === client);
    for (const [id] of owned.slice(0, Math.max(0, owned.length - 1))) this.evict(id);
    // The protocol permits eight authenticated connections and two captures
    // each. Bound memory even when a future caller misconfigures that gate.
    while (this.transactions.size >= 16) this.evict(this.transactions.keys().next().value!);
    this.transactions.set(snapshotId, { scope, sessionId: state.sessionId, expiresAt: header.expiresAt, pages: stored, ids: pageIds });
    pageIds.forEach((id) => this.pageOwners.set(id, snapshotId));
    return pages[0]!;
    }
    throw new Error('RESYNC_REQUIRED');
  }

  /** Abort a stored transaction when its subscriber exceeded the unsent quota. */
  cancel(input: SnapshotScope, snapshotId: string): void {
    const scope = snapshotScopeSchema.parse(input);
    const tx = this.transactions.get(snapshotId);
    if (tx && tx.scope.principalId === scope.principalId && tx.scope.clientId === scope.clientId
      && tx.scope.workspaceId === scope.workspaceId && tx.scope.workspaceGeneration === scope.workspaceGeneration
      && tx.scope.serverEpoch === scope.serverEpoch && tx.scope.projectPath === scope.projectPath
      && tx.sessionId === scope.sessionId) this.evict(snapshotId);
  }

  page(input: SnapshotScope, pageId: string): SnapshotPage {
    const scope = snapshotScopeSchema.parse(input);
    this.prune(this.now());
    const owner = this.pageOwners.get(pageId);
    const tx = owner ? this.transactions.get(owner) : undefined;
    if (!tx || tx.scope.principalId !== scope.principalId || tx.scope.clientId !== scope.clientId
      || tx.scope.workspaceId !== scope.workspaceId || tx.scope.workspaceGeneration !== scope.workspaceGeneration
      || tx.scope.serverEpoch !== scope.serverEpoch || tx.scope.projectPath !== scope.projectPath
      || tx.sessionId !== scope.sessionId) throw new Error('RESYNC_REQUIRED');
    const index = tx.ids.indexOf(pageId);
    if (index < 0) throw new Error('RESYNC_REQUIRED');
    return snapshotPageSchema.parse(JSON.parse(tx.pages[index]!));
  }

  /** Host-only retained wire-size inspection. Expiry also releases idle captures. */
  inspectBuffers(): { transactionCount: number; pageCount: number; bytes: number } {
    this.prune(this.now());
    let retainedBytes = 0;
    for (const transaction of this.transactions.values()) for (const page of transaction.pages) retainedBytes += Buffer.byteLength(page, 'utf8');
    return { transactionCount: this.transactions.size, pageCount: this.pageOwners.size, bytes: retainedBytes };
  }

  private prune(now: number): void { for (const [id, tx] of this.transactions) if (tx.expiresAt <= now) this.evict(id); }
  private evict(id: string): void { const tx = this.transactions.get(id); if (!tx) return; tx.ids.forEach((pageId) => this.pageOwners.delete(pageId)); this.transactions.delete(id); }
}
