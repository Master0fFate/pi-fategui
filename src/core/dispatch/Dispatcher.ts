import { z } from 'zod';
import { decodeRequestJson, failureEnvelopeSchema, responseEnvelopeSchema, utf8Bytes, type FailureResponse, type MutationRequest, type JournaledMutationRequest, type ProtocolResponse, type WireRequest } from '../../shared/protocol/envelopes';
import { ProtocolFault, safeError, type ErrorCode } from '../../shared/protocol/errors';
import { MAX_RESULT_BYTES, methodCatalog, revisionSchema, type Capability, type DomainResultOf, type InputOf, type MethodName } from '../../shared/protocol/methods';
import { MAX_CLOCK_SKEW_MS, MAX_REQUEST_AGE_MS, millisecondsSchema, uuidSchema, validateRequestClock } from '../../shared/protocol/requestIds';
import { isAdapterCreatedContext, type RequestContext } from './RequestContext';
import { CommandJournal, JournalRejected } from '../commands/CommandJournal';
import { mutationReceiptSchema, permissionReceiptSchema, type MutationReceipt } from '../../shared/protocol/commandOutcomes';
import { WorkspaceControl, type ControlTransition } from '../security/WorkspaceControl';
import { ApprovalChallenges } from '../security/ApprovalChallenges';
import { operationMethodSchema, type HostMethodName } from '../../shared/protocol/hostOperations';

/** Actual production activation is owned by NetworkDispatcher, never a request flag. */
export const productionNetworkDispatchEnabled = true;

export interface WorkspaceBinding {
  readonly workspaceId: string;
  readonly generation: number;
  readonly selectedSessionId: string | null;
  readonly selectionRevision: number;
  /** Host-owned, captured binding; never a path or a lookup of global desktop focus. */
  readonly handle: object;
}
export interface SessionBinding {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspaceGeneration: number;
  readonly handle: object;
}
export interface ResourceBinding {
  readonly resourceId: string | null;
  readonly kind: 'file' | 'directory';
  readonly workspaceId: string;
  readonly workspaceGeneration: number;
  /** The real host must canonicalize/constrain resources, including symlinks, before issuing this binding. */
  readonly handle: object;
}
interface HostExecutionContext {
  readonly kind: 'host';
  readonly identity: RequestContext;
  readonly requestId: string;
  readonly serverEpoch: string;
  readonly serverTime: number;
}
interface ResourceExecutionContext extends Omit<HostExecutionContext, 'kind'> {
  readonly kind: 'resource';
  readonly workspace: WorkspaceBinding;
  readonly resource: ResourceBinding;
}
interface ControlExecutionContext extends Omit<HostExecutionContext, 'kind'> {
  readonly kind: 'workspace-control';
  readonly workspace: WorkspaceBinding;
}
interface WorkspaceReadExecutionContext extends Omit<HostExecutionContext, 'kind'> {
  readonly kind: 'workspace-read';
  readonly workspace: WorkspaceBinding;
  readonly session: SessionBinding;
}
interface ApprovalExecutionContext extends Omit<HostExecutionContext, 'kind'> {
  readonly kind: 'session-approval';
  readonly workspace: WorkspaceBinding;
  readonly session: SessionBinding;
  readonly controlGeneration: number;
  readonly selectionRevision: number;
}
interface SessionExecutionContext extends Omit<HostExecutionContext, 'kind'> {
  readonly kind: 'session-control';
  readonly workspace: WorkspaceBinding;
  readonly session: SessionBinding;
  readonly controlGeneration: number;
}
type ExecutionContext = HostExecutionContext | ResourceExecutionContext | WorkspaceReadExecutionContext | ControlExecutionContext | ApprovalExecutionContext | SessionExecutionContext;
export type HandlerContextOf<M extends MethodName> = (typeof methodCatalog)[M]['scope'] extends 'host' ? HostExecutionContext
  : (typeof methodCatalog)[M]['scope'] extends 'resource' ? ResourceExecutionContext
    : (typeof methodCatalog)[M]['scope'] extends 'workspace-read' ? WorkspaceReadExecutionContext
      : (typeof methodCatalog)[M]['scope'] extends 'workspace-control' ? ControlExecutionContext
        : (typeof methodCatalog)[M]['scope'] extends 'session-approval' ? ApprovalExecutionContext : SessionExecutionContext;
/** Control is implemented by the server-owned lease, not a caller-supplied handler. */
type BuiltInMethod = 'command.status' | 'control.claim' | 'control.renew' | 'control.release' | 'control.takeover'
  | 'permission.issue' | 'permission.confirm';
type NetworkReadMethod = 'workspace.snapshot' | 'workspace.snapshotPage' | 'workspace.monitor'
  | 'goal.get' | 'task.list' | 'git.status' | 'git.history' | HostMethodName;
/** Desktop dispatchers have no network snapshot/monitor handler; those three
 * explicit, typed handlers fail closed when absent. All original handlers stay required. */
export type HandlerMap = { readonly [M in Exclude<MethodName, BuiltInMethod | NetworkReadMethod>]:
  (input: Readonly<InputOf<M>>, context: HandlerContextOf<M>) => DomainResultOf<M> | Promise<DomainResultOf<M>> }
  & { readonly [M in NetworkReadMethod]?:
    (input: Readonly<InputOf<M>>, context: HandlerContextOf<M>) => DomainResultOf<M> | Promise<DomainResultOf<M>> };

/** Synchronous authoritative checks prevent an await between the final check and handler entry.
 * Real host handlers must use the captured binding and preserve their own admission invariants after awaits.
 * An async permission/control/workspace resolver is deliberately not accepted by this interface.
 */
export interface DispatchResolvers {
  authenticate(context: RequestContext, now: number): boolean;
  isMember(context: RequestContext, workspaceId: string): boolean;
  workspace(context: RequestContext, workspaceId: string): WorkspaceBinding | null;
  hasCapability(context: RequestContext, capability: Capability, workspace: WorkspaceBinding | null): boolean;
  hasControl(context: RequestContext, workspace: WorkspaceBinding, generation: number, now: number): boolean;
  /** Must include current trust, permission-store health and host/session ceilings; control is not a grant. */
  hasPermission(context: RequestContext, workspace: WorkspaceBinding, operation: 'read' | 'prompt' | 'abort' | 'select'): boolean;
  session(context: RequestContext, workspace: WorkspaceBinding, sessionId: string): SessionBinding | null;
  resource(context: RequestContext, workspace: WorkspaceBinding, resourceId: string | null, kind: ResourceBinding['kind']): ResourceBinding | null;
}
const denyingResolvers: DispatchResolvers = Object.freeze({
  authenticate: () => false, isMember: () => false, workspace: () => null,
  hasCapability: () => false, hasControl: () => false, hasPermission: () => false,
  session: () => null, resource: () => null,
});

/** Scheduling/admission seam for isolated preparation ONLY. This is NOT a durable journal,
 * duplicate suppression, a replay policy, a lock implementation, or an exactly-once guarantee.
 * A future journal must separately bind the full original identity/payload and settle outcomes.
 */
export interface AdmissionFence {
  enter(request: Readonly<MutationRequest>, context: RequestContext): Promise<{ release(): void } | null>;
}
export interface DispatcherOptions {
  readonly serverEpoch: string;
  readonly handlers: HandlerMap;
  readonly resolvers?: Partial<DispatchResolvers>;
  readonly admissionFence?: AdmissionFence;
  readonly commandJournal?: CommandJournal;
  /** Server-owned volatile control; absent by default. No JSON flag can create it. */
  readonly workspaceControl?: WorkspaceControl;
  /** Host-owned one-use approvals. Confirmation requires the atomic runtime grant path. */
  readonly approvalChallenges?: ApprovalChallenges;
  /** Trusted transport cleanup hook, invoked only on a successful lease transition. */
  readonly onControlTransition?: (identity: RequestContext, transition: ControlTransition) => void;
  /** Trusted transport composition only. Defaults fail closed; never read from request JSON. */
  readonly networkReadsEnabled?: boolean;
  readonly networkMutationsEnabled?: boolean;
  readonly now?: () => number;
}

function assertByteBound(value: unknown, limit: number): void {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { throw new ProtocolFault('INTERNAL_ERROR'); }
  if (text === undefined) throw new ProtocolFault('INTERNAL_ERROR');
  if (text.length > limit || utf8Bytes(text) > limit) throw new ProtocolFault('RESULT_TOO_LARGE');
}
function domainResult<T>(schema: z.ZodType<T>, value: unknown, limit: number): T {
  assertByteBound(value, limit);
  const result = schema.safeParse(value);
  if (!result.success) throw new ProtocolFault('INTERNAL_ERROR');
  return result.data;
}
function isHandle(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
function mutationRequest(request: WireRequest): request is MutationRequest {
  const category = methodCatalog[request.method].mutation;
  return category === 'runtime' || category === 'selection';
}
function journaledRequest(request: WireRequest): request is JournaledMutationRequest {
  return mutationRequest(request) || request.method === 'permission.confirm';
}
function approvalRequest(request: WireRequest): request is Extract<WireRequest, { method: 'permission.issue' | 'permission.confirm' }> {
  return request.method === 'permission.issue' || request.method === 'permission.confirm';
}
function unreachable(value: never): never {
  void value;
  throw new ProtocolFault('INVALID_REQUEST');
}

/** Transport-independent command gate. The production host supplies ticket-backed
 * control, atomic grant confirmation, and a durable runtime command journal. */
export class Dispatcher {
  private readonly serverEpoch: string;
  private readonly handlers: HandlerMap;
  private readonly resolvers: DispatchResolvers;
  private readonly admissionFence: AdmissionFence | undefined;
  private readonly commandJournal: CommandJournal | undefined;
  private readonly workspaceControl: WorkspaceControl | undefined;
  private readonly approvalChallenges: ApprovalChallenges | undefined;
  private readonly onControlTransition: DispatcherOptions['onControlTransition'];
  private readonly networkReadsEnabled: boolean;
  private readonly networkMutationsEnabled: boolean;
  private readonly now: () => number;

  constructor(options: DispatcherOptions) {
    this.serverEpoch = uuidSchema.parse(options.serverEpoch);
    this.handlers = Object.freeze({ ...options.handlers });
    this.resolvers = Object.freeze({ ...denyingResolvers, ...options.resolvers });
    this.admissionFence = options.admissionFence;
    this.commandJournal = options.commandJournal;
    this.workspaceControl = options.workspaceControl;
    this.approvalChallenges = options.approvalChallenges;
    this.onControlTransition = options.onControlTransition;
    this.networkReadsEnabled = options.networkReadsEnabled === true;
    this.networkMutationsEnabled = this.networkReadsEnabled && options.networkMutationsEnabled === true
      && this.commandJournal !== undefined && this.workspaceControl !== undefined
      && this.approvalChallenges?.supportsAtomicGrant === true;
    this.now = options.now ?? Date.now;
  }

  private authorizeNow(request: WireRequest, identity: RequestContext): ExecutionContext {
    const now = millisecondsSchema.parse(this.now());
    if (!isAdapterCreatedContext(identity) || identity.expiresAt <= now || this.resolvers.authenticate(identity, now) !== true) {
      throw new ProtocolFault('UNAUTHENTICATED');
    }
    if (identity.adapter === 'authenticated-server' && (!this.networkReadsEnabled
      || (mutationRequest(request) || approvalRequest(request)) && !this.networkMutationsEnabled)) throw new ProtocolFault('DISPATCH_DISABLED');
    const clock = validateRequestClock(request, this.serverEpoch, now);
    if (clock) throw new ProtocolFault(clock);
    if (mutationRequest(request) && (request.issuedAt < now - MAX_REQUEST_AGE_MS
      || request.issuedAt > now + MAX_CLOCK_SKEW_MS)) throw new ProtocolFault('CLOCK_SKEW');
    if (request.method === 'permission.confirm' && (request.issuedAt < now - MAX_REQUEST_AGE_MS
      || request.issuedAt > now + MAX_CLOCK_SKEW_MS)) throw new ProtocolFault('CLOCK_SKEW');
    if (request.method === 'command.status') throw new ProtocolFault('INVALID_REQUEST');
    const descriptor = methodCatalog[request.method];
    const base = { identity, requestId: request.requestId, serverEpoch: this.serverEpoch, serverTime: now };
    if (!('workspaceId' in request)) {
      if (this.resolvers.hasCapability(identity, descriptor.capability, null) !== true) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
      return Object.freeze({ ...base, kind: 'host' });
    }
    // Check membership before resolving existence; unauthorized IDs cannot enumerate workspaces.
    if (this.resolvers.isMember(identity, request.workspaceId) !== true) throw new ProtocolFault('FORBIDDEN');
    const value = this.resolvers.workspace(identity, request.workspaceId);
    if (!value) throw new ProtocolFault('UNKNOWN_WORKSPACE');
    if (value.workspaceId !== request.workspaceId || !revisionSchema.safeParse(value.generation).success
      || !revisionSchema.safeParse(value.selectionRevision).success || !uuidSchema.nullable().safeParse(value.selectedSessionId).success
      || !isHandle(value.handle)) throw new ProtocolFault('INTERNAL_ERROR');
    const workspace: WorkspaceBinding = Object.freeze({ workspaceId: value.workspaceId, generation: value.generation,
      selectedSessionId: value.selectedSessionId, selectionRevision: value.selectionRevision, handle: value.handle });
    if (this.resolvers.hasCapability(identity, descriptor.capability, workspace) !== true) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
    if ((mutationRequest(request) || approvalRequest(request))
      && this.resolvers.hasControl(identity, workspace, request.controlGeneration, now) !== true) {
      throw new ProtocolFault('CONTROL_REQUIRED');
    }
    if (descriptor.permission !== 'none' && this.resolvers.hasPermission(identity, workspace, descriptor.permission) !== true) throw new ProtocolFault('PERMISSION_REQUIRED');
    if (workspace.generation !== request.workspaceGeneration) throw new ProtocolFault('STALE_WORKSPACE');
    if (descriptor.scope === 'workspace-read' && 'expectedSessionId' in request
      && (request.expectedSessionId !== workspace.selectedSessionId || request.selectionRevision !== workspace.selectionRevision)) {
      // This is a read precondition, not authority to select a session. It stops an old
      // snapshot from silently reading rows for a newer host selection.
      throw new ProtocolFault('STALE_SESSION');
    }
    if (descriptor.scope === 'workspace-read') {
      const selected = workspace.selectedSessionId;
      if (!selected) throw new ProtocolFault('SNAPSHOT_NOT_READY');
      const session = this.resolvers.session(identity, workspace, selected);
      if (!session || session.sessionId !== selected || session.workspaceId !== workspace.workspaceId
        || session.workspaceGeneration !== workspace.generation || !isHandle(session.handle)) throw new ProtocolFault('STALE_SESSION');
      return Object.freeze({ ...base, kind: 'workspace-read', workspace,
        session: Object.freeze({ sessionId: session.sessionId, workspaceId: session.workspaceId,
          workspaceGeneration: session.workspaceGeneration, handle: session.handle }) });
    }
    if (request.method === 'control.claim' || request.method === 'control.renew'
      || request.method === 'control.release' || request.method === 'control.takeover') {
      if (identity.adapter !== 'authenticated-server' || !this.workspaceControl) throw new ProtocolFault('DISPATCH_DISABLED');
      return Object.freeze({ ...base, kind: 'workspace-control', workspace });
    }
    if (approvalRequest(request)) {
      if (identity.adapter !== 'authenticated-server' || !this.approvalChallenges?.supportsAtomicGrant) throw new ProtocolFault('DISPATCH_DISABLED');
      if (workspace.selectedSessionId !== request.input.sessionId || workspace.selectionRevision !== request.selectionRevision) throw new ProtocolFault('STALE_SESSION');
      const session = this.resolvers.session(identity, workspace, request.input.sessionId);
      if (!session || session.sessionId !== request.input.sessionId || session.workspaceId !== workspace.workspaceId
        || session.workspaceGeneration !== workspace.generation || !isHandle(session.handle)) throw new ProtocolFault('STALE_SESSION');
      return Object.freeze({ ...base, kind: 'session-approval', workspace, controlGeneration: request.controlGeneration,
        selectionRevision: request.selectionRevision,
        session: Object.freeze({ sessionId: session.sessionId, workspaceId: session.workspaceId,
          workspaceGeneration: session.workspaceGeneration, handle: session.handle }) });
    }
    if (mutationRequest(request)) {
      if (workspace.selectedSessionId !== request.expectedSessionId || workspace.selectionRevision !== request.selectionRevision) throw new ProtocolFault('STALE_SESSION');
      const targetId = request.method === 'session.select' ? request.input.sessionId : request.expectedSessionId;
      const session = this.resolvers.session(identity, workspace, targetId);
      if (!session || session.sessionId !== targetId || session.workspaceId !== workspace.workspaceId
        || session.workspaceGeneration !== workspace.generation || !isHandle(session.handle)) throw new ProtocolFault('STALE_SESSION');
      return Object.freeze({ ...base, kind: 'session-control', workspace, controlGeneration: request.controlGeneration,
        session: Object.freeze({ sessionId: session.sessionId, workspaceId: session.workspaceId, workspaceGeneration: session.workspaceGeneration, handle: session.handle }) });
    }
    if (request.method !== 'file.list' && request.method !== 'file.previewText') throw new ProtocolFault('INVALID_REQUEST');
    const resourceId = request.method === 'file.list' ? request.input.directoryId : request.input.fileId;
    const kind = request.method === 'file.list' ? 'directory' : 'file';
    const resource = this.resolvers.resource(identity, workspace, resourceId, kind);
    if (!resource || resource.resourceId !== resourceId || resource.kind !== kind || resource.workspaceId !== workspace.workspaceId
      || resource.workspaceGeneration !== workspace.generation || !isHandle(resource.handle)) throw new ProtocolFault('FORBIDDEN');
    return Object.freeze({ ...base, kind: 'resource', workspace,
      resource: Object.freeze({ resourceId: resource.resourceId, kind: resource.kind, workspaceId: resource.workspaceId, workspaceGeneration: resource.workspaceGeneration, handle: resource.handle }) });
  }

  private authorizeJournalScope(request: JournaledMutationRequest | Extract<WireRequest, { method: 'command.status' }>, identity: RequestContext): void {
    const now = millisecondsSchema.parse(this.now());
    if (!isAdapterCreatedContext(identity) || identity.expiresAt <= now || this.resolvers.authenticate(identity, now) !== true) throw new ProtocolFault('UNAUTHENTICATED');
    if (identity.adapter === 'authenticated-server' && (!this.networkReadsEnabled
      || request.method !== 'command.status' && !this.networkMutationsEnabled)) throw new ProtocolFault('DISPATCH_DISABLED');
    // Status has a fresh read envelope; only the ID it queries may have an old epoch.
    const clock = validateRequestClock(request, this.serverEpoch, now);
    if (clock) throw new ProtocolFault(clock);
    if (mutationRequest(request) && (request.issuedAt < now - MAX_REQUEST_AGE_MS
      || request.issuedAt > now + MAX_CLOCK_SKEW_MS)) throw new ProtocolFault('CLOCK_SKEW');
    if (this.resolvers.isMember(identity, request.workspaceId) !== true) throw new ProtocolFault('FORBIDDEN');
    const workspace = this.resolvers.workspace(identity, request.workspaceId);
    if (!workspace || workspace.workspaceId !== request.workspaceId || !isHandle(workspace.handle)) throw new ProtocolFault('UNKNOWN_WORKSPACE');
    if (workspace.generation !== request.workspaceGeneration) throw new ProtocolFault('STALE_WORKSPACE');
    if (request.method === 'command.status' && (this.resolvers.hasCapability(identity, 'workspace.list', workspace) !== true
      || this.resolvers.hasPermission(identity, workspace, 'read') !== true)) throw new ProtocolFault('FORBIDDEN');
  }

  async dispatchJson(body: string, identity: RequestContext): Promise<ProtocolResponse> {
    const decoded = decodeRequestJson(body);
    let scope: FailureResponse['scope'] = null;
    let started = false;
    let grantAdmitted = false;
    // A joined or previously settled duplicate may have run even when this call did not enter its handler.
    let recordedOutcome = false;
    const requestId = decoded.ok ? decoded.request.requestId : decoded.requestId;
    const failure = (code: ErrorCode): FailureResponse => {
      const unknown = started || grantAdmitted || recordedOutcome
        || code === 'OUTCOME_UNKNOWN' && decoded.ok && journaledRequest(decoded.request);
      return failureEnvelopeSchema.parse({ protocol: 1, ok: false, requestId, serverEpoch: this.serverEpoch,
        scope, error: safeError(code), execution: unknown ? 'unknown' : 'not-started', operationId: unknown ? requestId : null });
    };
    if (!decoded.ok) return failure(decoded.code);
    const request = decoded.request;
    const descriptor = methodCatalog[request.method];
    if (request.method === 'command.status') {
      try {
        this.authorizeJournalScope(request, identity);
        if (!this.commandJournal) throw new ProtocolFault('STORAGE_UNAVAILABLE');
        const result = await this.commandJournal.status(request.input.requestId, request.workspaceId, identity.principalId);
        this.authorizeJournalScope(request, identity);
        scope = { workspaceId: request.workspaceId, workspaceGeneration: request.workspaceGeneration };
        return responseEnvelopeSchema.parse({ protocol: 1, ok: true, requestId, serverEpoch: this.serverEpoch, scope, method: 'command.status', result });
      } catch (error) { return failure(error instanceof ProtocolFault ? error.code : 'STORAGE_UNAVAILABLE'); }
    }
    const execute = async (prepared?: ExecutionContext): Promise<ProtocolResponse> => {
      // No await from the final check until entry to the specifically named handler below.
      const context = prepared ?? this.authorizeNow(request, identity);
      scope = context.kind === 'host' ? null : { workspaceId: context.workspace.workspaceId, workspaceGeneration: context.workspace.generation };
      const finish = (result: unknown): ProtocolResponse => {
        assertByteBound(result, descriptor.maxWireBytes);
        const parsed = responseEnvelopeSchema.safeParse({ protocol: 1, ok: true, requestId, serverEpoch: this.serverEpoch, scope, method: request.method, result });
        if (!parsed.success) throw new ProtocolFault('INTERNAL_ERROR');
        assertByteBound(parsed.data, MAX_RESULT_BYTES);
        if (!mutationRequest(request) && request.method !== 'permission.confirm') {
          const live = this.authorizeNow(request, identity);
          if (live.kind !== context.kind) throw new ProtocolFault('FORBIDDEN');
          // Equal IDs/generations do not prove that the read still belongs to the captured host handles.
          if (context.kind === 'resource' && live.kind === 'resource') {
            if (live.workspace.handle !== context.workspace.handle) throw new ProtocolFault('STALE_WORKSPACE');
            if (live.resource.handle !== context.resource.handle) throw new ProtocolFault('FORBIDDEN');
          }
          if (context.kind === 'workspace-control' && live.kind === 'workspace-control'
            && live.workspace.handle !== context.workspace.handle) throw new ProtocolFault('STALE_WORKSPACE');
          if (context.kind === 'workspace-read' && live.kind === 'workspace-read') {
            if (live.workspace.handle !== context.workspace.handle) throw new ProtocolFault('STALE_WORKSPACE');
            if (live.workspace.selectionRevision !== context.workspace.selectionRevision
              || live.session.sessionId !== context.session.sessionId
              || live.session.handle !== context.session.handle) throw new ProtocolFault('STALE_SESSION');
          }
        }
        return parsed.data;
      };
      const operation = async (method: import('../../shared/protocol/hostOperations').OperationMethod,
        perform: () => unknown | Promise<unknown>): Promise<ProtocolResponse> => {
        if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
        started = true;
        const catalog = methodCatalog[method];
        const result = domainResult(catalog.domainResultSchema, await perform(), catalog.maxDomainBytes);
        if (method !== 'session.create' && result.sessionId !== context.session.sessionId) throw new ProtocolFault('OUTCOME_UNKNOWN');
        return finish({ kind: 'operation', operation: operationMethodSchema.parse(method), requestId, durability: 'not-journaled',
          outcome: 'applied', sessionId: result.sessionId, viewRevision: result.viewRevision });
      };
      const hostRead = async (method: import('../../shared/protocol/hostOperations').HostReadMethod,
        perform: () => unknown | Promise<unknown>): Promise<ProtocolResponse> => {
        if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
        const catalog = methodCatalog[method];
        const value = await perform();
        assertByteBound(value, catalog.maxDomainBytes);
        const parsed = catalog.domainResultSchema.safeParse(value);
        if (!parsed.success) throw new ProtocolFault('INTERNAL_ERROR');
        const result = parsed.data;
        if ('sessionId' in result && (result.sessionId !== context.session.sessionId
          || 'selectionRevision' in result && result.selectionRevision !== context.workspace.selectionRevision)) throw new ProtocolFault('STALE_SESSION');
        return finish(result);
      };
      switch (request.method) {
        case 'session.list': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['session.list']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return hostRead('session.list', () => handler(request.input, context));
        }
        case 'runtime.models': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['runtime.models']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return hostRead('runtime.models', () => handler(request.input, context));
        }
        case 'runtime.queueRead': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['runtime.queueRead']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return hostRead('runtime.queueRead', () => handler(request.input, context));
        }
        case 'team.read': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['team.read']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return hostRead('team.read', () => handler(request.input, context));
        }
        case 'agent.read': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['agent.read']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return hostRead('agent.read', () => handler(request.input, context));
        }
        case 'git.diff': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['git.diff']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return hostRead('git.diff', () => handler(request.input, context));
        }
        case 'git.combinedDiff': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['git.combinedDiff']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return hostRead('git.combinedDiff', () => handler(request.input, context));
        }
        case 'git.commitDetails': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['git.commitDetails']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return hostRead('git.commitDetails', () => handler(request.input, context));
        }
        case 'workspace.monitorDetail': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['workspace.monitorDetail']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return hostRead('workspace.monitorDetail', () => handler(request.input, context));
        }
        case 'text.upload': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['text.upload']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return hostRead('text.upload', () => handler(request.input, context));
        }
        case 'text.cancel': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['text.cancel']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return hostRead('text.cancel', () => handler(request.input, context));
        }
        case 'session.create': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['session.create']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('session.create', () => handler(request.input, context));
        }
        case 'runtime.setModel': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['runtime.setModel']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('runtime.setModel', () => handler(request.input, context));
        }
        case 'runtime.setThinking': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['runtime.setThinking']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('runtime.setThinking', () => handler(request.input, context));
        }
        case 'runtime.queue': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['runtime.queue']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('runtime.queue', () => handler(request.input, context));
        }
        case 'goal.create': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['goal.create']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('goal.create', () => handler(request.input, context));
        }
        case 'goal.control': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['goal.control']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('goal.control', () => handler(request.input, context));
        }
        case 'goal.update': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['goal.update']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('goal.update', () => handler(request.input, context));
        }
        case 'goal.clear': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['goal.clear']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('goal.clear', () => handler(request.input, context));
        }
        case 'goal.editSteering': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['goal.editSteering']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('goal.editSteering', () => handler(request.input, context));
        }
        case 'goal.removeSteering': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['goal.removeSteering']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('goal.removeSteering', () => handler(request.input, context));
        }
        case 'task.create': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['task.create']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('task.create', () => handler(request.input, context));
        }
        case 'task.update': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['task.update']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('task.update', () => handler(request.input, context));
        }
        case 'task.reorder': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['task.reorder']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('task.reorder', () => handler(request.input, context));
        }
        case 'task.delete': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['task.delete']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('task.delete', () => handler(request.input, context));
        }
        case 'task.clear': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['task.clear']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('task.clear', () => handler(request.input, context));
        }
        case 'agent.control': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['agent.control']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('agent.control', () => handler(request.input, context));
        }
        case 'team.control': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['team.control']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('team.control', () => handler(request.input, context));
        }
        case 'agent.workspace': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const handler = this.handlers['agent.workspace']; if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          return operation('agent.workspace', () => handler(request.input, context));
        }
        case 'host.info': {
          if (context.kind !== 'host') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['host.info'];
          const result = domainResult(catalog.domainResultSchema, await this.handlers['host.info'](request.input, context), catalog.maxDomainBytes);
          if (result.serverEpoch !== this.serverEpoch || result.serverTime !== context.serverTime) throw new ProtocolFault('INTERNAL_ERROR');
          return finish(result);
        }
        case 'workspace.list': {
          if (context.kind !== 'host') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['workspace.list'];
          const result = domainResult(catalog.domainResultSchema, await this.handlers['workspace.list'](request.input, context), catalog.maxDomainBytes);
          for (const entry of result.workspaces) {
            if (this.resolvers.isMember(identity, entry.workspaceId) !== true) throw new ProtocolFault('FORBIDDEN');
            const workspace = this.resolvers.workspace(identity, entry.workspaceId);
            if (!workspace || workspace.workspaceId !== entry.workspaceId || workspace.generation !== entry.workspaceGeneration) throw new ProtocolFault('STALE_WORKSPACE');
          }
          return finish(result);
        }
        case 'workspace.snapshot': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['workspace.snapshot'];
          const handler = this.handlers['workspace.snapshot'];
          if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          const result = domainResult(catalog.domainResultSchema, await handler(request.input, context), catalog.maxDomainBytes);
          const header = result.header;
          if (!header || result.index !== 0 || result.snapshotId !== header.snapshotId || header.pageIds[0] !== result.pageId
            || result.nextPageId !== (header.pageIds[1] ?? null)
            || header.workspaceId !== context.workspace.workspaceId || header.workspaceGeneration !== context.workspace.generation
            || header.serverEpoch !== this.serverEpoch || header.sessionId !== context.session.sessionId
            || !header.eventStream || header.eventStream.serverEpoch !== this.serverEpoch
            || header.eventStream.workspaceId !== context.workspace.workspaceId
            || header.eventStream.workspaceGeneration !== context.workspace.generation) throw new ProtocolFault('INTERNAL_ERROR');
          return finish(result);
        }
        case 'workspace.snapshotPage': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['workspace.snapshotPage'];
          const handler = this.handlers['workspace.snapshotPage'];
          if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          const result = domainResult(catalog.domainResultSchema, await handler(request.input, context), catalog.maxDomainBytes);
          if (result.pageId !== request.input.pageId || result.header && (result.snapshotId !== result.header.snapshotId
            || result.header.workspaceId !== context.workspace.workspaceId
            || result.header.workspaceGeneration !== context.workspace.generation
            || result.header.serverEpoch !== this.serverEpoch || result.header.sessionId !== context.session.sessionId)) {
            throw new ProtocolFault('INTERNAL_ERROR');
          }
          return finish(result);
        }
        case 'workspace.monitor': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['workspace.monitor'];
          const handler = this.handlers['workspace.monitor'];
          if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          const result = domainResult(catalog.domainResultSchema, await handler(request.input, context), catalog.maxDomainBytes);
          if (result.section !== request.input.section || result.offset !== request.input.offset
            || result.limit !== request.input.limit || result.items.length > request.input.limit
            || result.items.length > Math.max(0, result.total - result.offset)
            || result.unchanged && (request.input.sinceRevision !== result.revision || result.items.length !== 0)) {
            throw new ProtocolFault('INTERNAL_ERROR');
          }
          return finish(result);
        }
        case 'goal.get': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['goal.get'];
          const handler = this.handlers['goal.get'];
          if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          const result = domainResult(catalog.domainResultSchema, await handler(request.input, context), catalog.maxDomainBytes);
          if (result.sessionId !== context.session.sessionId || result.selectionRevision !== context.workspace.selectionRevision) throw new ProtocolFault('STALE_SESSION');
          return finish(result);
        }
        case 'task.list': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['task.list'];
          const handler = this.handlers['task.list'];
          if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          const result = domainResult(catalog.domainResultSchema, await handler(request.input, context), catalog.maxDomainBytes);
          if (result.sessionId !== context.session.sessionId || result.selectionRevision !== context.workspace.selectionRevision) throw new ProtocolFault('STALE_SESSION');
          return finish(result);
        }
        case 'git.status':
        case 'git.history': {
          if (context.kind !== 'workspace-read') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog[request.method];
          const handler = this.handlers[request.method];
          if (!handler) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
          // Both Git reads use the same empty input; output is parsed against its own method below.
          if (request.method === 'git.status') {
            const result = domainResult(methodCatalog['git.status'].domainResultSchema, await this.handlers['git.status']!(request.input, context), catalog.maxDomainBytes);
            return finish(result);
          }
          const result = domainResult(methodCatalog['git.history'].domainResultSchema, await this.handlers['git.history']!(request.input, context), catalog.maxDomainBytes);
          return finish(result);
        }
        case 'control.claim':
        case 'control.renew':
        case 'control.release':
        case 'control.takeover': {
          if (context.kind !== 'workspace-control' || !this.workspaceControl) throw new ProtocolFault('DISPATCH_DISABLED');
          const control = this.workspaceControl;
          const transition = request.method === 'control.claim' ? control.claim(identity, context.workspace.workspaceId)
            : request.method === 'control.release' ? control.release(identity, context.workspace.workspaceId, request.input.generation)
              : request.method === 'control.takeover' ? control.takeover(identity, context.workspace.workspaceId) : null;
          const lease = request.method === 'control.renew' ? control.renew(identity, context.workspace.workspaceId, request.input.generation) : transition?.current;
          if (transition) {
            // The host hook only tracks server-created connection identities. Its failure
            // cannot undo a lease, so never turn a committed transition into a false refusal.
            try { this.onControlTransition?.(identity, transition); } catch { /* Lease remains authoritative. */ }
          }
          return finish({ generation: transition?.generation ?? lease!.generation, expiresAt: lease?.expiresAt ?? null });
        }
        case 'permission.issue': {
          if (context.kind !== 'session-approval' || !this.approvalChallenges) throw new ProtocolFault('DISPATCH_DISABLED');
          const target = { workspaceId: context.workspace.workspaceId, sessionId: context.session.sessionId,
            action: request.input.action, oldLevel: request.input.oldLevel, newLevel: request.input.newLevel,
            controlGeneration: context.controlGeneration, selectionRevision: context.selectionRevision };
          const challenge = this.approvalChallenges.issue(identity, target);
          return finish({ challengeId: challenge.id, sessionId: challenge.sessionId, oldLevel: challenge.oldLevel,
            newLevel: challenge.newLevel, expiresAt: challenge.expiresAt });
        }
        case 'permission.confirm': {
          if (context.kind !== 'session-approval' || !this.approvalChallenges) throw new ProtocolFault('DISPATCH_DISABLED');
          const target = { workspaceId: context.workspace.workspaceId, sessionId: context.session.sessionId,
            action: request.input.action, oldLevel: request.input.oldLevel, newLevel: request.input.newLevel,
            controlGeneration: context.controlGeneration, selectionRevision: context.selectionRevision };
          await this.approvalChallenges.consume(identity, request.input.challengeId, target, () => { grantAdmitted = true; });
          return finish({ applied: true, sessionId: context.session.sessionId, level: request.input.newLevel });
        }
        case 'file.list': {
          if (context.kind !== 'resource') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['file.list'];
          const result = domainResult(catalog.domainResultSchema, await this.handlers['file.list'](request.input, context), catalog.maxDomainBytes);
          if (result.directoryId !== request.input.directoryId || result.entries.length > request.input.limit) throw new ProtocolFault('INTERNAL_ERROR');
          return finish(result);
        }
        case 'file.previewText': {
          if (context.kind !== 'resource') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['file.previewText'];
          const result = domainResult(catalog.domainResultSchema, await this.handlers['file.previewText'](request.input, context), catalog.maxDomainBytes);
          if (result.fileId !== request.input.fileId) throw new ProtocolFault('INTERNAL_ERROR');
          if (utf8Bytes(result.content) > request.input.maxBytes) throw new ProtocolFault('RESULT_TOO_LARGE');
          return finish(result);
        }
        case 'runtime.prompt': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['runtime.prompt'];
          started = true;
          const result = domainResult(catalog.domainResultSchema, await this.handlers['runtime.prompt'](request.input, context), catalog.maxDomainBytes);
          if (result.sessionId !== request.expectedSessionId) throw new ProtocolFault('INTERNAL_ERROR');
          return finish({ kind: 'prompt', requestId, durability: 'not-journaled', outcome: result.accepted ? 'accepted' : 'not-accepted', sessionId: result.sessionId, runId: result.runId, viewRevision: result.viewRevision });
        }
        case 'runtime.abort': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['runtime.abort'];
          started = true;
          const result = domainResult(catalog.domainResultSchema, await this.handlers['runtime.abort'](request.input, context), catalog.maxDomainBytes);
          if (result.sessionId !== request.expectedSessionId) throw new ProtocolFault('INTERNAL_ERROR');
          // 'abort-reported' does not assert a provider stopped or that a transport timeout canceled it.
          return finish({ kind: 'abort', requestId, durability: 'not-journaled', outcome: result.aborted ? 'abort-reported' : 'nothing-to-abort', sessionId: result.sessionId, viewRevision: result.viewRevision });
        }
        case 'session.select': {
          if (context.kind !== 'session-control') throw new ProtocolFault('INTERNAL_ERROR');
          const catalog = methodCatalog['session.select'];
          started = true;
          const result = domainResult(catalog.domainResultSchema, await this.handlers['session.select'](request.input, context), catalog.maxDomainBytes);
          if (result.sessionId !== request.input.sessionId || result.selectionRevision < request.selectionRevision
            || (result.sessionId !== request.expectedSessionId && result.selectionRevision === request.selectionRevision)) throw new ProtocolFault('INTERNAL_ERROR');
          return finish({ kind: 'selection', requestId, durability: 'not-journaled', outcome: 'selected', sessionId: result.sessionId, selectionRevision: result.selectionRevision, viewRevision: result.viewRevision });
        }
        default: return unreachable(request);
      }
    };
    try {
      if (journaledRequest(request) && this.commandJournal) {
        // The journal owns a per-workspace effect lane; the legacy preparation fence is not
        // also held over disk writes or an active prompt. Abort and status remain available.
        this.authorizeJournalScope(request, identity);
        let receipt: MutationReceipt;
        let entryContext: ExecutionContext | undefined;
        try {
          receipt = await this.commandJournal.execute(request, identity.principalId, async () => {
            try {
              const response = await execute(entryContext);
              if (!response.ok) throw new ProtocolFault('OUTCOME_UNKNOWN');
              if (request.method === 'permission.confirm') {
                if (response.method !== 'permission.confirm' || response.result.sessionId !== request.input.sessionId
                  || response.result.level !== request.input.newLevel) throw new ProtocolFault('OUTCOME_UNKNOWN');
                // The existing atomicGrant completed; never infer application from a later current level.
                return permissionReceiptSchema.parse({ kind: 'permission', requestId, durability: 'journaled', outcome: 'applied',
                  challengeId: request.input.challengeId, workspaceId: request.workspaceId, workspaceGeneration: request.workspaceGeneration,
                  sessionId: request.input.sessionId, selectionRevision: request.selectionRevision, controlGeneration: request.controlGeneration,
                  oldLevel: request.input.oldLevel, newLevel: request.input.newLevel });
              }
              return mutationReceiptSchema.parse({ ...response.result, durability: 'journaled' });
            } catch (error) {
              // A nonce/state/authority refusal BEFORE atomicGrant admission is a proven rejection.
              if (request.method === 'permission.confirm' && !grantAdmitted && error instanceof ProtocolFault) {
                throw new JournalRejected(error.code);
              }
              throw error;
            }
          }, () => { this.authorizeNow(request, identity); }, () => { entryContext = this.authorizeNow(request, identity); });
        } catch (error) {
          if (error instanceof JournalRejected) { started = false; grantAdmitted = false; }
          // Failure before effect cannot prevent an explicit attempt to stop active work.
          // Abort alone retains the prior non-journaled path; never retry an uncertain effect.
          if (request.method === 'runtime.abort' && error instanceof ProtocolFault && error.code === 'STORAGE_UNAVAILABLE') return execute();
          throw error;
        }
        // The journal returned a durable receipt: authorization can still fail now, but
        // this call can no longer claim that the original command did not start.
        recordedOutcome = true;
        this.authorizeJournalScope(request, identity);
        scope = { workspaceId: request.workspaceId, workspaceGeneration: request.workspaceGeneration };
        return responseEnvelopeSchema.parse({ protocol: 1, ok: true, requestId, serverEpoch: this.serverEpoch, scope, method: request.method,
          result: request.method === 'permission.confirm' && receipt.kind === 'permission'
            ? { applied: true, sessionId: receipt.sessionId, level: receipt.newLevel } : receipt });
      }
      this.authorizeNow(request, identity);
      if (!mutationRequest(request)) return await execute();
      if (!this.admissionFence) throw new ProtocolFault('STORAGE_UNAVAILABLE');
      let lease: Awaited<ReturnType<AdmissionFence['enter']>>;
      try { lease = await this.admissionFence.enter(request, identity); }
      catch (error) { throw error instanceof ProtocolFault ? error : new ProtocolFault('STORAGE_UNAVAILABLE'); }
      if (!lease) throw new ProtocolFault('BUSY');
      if (typeof lease.release !== 'function') throw new ProtocolFault('STORAGE_UNAVAILABLE');
      try { return await execute(); } finally { lease.release(); }
    } catch (error) {
      // Handler failures can occur after effects. Never translate timeout/abort exceptions into success or canceled state.
      return failure(error instanceof ProtocolFault ? error.code : started ? 'OUTCOME_UNKNOWN' : 'INTERNAL_ERROR');
    }
  }
}
