import type { ProjectRegistrationPort } from '../ports';
import type { ProjectState } from '../../shared/contracts/ipc';
import { isAdapterCreatedContext, type RequestContext } from '../dispatch/RequestContext';
import { ProjectTrustService } from '../projects/ProjectTrustService';
import { FilesystemService } from '../../main/files/FilesystemService';
import { GitService } from '../../main/git/GitService';
import path from 'node:path';
import type { FatePaths } from '../FatePaths';
import { MultiProjectPiRuntime } from '../../main/pi/MultiProjectPiRuntime';
import type { WorkspaceHandle } from './WorkspaceHandle';
import { WorkspaceAdmissionQueue, type WorkspaceAdmissionPort } from './WorkspaceAdmissionQueue';
import { CheckoutOwnership } from '../ownership/CheckoutOwnership';

export interface WorkspaceRegistryOptions {
  readonly projects: ProjectTrustService;
  readonly registration: ProjectRegistrationPort;
  readonly runtime: MultiProjectPiRuntime;
  readonly paths?: FatePaths;
  readonly checkoutOwnership?: CheckoutOwnership;
  /** Trusted credential-to-workspace mapping. Never derived from request JSON. */
  readonly isMember: (identity: RequestContext, workspaceId: string) => boolean;
  readonly makeAdmission?: (runtime: WorkspaceHandle['runtime'], generation: number) => WorkspaceAdmissionPort<WorkspaceHandle['runtime']>;
  /** Host-only storage/recovery fence. Never sourced from a request. */
  readonly assertStorageAdmission?: (root?: string, sessionId?: string | null, principalId?: string) => void;
  readonly maxWorkspaces?: number;
}

/** Host-owned workspace identities. No command path can create a registration. */
export class WorkspaceRegistry {
  private readonly byRoot = new Map<string, WorkspaceHandle>();
  private readonly byId = new Map<string, WorkspaceHandle>();
  private readonly pending = new Map<string, Promise<WorkspaceHandle>>();
  private readonly closing = new Set<string>();
  private readonly maxWorkspaces: number;
  private stopping = false;
  private hostShutdown = false;

  constructor(private readonly options: WorkspaceRegistryOptions) {
    this.maxWorkspaces = options.maxWorkspaces ?? 8;
    if (!Number.isSafeInteger(this.maxWorkspaces) || this.maxWorkspaces < 1 || this.maxWorkspaces > 8) throw new Error('A bounded workspace limit is required.');
  }

  /** Host administration only. The ordinary command catalog has no path registration method. */
  async registerHostPath(hostPath: string): Promise<WorkspaceHandle> {
    if (this.stopping) throw new Error('Workspace registry is stopping.');
    const activation = await this.options.projects.prepareRegisteredProject(hostPath, this.options.registration);
    const root = activation.project.path;
    if (this.stopping || this.options.registration.isRegistered(root) !== true) throw new Error('Host registration was revoked.');
    const existing = this.byRoot.get(root);
    if (existing && this.closing.has(existing.id)) throw new Error('Workspace is closing.');
    // Resolving a current, registered live handle is not a new admission.
    // The desktop must still capture it for safe reads and abort when storage
    // is pending or failed. Creation and replacement remain fenced below.
    if (existing && existing.runtime === this.options.runtime.peekWorkspace(root)) return existing;
    this.options.assertStorageAdmission?.(root);
    if (existing && this.busy(existing)) throw new Error('Cannot replace an active workspace.');
    const pending = this.pending.get(root);
    if (pending) return pending;
    if (!existing && this.byRoot.size + this.pending.size >= this.maxWorkspaces) throw new Error('Workspace limit reached.');
    const task = this.create(root, activation.project);
    this.pending.set(root, task);
    try { return await task; }
    finally { if (this.pending.get(root) === task) this.pending.delete(root); }
  }

  private async create(root: string, project: ProjectState): Promise<WorkspaceHandle> {
    const files = await FilesystemService.forRoot(root);
    this.options.assertStorageAdmission?.(root);
    if (files.getRoot() !== root || this.options.registration.isRegistered(root) !== true || this.stopping) {
      throw new Error('Workspace registration changed before runtime startup.');
    }
    // The runtime boundary owns the checkout for both legacy desktop and
    // scoped host calls. The registry must not acquire a second lock.
    this.options.runtime.registerKnownWorkspace(project);
    const runtime = await this.options.runtime.acquireWorkspace(root);
    this.options.assertStorageAdmission?.(root);
    if (this.options.checkoutOwnership && !this.options.runtime.ownsCheckout(root)) throw new Error('A live workspace runtime requires checkout ownership.');
    if (this.options.registration.isRegistered(root) !== true || this.stopping) {
      await this.options.runtime.closeProjectPath(root);
      throw new Error('Workspace registration changed during runtime startup.');
    }
    const prior = this.byRoot.get(root);
    if (prior && prior.runtime !== runtime && this.busy(prior)) throw new Error('Cannot replace an active workspace.');
    const origin = this.options.runtime.workspaceOrigin(root);
    if (!origin) throw new Error('Runtime workspace origin is missing.');
    const generation = origin.workspaceGeneration;
    const handle: WorkspaceHandle = Object.freeze({
      id: origin.workspaceId, generation,
      root, files, git: this.options.paths && this.options.paths.profileKind === 'server'
        ? new GitService(files, path.join(this.options.paths.dataRoot, 'worktrees'), this.options.paths.attachmentRoot, this.options.checkoutOwnership)
        : new GitService(files, undefined, undefined, this.options.checkoutOwnership), runtime,
      admission: this.options.makeAdmission?.(runtime, generation) ?? new WorkspaceAdmissionQueue(runtime, generation,
        (sessionId, principalId) => this.options.assertStorageAdmission?.(root, sessionId, principalId)),
    });
    runtime.setSelectionListener((sessionId) => handle.admission.observeSelection(sessionId));
    this.byRoot.set(root, handle);
    this.byId.set(handle.id, handle);
    this.options.runtime.setWorkspaceAdmissionGuard(root, () => handle.admission.pending > 0);
    this.options.runtime.setWorkspaceLifecycleHooks(root, {
      beforeDispose: (service) => {
        if (service !== handle.runtime || (!this.stopping && this.busy(handle))) throw new Error('Cannot close an active or replaced workspace.');
        this.closing.add(handle.id);
        handle.admission.seal();
      },
      onEvicted: () => this.forget(handle),
    });
    return handle;
  }

  /** Trusted producer attribution; no focus or renderer owner ID is used. */
  hostRootForOrigin(workspaceId: string, generation: number): string | null {
    const handle = this.byId.get(workspaceId);
    return handle?.generation === generation ? handle.root : null;
  }

  private busy(handle: WorkspaceHandle): boolean {
    return handle.runtime.hasEvictionBlockingWork() || handle.admission.pending > 0;
  }

  /** Authenticate and check current membership before returning any host handle. */
  resolve(identity: RequestContext, workspaceId: string, generation: number): WorkspaceHandle {
    if (this.stopping || !isAdapterCreatedContext(identity) || identity.expiresAt <= Date.now()
      || this.options.isMember(identity, workspaceId) !== true) throw new Error('Workspace membership required.');
    const handle = this.byId.get(workspaceId);
    if (!handle || this.closing.has(workspaceId) || this.options.registration.isRegistered(handle.root) !== true) throw new Error('Workspace is not registered.');
    if (handle.generation !== generation || this.options.runtime.peekWorkspace(handle.root) !== handle.runtime) throw new Error('Stale workspace generation.');
    return handle;
  }

  private forget(handle: WorkspaceHandle): void {
    if (this.byRoot.get(handle.root) === handle) {
      this.byRoot.delete(handle.root);
      this.options.runtime.setWorkspaceAdmissionGuard(handle.root, null);
      this.options.runtime.setWorkspaceLifecycleHooks(handle.root, null);
    }
    if (this.byId.get(handle.id) === handle) this.byId.delete(handle.id);
    this.closing.delete(handle.id);
  }

  /** Refuse active writers; no implicit abort or closing of another workspace. */
  async unregisterHostWorkspace(workspaceId: string): Promise<void> {
    const handle = this.byId.get(workspaceId);
    if (!handle) return;
    if (this.busy(handle)) throw new Error('Cannot close an active workspace.');
    this.closing.add(workspaceId);
    handle.admission.seal();
    const live = this.options.runtime.peekWorkspace(handle.root);
    if (live && live !== handle.runtime) throw new Error('Cannot release checkout ownership while a replaced runtime is live.');
    if (live) await this.options.runtime.closeProjectPath(handle.root);
    this.forget(handle);
  }

  /** Ordinary registry disposal still refuses active work; it cannot stop a host run. */
  beginShutdown(): void {
    if (this.stopping) return;
    if (this.pending.size > 0 || [...this.byId.values()].some((handle) => this.busy(handle))) {
      throw new Error('Cannot stop a workspace registry while work is active.');
    }
    this.seal();
  }

  /** The host-owned stop path seals synchronously, then asks the runtime to cancel. */
  sealForHostShutdown(): void {
    this.hostShutdown = true;
    this.seal();
  }

  private seal(): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const handle of this.byId.values()) {
      this.closing.add(handle.id);
      handle.admission.seal();
    }
  }

  async dispose(): Promise<void> {
    this.beginShutdown();
    const pending = await Promise.allSettled([...this.pending.values()]);
    const failures = pending.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (this.hostShutdown) {
      // The host runtime disposer owns cancellation and checkout release.
      // Existing admitted operations must settle before that disposer runs.
      await Promise.all([...this.byId.values()].map((handle) => handle.admission.settled()));
    } else {
      for (const handle of [...this.byId.values()]) {
        try { await this.unregisterHostWorkspace(handle.id); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Workspace shutdown was incomplete.');
  }
}
