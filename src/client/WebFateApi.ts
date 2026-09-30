import { z } from 'zod';
import type { MonitorReadInput } from '../shared/contracts/monitorDashboard';
import { networkEventSchema, type NetworkEvent, type NetworkMonitor } from '../shared/protocol/diagnostics';
import { methodCatalog, publicWorkspaceSchema, type Capability, type WireResultOf } from '../shared/protocol/methods';
import { requestEnvelopeSchema, type MutationRequest, type ProtocolResponse, type RequestOf, type WireRequest, utf8Bytes } from '../shared/protocol/envelopes';
import { type SnapshotHeader, type SnapshotItem, type SnapshotPage, SNAPSHOT_PAGE_BYTES, SNAPSHOT_TOTAL_BYTES } from '../shared/protocol/snapshots';
import { type EventCursor } from '../shared/protocol/events';
import { createMutationIdentity, createServerEpoch, mutationRequestIdSchema } from '../shared/protocol/requestIds';
import type { CommandStatus, MutationReceipt } from '../shared/protocol/commandOutcomes';
import { HttpCommandTransport, UnconfirmedCommand } from './HttpCommandTransport';
import { EventTransport, type EventConnectionInfo } from './EventTransport';
import type { FateApi } from './FateApi';
import type { InputOf } from '../shared/protocol/methods';
import { type HostReadMethod, type OperationMethod, operationMethodSchema, hostOperationJournalMethods } from '../shared/protocol/hostOperations';
import { textUploadDisplaySchema, type TextAttachmentReceipt, textAttachmentIdSchema } from '../shared/protocol/attachments';

const originPattern = /^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/u;
const authSessionSchema = z.object({ session: z.object({ sessionId: z.string().uuid(), expiresAt: z.number().int().positive().safe(),
  csrfToken: z.string().regex(/^fx1_[A-Za-z0-9_-]{43}$/u) }).strict() }).strict();
const infoSchema = z.object({ protocol: z.literal(1), serverEpoch: z.string().uuid(), serverTime: z.number().int().nonnegative().safe(),
  kind: z.literal('browser'), capabilities: z.array(z.string().min(1).max(64)).max(32), workspaceCount: z.number().int().min(0).max(8) }).strict();
const bootstrapCodeSchema = z.string().regex(/^fb1_[A-Za-z0-9_-]{43}$/u);
const MAX_AUTH_RESPONSE_BYTES = 8_192;
const PENDING_REVIEW_PREFIX = 'fate.web.pending-prompt.v1:';
const pendingMethodSchema = z.enum(hostOperationJournalMethods);
export type PendingCommandMethod = z.infer<typeof pendingMethodSchema>;
const pendingPromptReviewSchema = z.object({ version: z.literal(1), origin: z.string(), authSessionId: z.string().uuid(),
  hostId: z.string().uuid().optional(), method: pendingMethodSchema.default('runtime.prompt'),
  workspaceId: z.string().uuid(), workspaceGeneration: z.number().int().positive().safe(), sessionId: z.string().uuid(),
  serverEpoch: z.string().uuid(), requestId: mutationRequestIdSchema }).strict();
export type PendingPromptReview = z.infer<typeof pendingPromptReviewSchema>;
export type PendingPromptReviewLookup = { readonly kind: 'none' } | { readonly kind: 'match'; readonly value: PendingPromptReview }
  | { readonly kind: 'blocked'; readonly reason: 'unavailable' | 'corrupt' | 'mismatch'; readonly value?: PendingPromptReview };
function pendingReviewStorageKey(origin: string, authSessionId: string): string {
  return `${PENDING_REVIEW_PREFIX}${encodeURIComponent(origin)}:${authSessionId}`;
}

export type BrowserSession = z.infer<typeof authSessionSchema>['session'];
export type WebWorkspace = z.infer<typeof publicWorkspaceSchema>;
export interface WebSnapshot { readonly header: SnapshotHeader; readonly items: readonly SnapshotItem[] }
export interface ScopedNetworkMonitor { readonly scope: WebWorkspace; readonly dashboard: NetworkMonitor }
export type WebFileList = import('../shared/protocol/methods').WireResultOf<'file.list'>;
export type WebFilePreview = import('../shared/protocol/methods').WireResultOf<'file.previewText'>;
export type WebGoalRead = WireResultOf<'goal.get'>;
export type WebTaskRead = WireResultOf<'task.list'>;
export type WebGitStatus = WireResultOf<'git.status'>;
export type WebGitHistory = WireResultOf<'git.history'>;
export type WebInput<M extends import('../shared/protocol/methods').MethodName> = z.input<(typeof methodCatalog)[M]['inputSchema']>;
export interface WebEventClient {
  readonly connection: EventConnectionInfo | null;
  connect(): Promise<EventConnectionInfo>;
  subscribe(workspaceId: string, workspaceGeneration: number, cursor?: EventCursor): Promise<EventCursor>;
  close(): void;
}
interface WebClientOptions {
  readonly send?: typeof fetch;
  readonly makeEvents?: (onEvent: (event: NetworkEvent) => void, csrf: () => string, onDisconnect: () => void) => WebEventClient;
  readonly onAuthenticationLost?: () => void;
}

function sameWorkspace(left: WebWorkspace | null, right: WebWorkspace): boolean {
  return left !== null && left.workspaceId === right.workspaceId && left.workspaceGeneration === right.workspaceGeneration;
}
function receiptMatchesPending(receipt: MutationReceipt, method: PendingCommandMethod): boolean {
  if (method === 'runtime.prompt') return receipt.kind === 'prompt';
  if (method === 'runtime.abort') return receipt.kind === 'abort';
  if (method === 'session.select') return receipt.kind === 'selection';
  if (method === 'permission.confirm') return receipt.kind === 'permission';
  return receipt.kind === 'operation' && receipt.operation === method;
}
function checkedOrigin(origin: string): string {
  if (!originPattern.test(origin) || Number(origin.slice(origin.lastIndexOf(':') + 1)) > 65_535) {
    throw new Error('Browser access requires an explicit loopback origin.');
  }
  return origin;
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The server returned an empty authentication response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_AUTH_RESPONSE_BYTES) throw new Error('The authentication response is too large.');
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
function browserRequest(method: 'GET' | 'POST', body?: string, csrf?: string): RequestInit {
  return { method, credentials: 'include', cache: 'no-store', referrerPolicy: 'no-referrer',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Fate-Csrf': csrf } : {}) }, body }) };
}
/** The cookie stays HttpOnly. Recover a same-origin session and keep only its CSRF token in memory. */
export async function recoverBrowserSession(origin: string, send: typeof fetch = fetch): Promise<BrowserSession | null> {
  const response = await send(`${checkedOrigin(origin)}/api/auth/session`, browserRequest('GET'));
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('The browser session could not be recovered.');
  const session = authSessionSchema.parse(await boundedJson(response)).session;
  return session.expiresAt > Date.now() ? session : null;
}
/** The one-time code is only a POST body. Never read codes from URLs or browser storage. */
export async function exchangeBrowserCode(origin: string, code: string, send: typeof fetch = fetch): Promise<BrowserSession> {
  const response = await send(`${checkedOrigin(origin)}/api/auth/exchange`, browserRequest('POST',
    JSON.stringify({ code: bootstrapCodeSchema.parse(code.trim()) })));
  if (!response.ok) throw new Error(response.status === 401 ? 'The code is invalid or expired.' : 'Login failed. Request a new code on the host.');
  return authSessionSchema.parse(await boundedJson(response)).session;
}

function unsupported(name: keyof FateApi): (...arguments_: unknown[]) => Promise<never> {
  return async () => { throw new Error(`UNSUPPORTED_CAPABILITY: ${name} is not supported in the browser network adapter.`); };
}
function unsupportedEvents(name: keyof FateApi): () => never {
  return () => { throw new Error(`UNSUPPORTED_CAPABILITY: ${name} is not supported in the browser network adapter. Network metadata is not a PiEvent.`); };
}
/** Every shared operation is accounted for. Unsupported calls reject; none return a fake success. */
export function unsupportedWebFateMethods(): FateApi {
  return {
    abort: unsupported('abort'), clearGoalMax: unsupported('clearGoalMax'), clearTasks: unsupported('clearTasks'),
    cloneSession: unsupported('cloneSession'), closeProjectRuntime: unsupported('closeProjectRuntime'), compact: unsupported('compact'),
    controlAgentTeam: unsupported('controlAgentTeam'), controlGoalMax: unsupported('controlGoalMax'), controlSubagent: unsupported('controlSubagent'),
    createGoalMax: unsupported('createGoalMax'), createTask: unsupported('createTask'), createWorktreeSession: unsupported('createWorktreeSession'),
    deleteProjectSessions: unsupported('deleteProjectSessions'), deleteSession: unsupported('deleteSession'), deleteSessionBranch: unsupported('deleteSessionBranch'),
    deleteTask: unsupported('deleteTask'), editGoalMaxSteering: unsupported('editGoalMaxSteering'), forkSession: unsupported('forkSession'),
    getGitCombinedDiff: unsupported('getGitCombinedDiff'), getGitCommitDetails: unsupported('getGitCommitDetails'),
    getGitDiff: unsupported('getGitDiff'), getGitHistory: unsupported('getGitHistory'), getGitStatus: unsupported('getGitStatus'),
    getGoalMax: unsupported('getGoalMax'), getMonitorDashboard: unsupported('getMonitorDashboard'),
    getRuntimeState: unsupported('getRuntimeState'), getTaskList: unsupported('getTaskList'), listFiles: unsupported('listFiles'),
    listGitWorktrees: unsupported('listGitWorktrees'), listProjectSessions: unsupported('listProjectSessions'), listSessions: unsupported('listSessions'),
    mutateQueuedMessage: unsupported('mutateQueuedMessage'), navigateSessionBranch: unsupported('navigateSessionBranch'),
    newSession: unsupported('newSession'), onEvents: unsupportedEvents('onEvents'), onGoalMaxEvents: unsupportedEvents('onGoalMaxEvents'),
    onTaskEvents: unsupportedEvents('onTaskEvents'), optimizePrompt: unsupported('optimizePrompt'), prompt: unsupported('prompt'),
    queryAttestations: unsupported('queryAttestations'), readFile: unsupported('readFile'), removeGoalMaxSteering: unsupported('removeGoalMaxSteering'),
    renameSession: unsupported('renameSession'), reorderTasks: unsupported('reorderTasks'), revertGitPath: unsupported('revertGitPath'),
    runGitOperation: unsupported('runGitOperation'), searchFiles: unsupported('searchFiles'), sendSessionMessage: unsupported('sendSessionMessage'),
    setModel: unsupported('setModel'), setPermissionLevel: unsupported('setPermissionLevel'), setThinkingLevel: unsupported('setThinkingLevel'),
    switchGitWorktree: unsupported('switchGitWorktree'), switchSession: unsupported('switchSession'), updateGoalMax: unsupported('updateGoalMax'),
    updateTask: unsupported('updateTask'),
  };
}

function assertScope(response: ProtocolResponse, scope: WebWorkspace, epoch: string): void {
  if (!response.ok || response.serverEpoch !== epoch || !response.scope || response.scope.workspaceId !== scope.workspaceId
    || response.scope.workspaceGeneration !== scope.workspaceGeneration) throw new Error('Stale workspace response. Refresh the selected workspace.');
}
function resultOrError(response: ProtocolResponse): void {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message} ${response.error.recovery}`);
}

/** A bounded browser facade. It never replays an uncertain mutation or invents RuntimeState. */
export class WebFateApi {
  private readonly send: typeof fetch;
  private readonly events: WebEventClient;
  private readonly commands: HttpCommandTransport;
  private readonly invalidationListeners = new Set<() => void>();
  private csrf: string;
  private readonly browserSessionId: string;
  private epoch: string | null = null;
  private hostMetadata: { hostId: string; hostName: string; appVersion: string; protocol: 1; takeoverAllowed: boolean } | null = null;
  private confirmedAt: number | null = null;
  private acknowledgeableRequestId: string | null = null;
  private capabilities = new Set<Capability>();
  private selected: WebWorkspace | null = null;
  private selectedSnapshot: SnapshotHeader | null = null;
  private controlGeneration: number | null = null;
  private controlExpiresAt: number | null = null;
  private latestControlGeneration: number | null = null;
  private serverClockAtSync = 0;
  private performanceAtSync = 0;
  private viewRevision = 0;
  private connected = false;
  private lifecycle = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private retryCount = 0;
  private recoveryError: string | null = null;
  private readonly onAuthenticationLost: (() => void) | undefined;
  readonly shared: FateApi = unsupportedWebFateMethods();

  constructor(readonly origin: string, session: BrowserSession, options: WebClientOptions = {}) {
    checkedOrigin(origin);
    const validated = authSessionSchema.shape.session.parse(session);
    this.csrf = validated.csrfToken;
    this.browserSessionId = validated.sessionId;
    // Native browser fetch rejects a foreign `this` (this.send would bind WebFateApi).
    this.send = options.send ?? ((input, init) => globalThis.fetch(input, init));
    this.onAuthenticationLost = options.onAuthenticationLost;
    this.events = options.makeEvents?.((event) => this.invalidate(event), () => this.csrf, () => this.lostConnection())
      ?? new EventTransport(`${origin.replace(/^http:/u, 'ws:')}/api/events`, () => this.csrf,
        (event) => this.invalidate(event), undefined, () => this.lostConnection());
    this.commands = new HttpCommandTransport(origin, () => ({ 'X-Fate-Csrf': this.csrf }), () => this.events.connection?.ticket ?? null,
      async (input, init) => {
        const response = await this.send(input, init);
        if (response.status === 401) { this.close(); this.onAuthenticationLost?.(); throw new Error('The browser session expired. Sign in again.'); }
        return response;
      });
  }
  /** Authenticated cookie-session identity, never the CSRF secret or principal authority. */
  get authenticatedSessionId(): string { return this.browserSessionId; }
  /** Current host epoch. A saved uncertain ID keeps its original embedded epoch. */
  get serverEpoch(): string | null { return this.epoch; }
  /** Prove tab-scoped storage is writable before starting an effect that may need reload recovery. */
  assertPendingReviewStorageAvailable(): void {
    let storage: Storage;
    try { storage = globalThis.sessionStorage; } catch { throw new Error('Safe pending-command recovery storage is unavailable. Prompt was not sent.'); }
    if (!storage) throw new Error('Safe pending-command recovery storage is unavailable. Prompt was not sent.');
    const probe = `${PENDING_REVIEW_PREFIX}probe:${this.browserSessionId}`;
    try { storage.setItem(probe, '1'); storage.removeItem(probe); }
    catch { throw new Error('Safe pending-command recovery storage is unavailable. Prompt was not sent.'); }
  }
  /** Store only request identity in tab-scoped storage. Prompt text and credentials never enter storage. */
  rememberPendingPromptReview(scope: WebWorkspace, sessionId: string, requestId: string, method: PendingCommandMethod = 'runtime.prompt'): void {
    const parsedId = mutationRequestIdSchema.parse(requestId);
    const [requestEpoch] = parsedId.split('.');
    this.acknowledgeableRequestId = null;
    const value = pendingPromptReviewSchema.parse({ version: 1, origin: this.origin, authSessionId: this.browserSessionId, method,
      ...(this.hostMetadata ? { hostId: this.hostMetadata.hostId } : {}), workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration, sessionId, serverEpoch: requestEpoch, requestId: parsedId });
    let storage: Storage;
    try { storage = globalThis.sessionStorage; } catch { throw new Error('Safe pending-command recovery storage is unavailable. Do not send another prompt in this tab.'); }
    if (!storage) throw new Error('Safe pending-command recovery storage is unavailable. Do not send another prompt in this tab.');
    storage.setItem(pendingReviewStorageKey(this.origin, this.browserSessionId), JSON.stringify(value));
  }
  pendingPromptReview(scope: WebWorkspace, sessionId: string): PendingPromptReviewLookup {
    let storage: Storage;
    try { storage = globalThis.sessionStorage; } catch { return { kind: 'blocked', reason: 'unavailable' }; }
    if (!storage) return { kind: 'blocked', reason: 'unavailable' };
    const key = pendingReviewStorageKey(this.origin, this.browserSessionId);
    let raw: string | null;
    try { raw = storage.getItem(key); } catch { return { kind: 'blocked', reason: 'unavailable' }; }
    if (raw === null) return { kind: 'none' };
    let value: PendingPromptReview;
    try { value = pendingPromptReviewSchema.parse(JSON.parse(raw) as unknown); } catch { return { kind: 'blocked', reason: 'corrupt' }; }
    const [requestEpoch] = value.requestId.split('.');
    if (value.origin !== this.origin || value.authSessionId !== this.browserSessionId || value.serverEpoch !== requestEpoch) {
      return { kind: 'blocked', reason: 'corrupt' };
    }
    if (value.workspaceId !== scope.workspaceId
      || value.hostId !== undefined && this.hostMetadata !== null && value.hostId !== this.hostMetadata.hostId) {
      return { kind: 'blocked', reason: 'mismatch' };
    }
    if (value.sessionId !== sessionId || value.workspaceGeneration !== scope.workspaceGeneration) {
      return { kind: 'blocked', reason: 'mismatch', value }; // Same durable workspace may review original scope; never retarget.
    }
    return { kind: 'match', value };
  }
  /** Explicit acknowledgment only after correlated settled/rejected proof. Unknown/absent cannot be erased. */
  clearPendingPromptReview(): void {
    let storage: Storage; let raw: string | null;
    try { storage = globalThis.sessionStorage; raw = storage.getItem(pendingReviewStorageKey(this.origin, this.browserSessionId)); }
    catch { throw new Error('Original command review storage is unavailable.'); }
    if (raw === null) return;
    let value: PendingPromptReview;
    try { value = pendingPromptReviewSchema.parse(JSON.parse(raw) as unknown); }
    catch { throw new Error('Original command review storage is invalid.'); }
    if (value.requestId !== this.acknowledgeableRequestId) throw new Error('Review a correlated settled or rejected original outcome before acknowledging it.');
    storage.removeItem(pendingReviewStorageKey(this.origin, this.browserSessionId)); this.acknowledgeableRequestId = null;
  }
  private clearConfirmedPending(requestId: string): void {
    this.acknowledgeableRequestId = requestId;
    this.clearPendingPromptReview();
  }
  /** Authenticated metadata only. Never a credential or a renderer-selected authority. */
  get hostIdentity() { return this.hostMetadata ? Object.freeze({ ...this.hostMetadata }) : null; }
  get hostId(): string | null { return this.hostMetadata?.hostId ?? null; }
  get hostName(): string | null { return this.hostMetadata?.hostName ?? null; }
  get takeoverAllowed(): boolean { return this.isConnected && this.hostMetadata?.takeoverAllowed === true; }
  get estimatedHostTime(): number { return this.mutationTime(); }
  get lastConfirmedAt(): number | null { return this.confirmedAt; }
  pendingCommandReview(scope: WebWorkspace): PendingPromptReviewLookup {
    return this.pendingPromptReview(scope, this.selectedSnapshot?.sessionId ?? '');
  }
  get isConnected(): boolean { return this.connected && this.events.connection !== null; }
  get reconnectError(): string | null { return this.recoveryError; }
  get workspace(): WebWorkspace | null { return this.selected; }
  get control(): number | null {
    return this.isConnected && this.controlExpiresAt !== null && this.controlExpiresAt > this.estimatedHostTime ? this.controlGeneration : null;
  }
  supports(capability: Capability): boolean { return this.isConnected && this.capabilities.has(capability); }
  onInvalidate(listener: () => void): () => void { this.invalidationListeners.add(listener); return () => { this.invalidationListeners.delete(listener); }; }
  private notify(): void { for (const listener of this.invalidationListeners) listener(); }
  private lostConnection(): void {
    if (!this.csrf) return;
    this.connected = false;
    this.controlGeneration = null;
    this.controlExpiresAt = null;
    this.selectedSnapshot = null;
    this.viewRevision++;
    this.lifecycle++;
    this.notify();
    this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    if (this.retryTimer || this.reconnecting || !this.csrf) return;
    if (this.retryCount >= 3) {
      this.recoveryError = 'Connection recovery failed after three attempts. The last confirmed view is stale. Reload to retry; do not resend uncertain commands.';
      this.notify();
      return;
    }
    const delay = Math.min(2_000, 250 * 2 ** this.retryCount++);
    const generation = this.lifecycle;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (generation !== this.lifecycle || !this.csrf) return;
      this.reconnecting = true;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Connection recovery timed out.')), 12_000);
      });
      void Promise.race([this.authenticate(generation).then(async () => {
        if (generation !== this.lifecycle) return;
        // Recheck the registered scope under the NEW ticket before any view is trusted.
        const selected = this.selected;
        if (selected) {
          const registered = await this.listWorkspaces();
          if (generation !== this.lifecycle) return;
          if (!registered.some((item) => item.workspaceId === selected.workspaceId
            && item.workspaceGeneration === selected.workspaceGeneration)) {
            throw new Error('Workspace identity changed. The old view is stale; select a registered workspace again.');
          }
        }
        this.recoveryError = null;
        this.notify(); // The shared store now obtains a fresh snapshot/replay barrier.
      }), timeout]).catch((reason: unknown) => {
        if (generation !== this.lifecycle || !this.csrf) return;
        // Fence a late HTTP response before the next attempt opens a new ticket.
        if (reason instanceof Error && reason.message === 'Connection recovery timed out.') this.lifecycle++;
        this.connected = false;
        this.events.close();
        this.recoveryError = reason instanceof Error ? reason.message : 'Connection recovery failed.';
        this.notify();
      }).finally(() => {
        if (deadline) clearTimeout(deadline);
        this.reconnecting = false;
        if (!this.connected && this.csrf) this.scheduleReconnect();
      });
    }, delay);
  }
  private invalidate(value: NetworkEvent): void {
    const event = networkEventSchema.parse(value);
    if (!this.selected || event.serverEpoch !== this.epoch || event.origin.workspaceId !== this.selected.workspaceId
      || event.origin.workspaceGeneration !== this.selected.workspaceGeneration) return;
    if (event.category === 'control' && event.controlGeneration !== undefined) {
      // EventConnection already validated its scoped replay cursor. Do not miss takeover while pages are assembling.
      this.latestControlGeneration = Math.max(this.latestControlGeneration ?? 0, event.controlGeneration);
      if (this.controlGeneration !== null && this.controlGeneration !== event.controlGeneration) {
        this.controlGeneration = null; this.controlExpiresAt = null;
      }
    } else if (!this.selectedSnapshot || event.streamId !== this.selectedSnapshot.eventStream?.streamId) return;
    // Pi/GoalMax/task transitions invalidate projections, NOT an unchanged host lease.
    // Metadata only requests a new authoritative view. It is NEVER a PiEvent.
    this.viewRevision++;
    this.notify();
  }
  private assertControlScope(scope: WebWorkspace, epoch: string, generation: number): void {
    if (!this.isConnected || this.epoch !== epoch || !sameWorkspace(this.selected, scope)
      || this.latestControlGeneration !== null && generation < this.latestControlGeneration) {
      throw new Error('Control scope changed. Refresh before claiming again.');
    }
  }
  private async command(request: WireRequest): Promise<ProtocolResponse> {
    if (!this.isConnected || !this.epoch || request.serverEpoch !== this.epoch) throw new Error('The authenticated event connection is unavailable.');
    return this.commands.command(request);
  }
  private readId() { return { protocol: 1 as const, requestId: createServerEpoch(), serverEpoch: this.epoch!, issuedAt: Date.now() }; }
  private checkedWorkspace(scope: WebWorkspace): WebWorkspace {
    // The shared Monitor panel supplies a display session/revision beside the registered
    // workspace. Only host-issued workspace identity enters this method's wire scope.
    const parsed = publicWorkspaceSchema.parse({ workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, label: scope.label });
    if (!this.selected || parsed.workspaceId !== this.selected.workspaceId || parsed.workspaceGeneration !== this.selected.workspaceGeneration) {
      throw new Error('Select the registered workspace before reading it.');
    }
    return parsed;
  }
  async connect(): Promise<void> {
    if (this.connected || !this.csrf) throw new Error('A browser session is already active or has expired.');
    try { await this.authenticate(this.lifecycle); }
    catch (error) { this.events.close(); this.connected = false; throw error; }
  }
  private async authenticate(generation: number): Promise<void> {
    // Each attempt obtains its own socket ticket; a former ticket is never reused.
    const preflight = await this.send(`${this.origin}/api/info`, browserRequest('GET'));
    if (preflight.status === 401) { this.close(); this.onAuthenticationLost?.(); throw new Error('The browser session expired. Sign in again.'); }
    if (!preflight.ok) throw new Error('Could not negotiate the server protocol.');
    const info = infoSchema.parse(await boundedJson(preflight));
    this.serverClockAtSync = info.serverTime;
    this.performanceAtSync = globalThis.performance?.now() ?? 0;
    if (generation !== this.lifecycle || !this.csrf) return;
    const connection = await this.events.connect();
    if (generation !== this.lifecycle || !this.csrf) { this.events.close(); return; }
    if (connection.serverEpoch !== info.serverEpoch) { this.events.close(); throw new Error('The server restarted during authentication.'); }
    // A restarted host invalidates the old cursor, snapshot, lease and pending reads.
    if (this.epoch !== connection.serverEpoch) {
      this.selectedSnapshot = null;
      this.controlGeneration = null;
      this.controlExpiresAt = null;
      this.latestControlGeneration = null;
      this.viewRevision++;
    }
    this.epoch = connection.serverEpoch;
    this.connected = true;
    const response = await this.command({ ...this.readId(), method: 'host.info', input: {} });
    if (generation !== this.lifecycle || !this.csrf) return;
    resultOrError(response);
    if (!response.ok || response.method !== 'host.info' || response.result.serverEpoch !== this.epoch
      || response.result.protocol !== 1 || !response.result.networkDispatchEnabled) throw new Error('Incompatible or disabled server protocol.');
    if (this.hostMetadata && this.hostMetadata.hostId !== response.result.hostId) {
      this.selected = null; this.selectedSnapshot = null; this.controlGeneration = null; this.controlExpiresAt = null; this.viewRevision++;
      throw new Error('A different host owns this origin. The original command identity remains saved; no action was replayed.');
    }
    this.hostMetadata = { hostId: response.result.hostId, hostName: response.result.hostName ?? 'Fate host',
      appVersion: response.result.appVersion, protocol: response.result.protocol, takeoverAllowed: response.result.takeoverAllowed === true };
    this.capabilities = new Set(response.result.capabilities);
  }
  async listWorkspaces(): Promise<readonly WebWorkspace[]> {
    if (!this.supports('workspace.list')) throw new Error('workspace.list is not supported on this host.');
    const response = await this.command({ ...this.readId(), method: 'workspace.list', input: {} });
    resultOrError(response);
    if (!response.ok || response.method !== 'workspace.list') throw new Error('Unexpected workspace list response.');
    return response.result.workspaces;
  }
  private async capturePage(scope: WebWorkspace, pageId?: string): Promise<SnapshotPage> {
    const identity = this.readId();
    const request = pageId === undefined
      ? { ...identity, method: 'workspace.snapshot' as const, workspaceId: scope.workspaceId,
        workspaceGeneration: scope.workspaceGeneration, input: {} }
      : { ...identity, method: 'workspace.snapshotPage' as const, workspaceId: scope.workspaceId,
        workspaceGeneration: scope.workspaceGeneration, input: { pageId } };
    const response = await this.command(request);
    resultOrError(response);
    assertScope(response, scope, this.epoch!);
    if (!response.ok || response.method !== request.method) throw new Error('Unexpected snapshot response.');
    if (response.method === 'workspace.snapshot' || response.method === 'workspace.snapshotPage') return response.result;
    throw new Error('Unexpected snapshot result.');
  }
  async readSnapshot(workspace: WebWorkspace): Promise<WebSnapshot> {
    if (!this.supports('workspace.snapshot')) throw new Error('workspace.snapshot is not supported on this host.');
    const scope = publicWorkspaceSchema.parse(workspace);
    if (this.selected?.workspaceId !== scope.workspaceId || this.selected.workspaceGeneration !== scope.workspaceGeneration) {
      this.controlGeneration = null;
      this.controlExpiresAt = null;
      this.latestControlGeneration = null;
    }
    this.selected = scope;
    this.selectedSnapshot = null;
    const revision = ++this.viewRevision;
    const first = await this.capturePage(scope);
    const header = first.header;
    if (!header || first.index !== 0 || first.pageId !== header.pageIds[0] || first.snapshotId !== header.snapshotId
      || header.serverEpoch !== this.epoch || header.workspaceId !== scope.workspaceId
      || header.workspaceGeneration !== scope.workspaceGeneration || header.expiresAt <= this.estimatedHostTime
      || !header.eventStream || header.eventStream.serverEpoch !== this.epoch
      || header.eventStream.workspaceId !== scope.workspaceId || header.eventStream.workspaceGeneration !== scope.workspaceGeneration) {
      throw new Error('Invalid snapshot header or stream cursor. Refresh this workspace.');
    }
    const items: SnapshotItem[] = [];
    let page: SnapshotPage = first;
    let bytes = 0;
    for (let index = 0; index < header.pageIds.length; index++) {
      if (revision !== this.viewRevision || !this.isConnected) throw new Error('Snapshot invalidated. Refresh this workspace.');
      if (page.index !== index || page.snapshotId !== header.snapshotId || page.pageId !== header.pageIds[index]
        || (index > 0 && page.header !== undefined) || page.nextPageId !== (header.pageIds[index + 1] ?? null)) {
        throw new Error('Snapshot page does not belong to the selected transaction.');
      }
      const pageBytes = utf8Bytes(JSON.stringify(page));
      bytes += pageBytes;
      if (pageBytes > SNAPSHOT_PAGE_BYTES || bytes > SNAPSHOT_TOTAL_BYTES || header.expiresAt <= this.estimatedHostTime) {
        throw new Error('Snapshot expired or exceeded its read limit.');
      }
      items.push(...page.items);
      if (page.nextPageId) page = await this.capturePage(scope, page.nextPageId);
    }
    if (revision !== this.viewRevision || !this.isConnected) throw new Error('Snapshot invalidated. Refresh this workspace.');
    // Snapshot high-water is a replay cursor. Subscribe from it and wait for the
    // server ACK; events published between capture and ACK are replayed, not guessed.
    this.selectedSnapshot = header;
    try {
      await this.events.subscribe(scope.workspaceId, scope.workspaceGeneration, header.eventStream);
      if (revision !== this.viewRevision || !this.isConnected) throw new Error('Snapshot invalidated during replay. Refresh this workspace.');
      // Only a confirmed scoped replay barrier resets a recovery burst. A socket
      // that authenticates but cannot deliver a view must not loop forever.
      this.retryCount = 0;
      this.recoveryError = null;
      this.confirmedAt = this.estimatedHostTime;
      return { header, items };
    } catch (error) {
      // An overlapping refresh owns its own header; an older barrier failure
      // must not erase the newer selection after its ACK has settled.
      if (revision === this.viewRevision && this.selectedSnapshot === header) this.selectedSnapshot = null;
      throw error;
    }
  }
  async readMonitor(workspace: WebWorkspace, input: MonitorReadInput): Promise<ScopedNetworkMonitor> {
    if (!this.supports('workspace.monitor')) throw new Error('workspace.monitor is not supported on this host.');
    const scope = this.checkedWorkspace(workspace);
    const header = this.selectedSnapshot;
    if (!header?.sessionId || header.selectionRevision === undefined) throw new Error('A current selected session snapshot is required for Monitor.');
    const revision = this.viewRevision;
    const response = await this.command({ ...this.readId(), method: 'workspace.monitor', workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, expectedSessionId: header.sessionId,
      selectionRevision: header.selectionRevision, input: methodCatalog['workspace.monitor'].inputSchema.parse(input) });
    resultOrError(response);
    assertScope(response, scope, this.epoch!);
    if (revision !== this.viewRevision || !response.ok || response.method !== 'workspace.monitor'
      || response.result.sessionId !== header.sessionId || response.result.selectionRevision !== header.selectionRevision) {
      throw new Error('Monitor session changed. Refresh the snapshot.');
    }
    return { scope, dashboard: response.result };
  }
  /** Read only host-reviewed projections. The selected snapshot supplies the session and revision;
   * callers cannot choose another session or pass a path. A late response never becomes current. */
  private async scopedRichRead<M extends 'goal.get' | 'task.list' | 'git.status' | 'git.history' | HostReadMethod>(
    workspace: WebWorkspace, method: M, input: InputOf<M> = {} as InputOf<M>): Promise<WireResultOf<M>> {
    const capability = methodCatalog[method].capability;
    if (!this.supports(capability)) throw new Error(`${method} is not supported on this host.`);
    const scope = this.checkedWorkspace(workspace);
    const header = this.selectedSnapshot;
    if (!header?.sessionId || header.selectionRevision === undefined) {
      throw new Error('A current selected session snapshot is required for this read.');
    }
    const revision = this.viewRevision;
    const epoch = this.epoch!;
    const response = await this.command({ ...this.readId(), method, workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, expectedSessionId: header.sessionId,
      selectionRevision: header.selectionRevision, input: methodCatalog[method].inputSchema.parse(input) } as RequestOf<M>);
    resultOrError(response);
    assertScope(response, scope, epoch);
    if (revision !== this.viewRevision || !this.isConnected || this.epoch !== epoch
      || this.selectedSnapshot !== header
      || !response.ok || response.method !== method) {
      throw new Error('Selected session changed. Refresh the workspace.');
    }
    if ('sessionId' in response.result && (response.result.sessionId !== header.sessionId
      || 'selectionRevision' in response.result && response.result.selectionRevision !== header.selectionRevision)) {
      throw new Error('Selected session changed. Refresh the workspace.');
    }
    return response.result as WireResultOf<M>;
  }
  readGoal(workspace: WebWorkspace): Promise<WebGoalRead> { return this.scopedRichRead(workspace, 'goal.get'); }
  readTasks(workspace: WebWorkspace): Promise<WebTaskRead> { return this.scopedRichRead(workspace, 'task.list'); }
  readGitStatus(workspace: WebWorkspace): Promise<WebGitStatus> { return this.scopedRichRead(workspace, 'git.status'); }
  readGitHistory(workspace: WebWorkspace): Promise<WebGitHistory> { return this.scopedRichRead(workspace, 'git.history'); }
  readSessions(workspace: WebWorkspace, query = '') { return this.scopedRichRead(workspace, 'session.list', { query }); }
  readModels(workspace: WebWorkspace) { return this.scopedRichRead(workspace, 'runtime.models', {}); }
  readQueue(workspace: WebWorkspace) { return this.scopedRichRead(workspace, 'runtime.queueRead', {}); }
  readTeams(workspace: WebWorkspace) { return this.scopedRichRead(workspace, 'team.read', {}); }
  readAgents(workspace: WebWorkspace) { return this.scopedRichRead(workspace, 'agent.read', {}); }
  readGitDiff(workspace: WebWorkspace, path: string) { return this.scopedRichRead(workspace, 'git.diff', { path }); }
  readGitCombinedDiff(workspace: WebWorkspace) { return this.scopedRichRead(workspace, 'git.combinedDiff', {}); }
  readGitCommitDetails(workspace: WebWorkspace, hash: string) { return this.scopedRichRead(workspace, 'git.commitDetails', { hash }); }
  readMonitorDetail(workspace: WebWorkspace, id: string) { return this.scopedRichRead(workspace, 'workspace.monitorDetail', { id }); }
  async uploadText(workspace: WebWorkspace, input: { name: string; text: string }): Promise<TextAttachmentReceipt> {
    const value = textUploadDisplaySchema.parse(input);
    const bytes = new TextEncoder().encode(value.text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return this.scopedRichRead(workspace, 'text.upload', { name: value.name, contentType: 'text/plain', encoding: 'base64', data: btoa(binary) });
  }
  async cancelTextAttachment(workspace: WebWorkspace, id: string): Promise<void> {
    await this.scopedRichRead(workspace, 'text.cancel', { attachmentId: textAttachmentIdSchema.parse(id) });
  }
  private mutationTime(): number {
    return Math.max(0, Math.floor(this.serverClockAtSync + (globalThis.performance?.now() ?? 0) - this.performanceAtSync));
  }
  private async scopedMutation<M extends OperationMethod | 'runtime.abort' | 'session.select'>(workspace: WebWorkspace, method: M,
    input: WebInput<M>): Promise<WireResultOf<M>> {
    const scope = this.checkedWorkspace(workspace);
    const header = this.selectedSnapshot;
    const generation = this.control;
    if (!this.supports(methodCatalog[method].capability) || !header?.sessionId || header.selectionRevision === undefined
      || generation === null) throw new Error('A current selected session and explicit workspace control are required.');
    if (this.pendingPromptReview(scope, header.sessionId).kind !== 'none') throw new Error('Review the previous command before starting another action.');
    const epoch = this.epoch!;
    const request = requestEnvelopeSchema.parse({ protocol: 1, ...createMutationIdentity(epoch, this.mutationTime()), method,
      workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration, expectedSessionId: header.sessionId,
      selectionRevision: header.selectionRevision, controlGeneration: generation, input });
    if (!('expectedSessionId' in request) || !('controlGeneration' in request)
      || (request.method !== 'runtime.abort' && request.method !== 'session.select' && !operationMethodSchema.safeParse(request.method).success)) {
      throw new Error('Invalid named mutation.');
    }
    this.rememberPendingPromptReview(scope, header.sessionId, request.requestId, method);
    let response: ProtocolResponse;
    try { response = await this.commands.commandWithStatus(request as MutationRequest); }
    catch (error) {
      this.viewRevision++; this.notify();
      throw error instanceof UnconfirmedCommand ? error : new UnconfirmedCommand(request.requestId);
    }
    if (!response.ok) {
      if (response.execution === 'unknown') throw new UnconfirmedCommand(request.requestId, response);
      this.clearConfirmedPending(request.requestId); resultOrError(response); throw new Error('The action was not admitted.');
    }
    try { assertScope(response, scope, epoch); } catch { throw new UnconfirmedCommand(request.requestId, response); }
    if (!this.isConnected || !sameWorkspace(this.selected, scope) || this.epoch !== epoch || response.method !== method
      || !('durability' in response.result) || response.result.durability !== 'journaled'
      || method !== 'session.create' && response.result.sessionId !== (method === 'session.select' ? (input as InputOf<'session.select'>).sessionId : header.sessionId)) {
      throw new UnconfirmedCommand(request.requestId, response);
    }
    this.clearConfirmedPending(request.requestId);
    this.viewRevision++; this.notify();
    return response.result as WireResultOf<M>;
  }
  createSession(workspace: WebWorkspace) { return this.scopedMutation(workspace, 'session.create', {}); }
  selectSession(workspace: WebWorkspace, sessionId: string) { return this.scopedMutation(workspace, 'session.select', { sessionId }); }
  setModel(workspace: WebWorkspace, provider: string, id: string) { return this.scopedMutation(workspace, 'runtime.setModel', { provider, id }); }
  setThinking(workspace: WebWorkspace, level: InputOf<'runtime.setThinking'>['level']) { return this.scopedMutation(workspace, 'runtime.setThinking', { level }); }
  mutateQueue(workspace: WebWorkspace, input: InputOf<'runtime.queue'>) { return this.scopedMutation(workspace, 'runtime.queue', input); }
  createGoal(workspace: WebWorkspace, input: WebInput<'goal.create'>) { return this.scopedMutation(workspace, 'goal.create', input); }
  controlGoal(workspace: WebWorkspace, input: InputOf<'goal.control'>) { return this.scopedMutation(workspace, 'goal.control', input); }
  updateGoal(workspace: WebWorkspace, input: InputOf<'goal.update'>) { return this.scopedMutation(workspace, 'goal.update', input); }
  clearGoal(workspace: WebWorkspace) { return this.scopedMutation(workspace, 'goal.clear', {}); }
  editGoalSteering(workspace: WebWorkspace, input: InputOf<'goal.editSteering'>) { return this.scopedMutation(workspace, 'goal.editSteering', input); }
  removeGoalSteering(workspace: WebWorkspace, input: InputOf<'goal.removeSteering'>) { return this.scopedMutation(workspace, 'goal.removeSteering', input); }
  createTask(workspace: WebWorkspace, input: WebInput<'task.create'>) { return this.scopedMutation(workspace, 'task.create', input); }
  updateTask(workspace: WebWorkspace, input: InputOf<'task.update'>) { return this.scopedMutation(workspace, 'task.update', input); }
  reorderTasks(workspace: WebWorkspace, input: InputOf<'task.reorder'>) { return this.scopedMutation(workspace, 'task.reorder', input); }
  deleteTask(workspace: WebWorkspace, input: InputOf<'task.delete'>) { return this.scopedMutation(workspace, 'task.delete', input); }
  clearTasks(workspace: WebWorkspace) { return this.scopedMutation(workspace, 'task.clear', {}); }
  controlAgent(workspace: WebWorkspace, input: InputOf<'agent.control'>) { return this.scopedMutation(workspace, 'agent.control', input); }
  controlTeam(workspace: WebWorkspace, input: InputOf<'team.control'>) { return this.scopedMutation(workspace, 'team.control', input); }
  agentWorkspace(workspace: WebWorkspace, input: InputOf<'agent.workspace'>) { return this.scopedMutation(workspace, 'agent.workspace', input); }
  abort(workspace: WebWorkspace) { return this.scopedMutation(workspace, 'runtime.abort', {}); }
  private async scopedFileRead<M extends 'file.list' | 'file.previewText'>(workspace: WebWorkspace, method: M,
    input: import('../shared/protocol/methods').InputOf<M>): Promise<WebFileList | WebFilePreview> {
    if (!this.supports('file.read')) throw new Error('Host file reads are unavailable.');
    const scope = this.checkedWorkspace(workspace);
    if (!this.selectedSnapshot) throw new Error('A current workspace snapshot is required for files.');
    const revision = this.viewRevision;
    const request = method === 'file.list'
      ? { ...this.readId(), method, workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
        input: methodCatalog['file.list'].inputSchema.parse(input) } as RequestOf<'file.list'>
      : { ...this.readId(), method, workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
        input: methodCatalog['file.previewText'].inputSchema.parse(input) } as RequestOf<'file.previewText'>;
    const response = await this.command(request);
    resultOrError(response);
    assertScope(response, scope, this.epoch!);
    if (revision !== this.viewRevision || !this.isConnected || !response.ok || response.method !== method) {
      throw new Error('File scope changed. Refresh the workspace.');
    }
    if (response.method !== 'file.list' && response.method !== 'file.previewText') throw new Error('Unexpected file response.');
    return response.result;
  }
  async listFiles(workspace: WebWorkspace, directoryId: string | null): Promise<WebFileList> {
    const result = await this.scopedFileRead(workspace, 'file.list', { directoryId, limit: 200 });
    if (!('entries' in result) || result.directoryId !== directoryId) throw new Error('Unexpected directory response.');
    return result;
  }
  async previewText(workspace: WebWorkspace, fileId: string): Promise<WebFilePreview> {
    const result = await this.scopedFileRead(workspace, 'file.previewText', { fileId, maxBytes: 32_768 });
    if (!('content' in result) || result.fileId !== fileId) throw new Error('Unexpected file preview response.');
    return result;
  }
  /** An observer must claim an expiring host lease explicitly. A failed call never grants local control. */
  async claimControl(workspace: WebWorkspace): Promise<WireResultOf<'control.claim'>> {
    if (!this.supports('workspace.control')) throw new Error('Workspace control is unavailable.');
    const scope = this.checkedWorkspace(workspace);
    if (!this.selectedSnapshot) throw new Error('Refresh the selected workspace before claiming control.');
    const epoch = this.epoch!;
    const response = await this.command({ ...this.readId(), method: 'control.claim', workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, input: {} });
    resultOrError(response);
    assertScope(response, scope, this.epoch!);
    if (!response.ok || response.method !== 'control.claim') throw new Error('Invalid control response.');
    this.assertControlScope(scope, epoch, response.result.generation);
    this.controlGeneration = response.result.generation;
    this.controlExpiresAt = response.result.expiresAt;
    this.notify();
    return response.result;
  }
  async renewControl(workspace: WebWorkspace): Promise<WireResultOf<'control.renew'>> {
    const scope = this.checkedWorkspace(workspace);
    const generation = this.control;
    if (!this.supports('workspace.control') || generation === null) throw new Error('A live workspace lease is required for renewal.');
    const epoch = this.epoch!;
    const response = await this.command({ ...this.readId(), method: 'control.renew', workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, input: { generation } });
    resultOrError(response); assertScope(response, scope, this.epoch!);
    if (!response.ok || response.method !== 'control.renew' || response.result.generation !== generation) throw new Error('Control scope changed. Refresh before claiming again.');
    this.assertControlScope(scope, epoch, response.result.generation);
    this.controlGeneration = response.result.generation; this.controlExpiresAt = response.result.expiresAt; this.notify();
    return response.result;
  }
  async takeOverControl(workspace: WebWorkspace): Promise<WireResultOf<'control.takeover'>> {
    const scope = this.checkedWorkspace(workspace);
    if (!this.supports('workspace.control') || !this.selectedSnapshot || !this.takeoverAllowed) throw new Error('Takeover is not available under this host policy.');
    const epoch = this.epoch!;
    const response = await this.command({ ...this.readId(), method: 'control.takeover', workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, input: {} });
    resultOrError(response); assertScope(response, scope, this.epoch!);
    if (!response.ok || response.method !== 'control.takeover') throw new Error('Control scope changed. Refresh before claiming again.');
    this.assertControlScope(scope, epoch, response.result.generation);
    this.controlGeneration = response.result.generation; this.controlExpiresAt = response.result.expiresAt; this.notify();
    return response.result;
  }
  async requestPermissionApproval(workspace: WebWorkspace, input: InputOf<'permission.issue'>): Promise<WireResultOf<'permission.issue'>> {
    const scope = this.checkedWorkspace(workspace);
    const header = this.selectedSnapshot;
    const generation = this.control;
    const value = methodCatalog['permission.issue'].inputSchema.parse(input);
    if (!this.supports('permission.approve') || !header?.sessionId || header.selectionRevision === undefined || generation === null
      || value.sessionId !== header.sessionId) throw new Error('A current selected session and explicit control are required for this permission challenge.');
    if (this.pendingCommandReview(scope).kind !== 'none') throw new Error('Review the previous command before requesting a permission change.');
    const revision = this.viewRevision;
    const response = await this.command({ ...this.readId(), method: 'permission.issue', workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, selectionRevision: header.selectionRevision, controlGeneration: generation, input: value });
    resultOrError(response); assertScope(response, scope, this.epoch!);
    if (!response.ok || response.method !== 'permission.issue' || revision !== this.viewRevision || response.result.sessionId !== header.sessionId) {
      throw new Error('Permission challenge scope changed. No confirmation was sent.');
    }
    return response.result;
  }
  async respondPermissionApproval(workspace: WebWorkspace, input: InputOf<'permission.confirm'>): Promise<WireResultOf<'permission.confirm'>> {
    const scope = this.checkedWorkspace(workspace);
    const header = this.selectedSnapshot;
    const generation = this.control;
    const value = methodCatalog['permission.confirm'].inputSchema.parse(input);
    if (!this.supports('permission.approve') || !header?.sessionId || header.selectionRevision === undefined || generation === null
      || value.sessionId !== header.sessionId) throw new Error('A current selected session and explicit control are required for this permission confirmation.');
    if (this.pendingCommandReview(scope).kind !== 'none') throw new Error('Review the previous command before confirming another permission change.');
    const epoch = this.epoch!;
    const request: RequestOf<'permission.confirm'> = { protocol: 1, ...createMutationIdentity(epoch, this.estimatedHostTime),
      method: 'permission.confirm', workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
      selectionRevision: header.selectionRevision, controlGeneration: generation, input: value };
    this.rememberPendingPromptReview(scope, header.sessionId, request.requestId, 'permission.confirm');
    let response: ProtocolResponse;
    try { response = await this.command(request); }
    catch { this.viewRevision++; this.notify(); throw new UnconfirmedCommand(request.requestId); }
    if (!response.ok) {
      if (response.execution === 'unknown') throw new UnconfirmedCommand(request.requestId, response);
      this.clearConfirmedPending(request.requestId); resultOrError(response); throw new Error('Permission confirmation was not admitted.');
    }
    try { assertScope(response, scope, epoch); } catch { throw new UnconfirmedCommand(request.requestId, response); }
    if (!this.isConnected || !sameWorkspace(this.selected, scope) || this.epoch !== epoch || response.method !== 'permission.confirm' || response.result.sessionId !== header.sessionId
      || response.result.level !== value.newLevel) throw new UnconfirmedCommand(request.requestId, response);
    this.clearConfirmedPending(request.requestId); this.viewRevision++; this.notify();
    return response.result;
  }
  async releaseControl(workspace: WebWorkspace): Promise<void> {
    const scope = this.checkedWorkspace(workspace);
    const generation = this.controlGeneration;
    this.controlGeneration = null;
    this.controlExpiresAt = null;
    this.notify();
    if (generation === null || !this.isConnected) return;
    const response = await this.command({ ...this.readId(), method: 'control.release', workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, input: { generation } });
    resultOrError(response);
    assertScope(response, scope, this.epoch!);
    if (!response.ok || response.method !== 'control.release') throw new Error('Unexpected release response.');
  }
  /** Never replay a prompt with a fresh ID. The receipt confirms admission, not completion. */
  async sendPrompt(workspace: WebWorkspace, text: string, options: { attachments?: string[]; projectFiles?: string[] } = {}): Promise<WireResultOf<'runtime.prompt'>> {
    const scope = this.checkedWorkspace(workspace);
    const header = this.selectedSnapshot;
    const generation = this.control;
    if (!this.supports('runtime.prompt') || !header?.sessionId || header.selectionRevision === undefined || generation === null) {
      throw new Error('A current selected session and explicit workspace control are required before sending.');
    }
    if (((options.attachments?.length ?? 0) + (options.projectFiles?.length ?? 0)) > 0 && !this.supports('text.context')) {
      throw new Error('Text context is unavailable on this host. Nothing was uploaded or sent.');
    }
    const epoch = this.epoch!;
    const request: MutationRequest = { protocol: 1, ...createMutationIdentity(epoch, this.mutationTime()), method: 'runtime.prompt',
      workspaceId: scope.workspaceId, workspaceGeneration: scope.workspaceGeneration,
      expectedSessionId: header.sessionId, selectionRevision: header.selectionRevision, controlGeneration: generation,
      input: methodCatalog['runtime.prompt'].inputSchema.parse({ text, ...options }) };
    // Save the original ID before the first network byte. A reload while the POST
    // is in flight must still recover its status instead of creating a second ID.
    if (this.pendingPromptReview(scope, header.sessionId).kind !== 'none') {
      throw new Error('Review the previous prompt request before sending another.');
    }
    this.rememberPendingPromptReview(scope, header.sessionId, request.requestId);
    let response: ProtocolResponse;
    try { response = await this.commands.commandWithStatus(request); }
    catch (error) {
      this.viewRevision++; this.notify();
      throw error instanceof UnconfirmedCommand ? error : new UnconfirmedCommand(request.requestId);
    }
    if (!response.ok) {
      if (response.execution === 'unknown') throw new UnconfirmedCommand(request.requestId, response);
      // A correlated, explicit not-started response cannot have admitted the effect.
      this.clearConfirmedPending(request.requestId);
      resultOrError(response);
      throw new Error('The prompt was not admitted.');
    }
    try { assertScope(response, scope, epoch); }
    catch { throw new UnconfirmedCommand(request.requestId, response); }
    if (!this.isConnected || !sameWorkspace(this.selected, scope) || this.epoch !== epoch || !response.ok || response.method !== 'runtime.prompt'
      || response.result.sessionId !== header.sessionId || response.result.durability !== 'journaled') {
      throw new UnconfirmedCommand(request.requestId, response);
    }
    this.acknowledgeableRequestId = request.requestId;
    this.viewRevision++;
    this.notify();
    return response.result;
  }
  reviewCommandStatus(workspace: WebWorkspace, requestId: string): Promise<CommandStatus> {
    return this.reviewPromptStatus(workspace, requestId);
  }
  /** Reconcile only the original request ID; a status read is not a retry or a session-selection action. */
  async reviewPromptStatus(workspace: WebWorkspace, requestId: string): Promise<CommandStatus> {
    const scope = this.checkedWorkspace(workspace);
    if (!this.supports('workspace.list')) throw new Error('Refresh the selected workspace before reviewing the command.');
    const epoch = this.epoch!;
    const response = await this.command({ ...this.readId(), method: 'command.status', workspaceId: scope.workspaceId,
      workspaceGeneration: scope.workspaceGeneration, input: { requestId: mutationRequestIdSchema.parse(requestId) } });
    resultOrError(response);
    assertScope(response, scope, epoch);
    if (!this.isConnected || this.epoch !== epoch || !sameWorkspace(this.selected, scope) || !response.ok || response.method !== 'command.status') {
      throw new Error('Command review scope changed. Refresh and review the original request again.');
    }
    if (response.result.receipt && response.result.receipt.requestId !== requestId) {
      throw new Error('The command status belongs to a different request. Do not resend.');
    }
    if (response.result.state === 'settled' && response.result.receipt?.requestId !== requestId) throw new Error('Original command receipt identity does not match this review.');
    const saved = this.pendingCommandReview(scope);
    const value = saved.kind === 'match' || saved.kind === 'blocked' ? saved.value : undefined;
    if (value?.requestId === requestId && response.result.state === 'settled' && response.result.receipt !== null) {
      const receipt = response.result.receipt;
      if (!receiptMatchesPending(receipt, value.method)) throw new Error('Original command receipt method does not match this review.');
      // Creation/selection may truthfully name a new session. Every other receipt must retain
      // the saved original target, even when status is read through a newer current selection.
      if (value.method !== 'session.create' && value.method !== 'session.select' && receipt.sessionId !== value.sessionId
        || receipt.kind === 'permission' && (receipt.workspaceId !== value.workspaceId
          || receipt.workspaceGeneration !== value.workspaceGeneration)) {
        throw new Error('Original command receipt scope does not match this review.');
      }
    }
    if (value?.requestId === requestId && (response.result.state === 'rejected' || response.result.state === 'settled')) this.acknowledgeableRequestId = requestId;
    return response.result;
  }
  async logout(): Promise<void> {
    if (!this.csrf) return;
    try {
      const response = await this.send(`${this.origin}/api/auth/logout`, browserRequest('POST', '{}', this.csrf));
      if (!response.ok && response.status !== 401) throw new Error('The server could not revoke this session.');
      // Retain unknown metadata under the OLD auth-session key. A new login never inherits/replays it.
    } finally { this.close(); }
  }
  close(): void {
    this.lifecycle++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connected = false;
    this.epoch = null;
    this.serverClockAtSync = 0;
    this.performanceAtSync = globalThis.performance?.now() ?? 0;
    this.csrf = '';
    this.capabilities.clear();
    this.selected = null;
    this.selectedSnapshot = null;
    this.controlGeneration = null;
    this.controlExpiresAt = null;
    this.latestControlGeneration = null;
    this.viewRevision++;
    this.events.close();
    this.invalidationListeners.clear();
  }
}
