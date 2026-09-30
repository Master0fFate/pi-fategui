import { randomUUID } from 'node:crypto';
import { Dispatcher, type HandlerMap } from '../../core/dispatch/Dispatcher';
import { createLocalIpcContext, type RequestContext } from '../../core/dispatch/RequestContext';
import { createScopedRuntimeHandlers } from '../../core/handlers/runtimeHandlers';
import { createScopedSessionHandlers } from '../../core/handlers/sessionHandlers';
import type { WorkspaceRegistry } from '../../core/workspaces/WorkspaceRegistry';
import type { WorkspaceHandle } from '../../core/workspaces/WorkspaceHandle';
import type { AdmissionAuthority, SessionAdmission } from '../../core/workspaces/WorkspaceAdmissionQueue';
import { ProtocolFault } from '../../shared/protocol/errors';
import { createMutationIdentity, uuidSchema } from '../../shared/protocol/requestIds';
import { abortResultSchema, emptyInputSchema, promptAcceptanceSchema, promptInputSchema, runtimeStateSchema, sessionIdInputSchema } from '../../shared/contracts/ipc';
import { monitorDashboardSchema, monitorReadInputSchema, type MonitorDashboard } from '../../shared/contracts/monitorDashboard';
import { PiDesktopError } from '../pi/errors';
import type { MultiProjectPiRuntime } from '../pi/MultiProjectPiRuntime';
import { desktopHostCapabilities, supportsHostOperation, type HostCapabilities } from '../../shared/protocol/capabilities';

const senderError = () => new PiDesktopError({ code: 'INVALID_REQUEST', message: 'IPC is restricted to the application main frame.', retryable: false });
const changedError = () => new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The project or session changed during the operation.', retryable: true });

type DesktopOwner = Pick<MultiProjectPiRuntime, 'asRouter' | 'peekWorkspace' | 'workspaceOrigin' | 'workspaceSelectionRevision'>;
type DesktopRegistry = Pick<WorkspaceRegistry, 'registerHostPath' | 'resolve'>;
type Captured = {
  readonly identity: RequestContext;
  readonly handle: WorkspaceHandle;
  readonly command: SessionAdmission;
  readonly authorize: () => AdmissionAuthority;
  readonly live: () => boolean;
};

/** One instance per trusted window. No renderer-supplied path, identity, or authority enters the core. */
export class CoreIpcAdapter {
  private readonly epoch = randomUUID();
  private readonly principalId = randomUUID();
  private readonly clientId = randomUUID();
  private readonly controlGeneration = 1; // Host-owned local window lease, not a remote controller grant.

  constructor(private readonly runtime: DesktopOwner, private readonly registry: DesktopRegistry,
    private readonly trustedSender: () => boolean, private readonly resolveReferencePath?: (path: string) => Promise<string>,
    private readonly hostCapabilities: HostCapabilities = desktopHostCapabilities,
    private readonly localTarget: () => boolean = () => true) {}

  /** A per-call document fence; the underlying window adapter and its IDs stay stable. */
  forInvocation(documentIsCurrent: () => boolean) {
    const guard = () => this.localTarget() && documentIsCurrent() && this.trustedSender();
    return {
      scoped: <T>(work: (captured: Captured) => T | Promise<T>) => this.scoped(work, guard),
      monitor: (input: unknown) => this.monitor(input, guard),
      abort: (input: unknown) => this.abort(input, guard),
      prompt: (input: unknown) => this.prompt(input, guard),
      select: (input: unknown) => this.select(input, guard),
    };
  }

  private async capture(senderGuard = this.trustedSender): Promise<Captured> {
    if (!this.localTarget() || !senderGuard()) throw senderError();
    const router = this.runtime.asRouter();
    const state = router.getState(false);
    if (!state.project?.trusted) throw new PiDesktopError({ code: 'PROJECT_NOT_TRUSTED', message: 'Trust a project first.', retryable: false });
    const root = state.project.path;
    const initialRevision = this.runtime.workspaceSelectionRevision(root);
    const identity = createLocalIpcContext({ principalId: this.principalId, clientId: this.clientId, expiresAt: Date.now() + 60_000 });
    const handle = await this.registry.registerHostPath(root);
    const live = () => {
      if (!this.localTarget() || !senderGuard()) return false;
      const current = router.getState(false);
      if (current.project?.trusted !== true || current.project.path !== root
        || this.runtime.peekWorkspace(root) !== handle.runtime
        || this.runtime.workspaceOrigin(root)?.workspaceGeneration !== handle.generation) return false;
      try { return this.registry.resolve(identity, handle.id, handle.generation) === handle; }
      catch { return false; }
    };
    if (!live()) throw changedError();
    const selection = handle.admission.snapshot();
    // The runtime observes selection before registry creation. Equality of IDs alone
    // cannot detect an A→B→A switch during the first asynchronous registration.
    const observedRevision = this.runtime.workspaceSelectionRevision(root);
    if (selection.selectedSessionId !== state.sessionId || observedRevision === null
      || (initialRevision !== null ? observedRevision !== initialRevision : observedRevision !== 0)) throw changedError();
    const command: SessionAdmission = { workspaceGeneration: handle.generation,
      expectedSessionId: selection.selectedSessionId, selectionRevision: selection.selectionRevision,
      controlGeneration: this.controlGeneration };
    const authorize = (): AdmissionAuthority => ({ currentGeneration: live() ? handle.generation : -1,
      controlGeneration: live() ? this.controlGeneration : null, permission: live(), principalId: identity.principalId });
    return { identity, handle, command, authorize, live };
  }

  /** Desktop-only named reads and rich legacy calls use the same captured workspace and queue. */
  async scoped<T>(work: (captured: Captured) => T | Promise<T>, senderGuard = this.trustedSender): Promise<T> {
    const captured = await this.capture(senderGuard);
    if (!captured.live()) throw changedError();
    const result = await work(captured);
    if (!captured.live()) throw changedError();
    return result;
  }

  async monitor(input: unknown, senderGuard = this.trustedSender): Promise<MonitorDashboard> {
    if (!this.localTarget() || !senderGuard()) throw senderError();
    const localDesktop = this.hostCapabilities === desktopHostCapabilities;
    const workspaces = this.hostCapabilities.workspaces;
    if (!supportsHostOperation(this.hostCapabilities, 'monitor')
      || !localDesktop && (workspaces.length === 0 || !workspaces.some((workspace) => workspace.supported.monitor))) {
      throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
    }
    const query = monitorReadInputSchema.parse(input);
    const initial = this.runtime.asRouter().getState(false);
    if (!localDesktop) {
      // Bind a registered host's scope to the trusted runtime, never a caller-supplied ID.
      // With no selected project, only a single registered workspace is unambiguous.
      const workspaceId = initial.project?.path
        ? this.runtime.workspaceOrigin(initial.project.path)?.workspaceId
        : workspaces.length === 1 ? workspaces[0]?.workspaceId : undefined;
      if (!workspaceId || !supportsHostOperation(this.hostCapabilities, 'monitor', workspaceId)) {
        throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
      }
    }
    if (!initial.project?.trusted) {
      // Preserve the disconnected desktop's named Monitor empty/error state.
      const result = monitorDashboardSchema.parse(await this.runtime.asRouter().getMonitorDashboard(query));
      if (!this.localTarget() || !senderGuard() || this.runtime.asRouter().getState(false).project?.path !== initial.project?.path) throw changedError();
      return result;
    }
    return this.scoped(async ({ handle, command, live }) => {
      if (!localDesktop && !supportsHostOperation(this.hostCapabilities, 'monitor', handle.id)) throw new ProtocolFault('UNSUPPORTED_CAPABILITY');
      // The named desktop read must also work for a selected saved/cold session.
      // Agent tools use their separate live-root-scoped handler.
      const result = monitorDashboardSchema.parse(await handle.runtime.getMonitorDashboard(query));
      const selection = handle.admission.snapshot();
      if (!live() || selection.selectionRevision !== command.selectionRevision
        || selection.selectedSessionId !== command.expectedSessionId
        || result.projectPath !== handle.root || result.sessionId !== command.expectedSessionId) throw changedError();
      return result;
    }, senderGuard);
  }

  /** The three portable mutations use one dispatcher; rich desktop-only inputs use scoped handlers. */
  private async dispatch(method: 'runtime.abort' | 'runtime.prompt' | 'session.select', input: object,
    captured: Captured): Promise<{ result: unknown; domain: unknown }> {
    const { identity, handle, command, authorize, live } = captured;
    const sessionId = command.expectedSessionId;
    if (!sessionId) throw changedError();
    let domain: unknown;
    let nativeError: unknown;
    let failed = false;
    const unsupported = (): never => { throw new ProtocolFault('UNSUPPORTED_CAPABILITY'); };
    const handlers = {
      'host.info': unsupported, 'workspace.list': unsupported, 'file.list': unsupported, 'file.previewText': unsupported,
      'runtime.abort': async () => {
        try {
          const result = await createScopedRuntimeHandlers(handle, authorize).abort(command, {});
          const parsed = abortResultSchema.parse(result);
          domain = parsed;
          return { ...parsed, sessionId, viewRevision: handle.admission.snapshot().selectionRevision };
        } catch (error) { failed = true; nativeError = error; throw error; }
      },
      'runtime.prompt': async (payload) => {
        try {
          const result = await createScopedRuntimeHandlers(handle, authorize).prompt(command, payload);
          const parsed = promptAcceptanceSchema.parse(result);
          domain = parsed;
          return { ...parsed, sessionId, viewRevision: handle.admission.snapshot().selectionRevision };
        } catch (error) { failed = true; nativeError = error; throw error; }
      },
      'session.select': async (payload) => {
        try {
          const result = await createScopedSessionHandlers(handle, authorize).selectSession(command, payload);
          domain = runtimeStateSchema.parse(result);
          return { sessionId: payload.sessionId, selectionRevision: handle.admission.snapshot().selectionRevision,
            viewRevision: handle.admission.snapshot().selectionRevision };
        } catch (error) { failed = true; nativeError = error; throw error; }
      },
    } satisfies HandlerMap;
    const dispatcher = new Dispatcher({ serverEpoch: this.epoch, handlers,
      resolvers: {
        authenticate: (context) => context === identity && live(),
        isMember: (context, id) => context === identity && id === handle.id && live(),
        workspace: (context, id) => context === identity && id === handle.id && live() ? {
          workspaceId: id, generation: handle.generation, handle,
          ...handle.admission.snapshot(),
        } : null,
        hasCapability: (_context, capability) => capability === method && live(),
        hasControl: (_context, _workspace, generation) => generation === this.controlGeneration && live(),
        hasPermission: (_context, _workspace, operation) => operation === ({ 'runtime.abort': 'abort',
          'runtime.prompt': 'prompt', 'session.select': 'select' } as const)[method] && live(),
        session: (_context, _workspace, id) => id && live() ? {
          sessionId: id, workspaceId: handle.id, workspaceGeneration: handle.generation, handle: handle.runtime,
        } : null,
        resource: () => null,
      },
      admissionFence: { enter: async () => live() ? { release: () => undefined } : null },
    });
    const response = await dispatcher.dispatchJson(JSON.stringify({ protocol: 1, ...createMutationIdentity(this.epoch),
      method, workspaceId: handle.id, workspaceGeneration: handle.generation,
      expectedSessionId: command.expectedSessionId, selectionRevision: command.selectionRevision,
      controlGeneration: command.controlGeneration, input,
    }), identity);
    if (failed) throw nativeError;
    if (!response.ok) throw new PiDesktopError({ code: response.error.code === 'STALE_SESSION' || response.error.code === 'STALE_WORKSPACE'
      ? 'INVALID_REQUEST' : 'PI_RUNTIME_ERROR', message: response.error.message, retryable: response.execution === 'not-started' });
    if (response.method !== method) throw new Error('Unexpected IPC dispatch result.');
    return { result: response.result, domain };
  }

  async abort(input: unknown, senderGuard = this.trustedSender): Promise<{ aborted: boolean }> {
    emptyInputSchema.parse(input);
    if (!this.localTarget() || !senderGuard()) throw senderError();
    const state = this.runtime.asRouter().getState(false);
    if (!state.project?.trusted || !state.sessionId) return abortResultSchema.parse(await this.runtime.asRouter().abort());
    const captured = await this.capture(senderGuard);
    if (!uuidSchema.safeParse(captured.command.expectedSessionId).success) {
      return createScopedRuntimeHandlers(captured.handle, captured.authorize).abort(captured.command, {});
    }
    const response = await this.dispatch('runtime.abort', {}, captured);
    return abortResultSchema.parse(response.domain);
  }

  async prompt(input: unknown, senderGuard = this.trustedSender) {
    const parsed = promptInputSchema.parse(input);
    const captured = await this.capture(senderGuard);
    if (!uuidSchema.safeParse(captured.command.expectedSessionId).success || parsed.behavior !== 'prompt' || parsed.images || parsed.browserAnnotations
      || parsed.sessionReferences || parsed.learning) {
      // The portable catalog intentionally does not accept rich desktop prompt fields or a null session.
      return createScopedRuntimeHandlers(captured.handle, captured.authorize, this.resolveReferencePath).prompt(captured.command, parsed);
    }
    const response = await this.dispatch('runtime.prompt', { text: parsed.text }, captured);
    return promptAcceptanceSchema.parse(response.domain);
  }

  async select(input: unknown, senderGuard = this.trustedSender) {
    const parsed = sessionIdInputSchema.parse(input);
    const captured = await this.capture(senderGuard);
    if (!uuidSchema.safeParse(captured.command.expectedSessionId).success || !uuidSchema.safeParse(parsed.sessionId).success) {
      return createScopedSessionHandlers(captured.handle, captured.authorize).selectSession(captured.command, parsed);
    }
    const response = await this.dispatch('session.select', parsed, captured);
    return runtimeStateSchema.parse(response.domain);
  }
}
