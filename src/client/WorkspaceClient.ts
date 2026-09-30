import { z } from 'zod';
import { ConnectionState, type ConnectionView } from './ConnectionState';
import { reconcileHydrationEventEntries } from './reconcileHydrationEvents';
import type { PiEvent, RuntimeState } from '../shared/contracts/ipc';
import { EVENT_UNSENT_BYTES, EVENT_UNSENT_COUNT, EventReplayGate, eventCursorSchema, eventEnvelopeSchema, type EventCursor, type EventEnvelope } from '../shared/protocol/events';
import { SNAPSHOT_PAGE_BYTES, SNAPSHOT_TOTAL_BYTES, snapshotPageSchema, type SnapshotPage } from '../shared/protocol/snapshots';
import { permissionLevelSchema } from '../shared/contracts/ipc';

const selectedViewSchema = z.object({ hostId: z.string().min(1).max(250), profileId: z.string().min(1).max(250),
  hostName: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(250), workspaceName: z.string().min(1).max(128),
  workspaceGeneration: z.number().int().nonnegative().safe(), sessionId: z.string().min(1).max(500),
  viewGeneration: z.number().int().nonnegative().safe() }).strict();
const identitySchema = z.object({ serverId: z.string().min(1).max(250), serverEpoch: z.string().min(1).max(250),
  workspaceId: z.string().min(1).max(250), workspaceGeneration: z.number().int().nonnegative().safe(),
  sessionId: z.string().min(1).max(500) }).strict();
const handshakeSchema = identitySchema.extend({ control: z.enum(['observing', 'controlling']), permissionLevel: permissionLevelSchema }).strict();
export type ConnectionIdentity = z.infer<typeof identitySchema>;
export type Handshake = z.infer<typeof handshakeSchema>;
export interface SelectedView {
  readonly hostId: string;
  readonly profileId: string;
  readonly hostName: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceGeneration: number;
  readonly sessionId: string;
  /** Selection revision, including ABA back to the same session. */
  readonly viewGeneration: number;
}
export type OpenResult = { readonly identity: ConnectionIdentity; readonly close: () => void } & (
  | { readonly kind: 'snapshot'; readonly pages: readonly SnapshotPage[] }
  | { readonly kind: 'replay'; readonly after: EventCursor; readonly events: readonly EventEnvelope[] });
/** open must register callbacks before replay/capture and return all snapshot pages atomically.
 * An expired replay refuses RESYNC_REQUIRED. No mutation is available on this port. */
export interface WorkspaceTransport {
  handshake(selected: SelectedView, signal: AbortSignal): Promise<Handshake>;
  open(handshake: Handshake, after: EventCursor | undefined, onEvent: (event: EventEnvelope) => void,
    onDisconnect: () => void, signal: AbortSignal): Promise<OpenResult>;
}
export interface WorkspaceSink {
  /** May return a complete, local authoritative Pi hydration state; bounded network
   * display pages alone are not a full RuntimeState and must return void. */
  snapshot(pages: readonly SnapshotPage[]): RuntimeState | void;
  event(envelope: EventEnvelope): void;
  /** Background attention only. Never append another session's text to the current transcript. */
  background?(envelope: EventEnvelope): void;
  connection?(view: ConnectionView): void;
}
export interface ScopedResponse<T> { readonly identity: ConnectionIdentity; readonly value: T }
export interface PendingOutcome { readonly requestId: string; readonly status: 'sending' | 'confirmed' | 'outcome_unknown'; readonly text: string }
const defaultWait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('CANCELLED')); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
  const cancel = () => { clearTimeout(timer); reject(new Error('CANCELLED')); };
  signal.addEventListener('abort', cancel, { once: true });
});
const bounded = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('CANCELLED')); return; }
  const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
  const cancel = () => { cleanup(); reject(new Error('CANCELLED')); };
  const timer = setTimeout(() => { cleanup(); reject(new Error('CONNECTION_TIMEOUT')); }, 15_000);
  signal.addEventListener('abort', cancel, { once: true });
  operation.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
});
const key = (view: SelectedView): string => JSON.stringify([view.hostId, view.profileId, view.workspaceId, view.workspaceGeneration, view.sessionId]);
const sameIdentity = (left: ConnectionIdentity, right: ConnectionIdentity): boolean =>
  left.serverId === right.serverId && left.serverEpoch === right.serverEpoch && left.workspaceId === right.workspaceId
  && left.workspaceGeneration === right.workspaceGeneration && left.sessionId === right.sessionId;
const sameSelection = (left: SelectedView | null, right: SelectedView): boolean => Boolean(left && left.hostId === right.hostId
  && left.profileId === right.profileId
  && left.workspaceId === right.workspaceId && left.workspaceGeneration === right.workspaceGeneration
  && left.sessionId === right.sessionId && left.viewGeneration === right.viewGeneration);
function checkedPages(pages: readonly SnapshotPage[], identity: ConnectionIdentity): { pages: SnapshotPage[]; cursor: EventCursor; running: boolean } {
  if (!pages.length || pages.length > 32) throw new Error('RESYNC_REQUIRED');
  let totalBytes = 0;
  const parsed = pages.map((page) => {
    const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
    totalBytes += bytes;
    if (bytes > SNAPSHOT_PAGE_BYTES || totalBytes > SNAPSHOT_TOTAL_BYTES) throw new Error('RESYNC_REQUIRED');
    return snapshotPageSchema.parse(page);
  });
  const header = parsed[0]?.header;
  if (!header?.eventStream || header.pageIds.length !== parsed.length || header.serverEpoch !== identity.serverEpoch
    || header.workspaceId !== identity.workspaceId || header.workspaceGeneration !== identity.workspaceGeneration
    || header.sessionId !== identity.sessionId) throw new Error('RESYNC_REQUIRED');
  const cursor = eventCursorSchema.parse(header.eventStream);
  if (cursor.serverEpoch !== identity.serverEpoch || cursor.workspaceId !== identity.workspaceId
    || cursor.workspaceGeneration !== identity.workspaceGeneration) throw new Error('RESYNC_REQUIRED');
  for (let index = 0; index < parsed.length; index++) {
    const page = parsed[index]!;
    if (page.index !== index || page.snapshotId !== header.snapshotId || page.pageId !== header.pageIds[index]
      || page.nextPageId !== (header.pageIds[index + 1] ?? null) || (index > 0 && page.header)) throw new Error('RESYNC_REQUIRED');
  }
  return { pages: parsed, cursor, running: header.controls.streaming || header.controls.activeSessionRunning || header.controls.runningSessionCount > 0 };
}

/** Transport-independent, fail-closed owner for one selected network view. Never starts the desktop runtime. */
export class WorkspaceClient {
  private readonly connection = new ConnectionState();
  private selected: SelectedView | null = null;
  private identity: ConnectionIdentity | null = null;
  private cursor: EventCursor | null = null;
  private gate: EventReplayGate | null = null;
  private aborter: AbortController | null = null;
  private close: (() => void) | null = null;
  private readonly drafts = new Map<string, string>();
  private readonly pending = new Map<string, PendingOutcome[]>();
  private readonly retryLimit: number;
  private readonly autoReconnect: boolean;
  private retryTimer: AbortController | null = null;
  private automaticAttempts = 0;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  constructor(private readonly transport: WorkspaceTransport, private readonly sink: WorkspaceSink,
    options: { retryLimit?: number; autoReconnect?: boolean; wait?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number } = {}) {
    this.retryLimit = options.retryLimit ?? 3;
    if (!Number.isSafeInteger(this.retryLimit) || this.retryLimit < 1 || this.retryLimit > 5) throw new Error('Invalid retry limit');
    this.autoReconnect = options.autoReconnect ?? true;
    this.wait = options.wait ?? defaultWait;
    this.now = options.now ?? Date.now;
  }
  get state(): ConnectionView { return this.connection.current; }
  private notify(): void { this.sink.connection?.(this.state); }
  private markUncertain(): void {
    if (!this.selected) return;
    const items = this.pending.get(key(this.selected));
    if (!items) return;
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      if (item.status === 'sending') items[index] = { ...item, status: 'outcome_unknown' };
    }
  }
  private clearTransport(): void {
    this.markUncertain();
    this.retryTimer?.abort(); this.retryTimer = null;
    this.aborter?.abort(); this.aborter = null; this.close?.(); this.close = null;
  }
  private lost(resync = false): void {
    const selected = this.selected;
    this.disconnect();
    if (resync) { this.cursor = null; this.gate = null; }
    if (!selected || !this.autoReconnect || this.automaticAttempts >= this.retryLimit) return;
    const attempt = ++this.automaticAttempts;
    const generation = this.state.generation;
    const timer = new AbortController(); this.retryTimer = timer;
    void this.wait(Math.min(4_000, 250 * 2 ** (attempt - 1)), timer.signal).then(() => {
      if (!timer.signal.aborted && this.state.generation === generation && sameSelection(this.selected, selected)) {
        this.retryTimer = null;
        void this.connectInternal();
      }
    }).catch(() => undefined);
  }
  select(input: SelectedView): void {
    const view = selectedViewSchema.parse(input);
    if (sameSelection(this.selected, view)) return;
    this.clearTransport();
    this.automaticAttempts = 0;
    this.connection.replaceView();
    this.selected = { ...view };
    this.identity = null; this.cursor = null; this.gate = null;
    this.notify();
  }
  disconnect(): void { this.clearTransport(); this.connection.disconnect('Connection lost. Last confirmed state is shown.'); this.notify(); }
  setDraft(text: string): void {
    if (!this.selected || text.length > 16_384) throw new Error('DRAFT_UNAVAILABLE');
    const scope = key(this.selected);
    if (!this.drafts.has(scope) && this.drafts.size >= 50) throw new Error('DRAFT_LIMIT');
    this.drafts.set(scope, text);
  }
  draft(view: SelectedView): string { return this.drafts.get(key(view)) ?? ''; }
  outcomes(view: SelectedView): readonly PendingOutcome[] { return [...(this.pending.get(key(view)) ?? [])]; }
  private current(view: SelectedView, generation: number, identity?: ConnectionIdentity): boolean {
    return sameSelection(this.selected, view) && this.state.generation === generation && !this.aborter?.signal.aborted
      && (!identity || (this.identity !== null && sameIdentity(this.identity, identity)));
  }
  /** Explicit read only. Its response must carry the actual server and scope identity. */
  async read<T>(operation: (signal: AbortSignal) => Promise<ScopedResponse<T>>, apply: (value: T) => void): Promise<boolean> {
    const view = this.selected, identity = this.identity, generation = this.state.generation;
    if (!view || !identity || !this.gate || !this.aborter || !['observing', 'controlling'].includes(this.state.status)) return false;
    const result = await operation(this.aborter.signal);
    if (!this.current(view, generation, identity) || !sameIdentity(identitySchema.parse(result.identity), identity)) return false;
    apply(result.value);
    return true;
  }
  /** The operation is submitted once. A lost, stale or unverified response is unknown, not a retry. */
  async mutate<T>(requestId: string, text: string, operation: (signal: AbortSignal) => Promise<ScopedResponse<T>>): Promise<T> {
    const view = this.selected, identity = this.identity, generation = this.state.generation;
    if (!view || !identity || !this.gate || !this.aborter || this.state.status !== 'controlling'
      || this.state.permissionLevel === 'read-only') throw new Error('CONNECTION_UNAVAILABLE');
    if (!requestId || requestId.length > 250 || text.length > 16_384) throw new Error('INVALID_REQUEST');
    const scope = key(view);
    if (!this.pending.has(scope) && this.pending.size >= 50) throw new Error('OUTCOME_LIMIT');
    const items = this.pending.get(scope) ?? [];
    if (items.some((item) => item.requestId === requestId)) throw new Error('REQUEST_ALREADY_RECORDED');
    if (items.length >= 128) {
      const settled = items.findIndex((item) => item.status === 'confirmed');
      if (settled < 0) throw new Error('OUTCOME_LIMIT');
      items.splice(settled, 1);
    }
    const outcome: PendingOutcome = { requestId, text, status: 'sending' };
    items.push(outcome); this.pending.set(scope, items);
    try {
      const result = await operation(this.aborter.signal);
      if (!this.current(view, generation, identity) || !sameIdentity(identitySchema.parse(result.identity), identity)) throw new Error('OUTCOME_UNKNOWN');
      items[items.indexOf(outcome)] = { ...outcome, status: 'confirmed' };
      return result.value;
    } catch {
      items[items.indexOf(outcome)] = { ...outcome, status: 'outcome_unknown' };
      throw new Error('OUTCOME_UNKNOWN');
    }
  }
  /** Only handshake/snapshot/replay are retried. A confirmed matching epoch may replay; any
   * changed identity or expired replay must use the subscription-before-snapshot barrier. */
  async connect(): Promise<void> { this.automaticAttempts = 0; return this.connectInternal(); }
  private async connectInternal(): Promise<void> {
    const view = this.selected;
    if (!view) throw new Error('WORKSPACE_NOT_SELECTED');
    const formerIdentity = this.identity, formerCursor = this.cursor;
    this.clearTransport();
    const generation = this.connection.begin(view.hostId, view.hostName, view.workspaceName, formerCursor !== null);
    const aborter = new AbortController(); this.aborter = aborter; this.notify();
    for (let attempt = 0; attempt < this.retryLimit; attempt++) {
      if (!this.current(view, generation)) return;
      const attemptController = new AbortController();
      const stopAttempt = () => attemptController.abort();
      aborter.signal.addEventListener('abort', stopAttempt, { once: true });
      try {
        this.connection.change(generation, 'authenticating'); this.notify();
        const handshake = handshakeSchema.parse(await bounded(this.transport.handshake(view, attemptController.signal), attemptController.signal));
        if (!this.current(view, generation)) return;
        if (handshake.serverId !== view.hostId || handshake.workspaceId !== view.workspaceId
          || handshake.workspaceGeneration !== view.workspaceGeneration || handshake.sessionId !== view.sessionId) throw new Error('INCOMPATIBLE_HOST');
        this.connection.change(generation, 'synchronizing'); this.notify();
        this.identity = handshake;
        const after = formerIdentity && formerCursor && sameIdentity(formerIdentity, handshake) ? formerCursor : undefined;
        let fresh = false;
        for (;;) {
          const buffered: EventEnvelope[] = [];
          let bufferedBytes = 0;
          let active = true;
          const onEvent = (item: EventEnvelope) => {
            if (!active || attemptController.signal.aborted || !this.current(view, generation, handshake)) return;
            if (!this.gate || this.state.status === 'synchronizing') {
              let bytes: number;
              try { bytes = new TextEncoder().encode(JSON.stringify(item)).byteLength; }
              catch { active = false; this.lost(true); return; }
              if (buffered.length >= EVENT_UNSENT_COUNT || bufferedBytes + bytes > EVENT_UNSENT_BYTES) {
                active = false; this.lost(true);
              } else { buffered.push(item); bufferedBytes += bytes; }
            } else this.deliver(item, view, generation, handshake);
          };
          const onDisconnect = () => { if (active && !attemptController.signal.aborted && this.current(view, generation, handshake)) this.lost(); };
          let opened: OpenResult;
          try {
            const opening = this.transport.open(handshake, fresh ? undefined : after, onEvent, onDisconnect, attemptController.signal);
            // If a transport ignores cancellation and resolves after the deadline,
            // still close its late subscription. It cannot paint a stale view.
            void opening.then((value) => { if (attemptController.signal.aborted) value.close(); }).catch(() => undefined);
            opened = await bounded(opening, attemptController.signal);
          }
          catch (error) {
            active = false;
            if (!fresh && after && error instanceof Error && error.message === 'RESYNC_REQUIRED') { fresh = true; continue; }
            throw error;
          }
          if (!this.current(view, generation, handshake)) { active = false; opened.close(); return; }
          const response = identitySchema.parse(opened.identity);
          if (!sameIdentity(response, handshake)) { active = false; opened.close(); throw new Error('INCOMPATIBLE_HOST'); }
          try {
            let hydratedRuntime: RuntimeState | void = undefined;
            let running = this.state.lastConfirmedStatus === 'running';
            const onRunning = (value: boolean) => { running = value; };
            if (opened.kind === 'snapshot') {
              // A confirmed snapshot is authoritative even if a replay was requested;
              // the transport may replace an expired replay with its atomic barrier.
              const snapshot = checkedPages(opened.pages, handshake);
              hydratedRuntime = this.sink.snapshot(snapshot.pages);
              if (hydratedRuntime && hydratedRuntime.sessionId !== view.sessionId) throw new Error('RESYNC_REQUIRED');
              this.gate = new EventReplayGate(snapshot.cursor); this.cursor = snapshot.cursor;
              running = snapshot.running;
            } else {
              if (!after || fresh || !sameCursor(opened.after, after)) throw new Error('RESYNC_REQUIRED');
              this.gate = new EventReplayGate(after); this.cursor = after;
              for (const item of opened.events) this.deliver(item, view, generation, handshake, undefined, onRunning);
            }
            if (!this.current(view, generation, handshake)) { active = false; opened.close(); return; }
            this.close = () => { active = false; opened.close(); };
            // Pi reconciliation is about payloads represented by a *full* local
            // hydration, not network envelope sequences or clipped display pages.
            const projected = new Map<number, PiEvent>();
            const projectedBoundary = buffered.length;
            if (hydratedRuntime) {
              const piPositions = buffered.flatMap((item, index) => item.event.kind === 'pi'
                && item.origin.sessionId === view.sessionId ? [index] : []);
              const piEvents = piPositions.map((index) => {
                const item = buffered[index]!;
                if (item.event.kind !== 'pi') throw new Error('RESYNC_REQUIRED');
                return item.event.event;
              });
              for (const entry of reconcileHydrationEventEntries(hydratedRuntime, piEvents)) {
                projected.set(piPositions[entry.index]!, entry.event);
              }
            }
            for (let index = 0; index < buffered.length; index++) {
              const item = buffered[index]!;
              // Entries published reentrantly by a sink are after the original
              // hydration batch. They need the same network gate, not Pi snapshot filtering.
              this.deliver(item, view, generation, handshake,
                hydratedRuntime && index < projectedBoundary && item.event.kind === 'pi' && item.origin.sessionId === view.sessionId
                  ? projected.get(index) ?? null : undefined, onRunning);
              if (!this.current(view, generation, handshake)) return;
            }
            if (!this.current(view, generation, handshake)) return;
            this.connection.confirmed(generation, handshake.serverEpoch, handshake.control, handshake.permissionLevel, running, this.now());
            // Count consecutive failed/lost attempts, not successful connection cycles.
            // An exhausted burst still stops; a confirmed new connection gets a fresh budget.
            this.automaticAttempts = 0;
            this.notify();
            return;
          } catch (error) { active = false; opened.close(); throw error; }
        }
      } catch (error) {
        attemptController.abort();
        aborter.signal.removeEventListener('abort', stopAttempt);
        if (!this.current(view, generation)) return;
        this.close?.(); this.close = null; this.gate = null;
        if (error instanceof Error && error.message === 'INCOMPATIBLE_HOST') {
          this.connection.change(generation, 'incompatible', { message: 'Host or workspace identity changed.' }); this.notify(); return;
        }
        if (attempt + 1 === this.retryLimit) {
          this.connection.change(generation, 'error', { message: error instanceof Error ? error.message : 'Connection failed.' }); this.notify(); return;
        }
        this.connection.change(generation, 'reconnecting'); this.notify();
        try { await this.wait(Math.min(4_000, 250 * 2 ** attempt), aborter.signal); } catch { return; }
      }
    }
  }
  private deliver(input: EventEnvelope, view: SelectedView, generation: number, identity: ConnectionIdentity,
    projected?: PiEvent | null, onRunning?: (running: boolean) => void): void {
    if (!this.current(view, generation, identity) || !this.gate) return;
    try {
      const parsed = eventEnvelopeSchema.parse(input);
      const accepted = this.gate.accept(parsed);
      if (!accepted) return;
      const visible = projected && parsed.event.kind === 'pi'
        ? { ...parsed, event: { ...parsed.event, event: projected } } : parsed;
      if (projected !== null) {
        if (parsed.origin.sessionId === view.sessionId) this.sink.event(visible);
        else this.sink.background?.(visible);
      }
      if (!this.current(view, generation, identity)) return;
      const previous = this.cursor;
      const sameStream = previous?.serverEpoch === parsed.serverEpoch && previous.streamId === parsed.streamId
        && previous.workspaceId === parsed.origin.workspaceId
        && previous.workspaceGeneration === parsed.origin.workspaceGeneration;
      // A sink can synchronously deliver the next envelope before this call resumes.
      // Never roll back its acknowledgment or last-confirmed run status. Do not
      // compare sequence numbers across a new server epoch or workspace stream.
      if (sameStream && previous.sequence >= parsed.sequence) return;
      this.cursor = { serverEpoch: parsed.serverEpoch, streamId: parsed.streamId, workspaceId: parsed.origin.workspaceId,
        workspaceGeneration: parsed.origin.workspaceGeneration, sequence: parsed.sequence };
      const pi = projected !== null && parsed.event.kind === 'pi' && parsed.origin.sessionId === view.sessionId
        ? projected ?? parsed.event.event : null;
      const running = pi?.type === 'run.started' ? true : pi?.type === 'run.completed' ? false
        : pi?.type === 'state.changed' ? pi.state.streaming || Boolean(pi.state.activeSessionRunning) : undefined;
      if (onRunning) { if (running !== undefined) onRunning(running); }
      else {
        this.connection.confirmed(generation, identity.serverEpoch, this.state.control ?? 'observing',
          this.state.permissionLevel ?? 'read-only', running ?? (this.state.lastConfirmedStatus === 'running'), this.now());
        this.notify();
      }
    } catch { this.lost(true); }
  }
}
function sameCursor(a: EventCursor, b: EventCursor): boolean {
  const left = eventCursorSchema.parse(a), right = eventCursorSchema.parse(b);
  return left.serverEpoch === right.serverEpoch && left.workspaceId === right.workspaceId
    && left.workspaceGeneration === right.workspaceGeneration && left.streamId === right.streamId && left.sequence === right.sequence;
}
