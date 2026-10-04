import { unsupportedWebFateMethods, type WebWorkspace, type WebSnapshot, type WebInput,
  type PendingPromptReviewLookup, type PendingPromptReview, type PendingCommandMethod } from '../../client/WebFateApi';
import { UnconfirmedCommand } from '../../client/HttpCommandTransport';
import { desktopConnectionStateSchema, remoteScopeSchema, type DesktopConnectionApi,
  type DesktopConnectionState, type RemoteScope, type RemoteMutation, type RemoteOperation, type RemotePromptOptions } from '../../shared/contracts/connections';
import { methodCatalog, type Capability, type WireResultOf, type InputOf, type MutationMethodName } from '../../shared/protocol/methods';
import { operationReceiptSchema } from '../../shared/protocol/hostOperations';
import type { NetworkWorkspaceApi } from '../../client/NetworkWorkspaceApi';
import type { MonitorReadInput } from '../../shared/contracts/monitorDashboard';

const sameScope = (left: RemoteScope, right: RemoteScope): boolean => JSON.stringify(remoteScopeSchema.parse(left)) === JSON.stringify(remoteScopeSchema.parse(right));
/** Renderer presentation adapter for named public DTOs only. Networking/authentication stay in main.
 * Structural public surface matches the common bounded workspace UI; it is NOT a WebFateApi subclass. */
export class RemoteDesktopFateApi implements NetworkWorkspaceApi {
  readonly shared = unsupportedWebFateMethods();
  private state: DesktopConnectionState | null = null;
  private selected: WebWorkspace | null = null;
  private snapshot: WebSnapshot | null = null;
  private boundScope: RemoteScope | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly dismissed = new Set<string>();
  private reading = 0;
  private snapshotRead = 0;
  private lifecycle = 0;
  private stateRevision = 0;
  private initializeRequest = 0;
  private connectionOperation = 0;
  private subscriptionRevision = 0;
  private clockAtSync = 0;
  private performanceAtSync = 0;
  private readonly approvals = new Map<string, WireResultOf<'permission.issue'>>();
  constructor(private readonly bridge: DesktopConnectionApi) {}
  get origin(): string { return `fate-native://${this.state?.profile?.hostId ?? 'unselected'}`; }
  /** Public profile identity, not a bearer, principal, or control authority. Keeps drafts profile-bound. */
  get authenticatedSessionId(): string { return this.state?.profile?.id ?? 'native-unselected'; }
  get serverEpoch(): string | null { return this.state?.serverEpoch ?? null; }
  get hostId(): string | null { return this.state?.profile?.hostId ?? null; }
  get hostName(): string | null { return this.state?.hostName ?? this.state?.profile?.label ?? null; }
  get takeoverAllowed(): boolean { return this.isConnected && this.state?.takeoverAllowed === true; }
  get estimatedHostTime(): number { return Math.max(0, Math.floor(this.clockAtSync + performance.now() - this.performanceAtSync)); }
  get workspace(): WebWorkspace | null { return this.selected; }
  get isConnected(): boolean { return this.state?.kind === 'remote' && ['observing', 'controlling', 'synchronizing'].includes(this.state.status); }
  get reconnectError(): string | null {
    return this.state?.kind === 'remote' && ['error', 'incompatible', 'disconnected'].includes(this.state.status)
      ? 'Remote connection unavailable. Last confirmed work may continue on the host; reconnect explicitly, never resend uncertain commands.' : null;
  }
  get control(): number | null {
    return this.isConnected && this.snapshot && this.boundScope && this.state?.scope && sameScope(this.boundScope, this.state.scope)
      ? this.state.controlGeneration : null;
  }
  supports(capability: Capability): boolean {
    return this.isConnected && this.state?.capabilities.includes(capability) === true
      && (!['runtime.prompt', 'runtime.abort', 'session.select'].includes(capability) || this.state.outcomeStorage === 'ready');
  }
  onInvalidate(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private update(input: DesktopConnectionState): void {
    const state = desktopConnectionStateSchema.parse(input), previous = this.state;
    if (previous && state.generation < previous.generation) return;
    this.stateRevision++;
    const authorityChanged = previous !== null && state.controlGeneration !== previous.controlGeneration;
    const changedHost = previous !== null && (state.generation !== previous.generation || state.kind !== previous.kind
      || state.profile?.id !== previous.profile?.id || state.profile?.hostId !== previous.profile?.hostId
      || state.serverEpoch !== previous.serverEpoch);
    const bindingChanged = previous !== null && JSON.stringify(state.scope) !== JSON.stringify(previous.scope);
    const invalidated = !['observing', 'controlling', 'synchronizing'].includes(state.status)
      || state.message === 'refresh-required' && state.status !== 'synchronizing';
    const estimated = this.estimatedHostTime;
    this.state = state;
    if (state.serverTime !== undefined && state.serverTime !== null) {
      this.clockAtSync = previous?.serverEpoch === state.serverEpoch ? Math.max(estimated, state.serverTime) : state.serverTime;
      this.performanceAtSync = performance.now();
    }
    if (changedHost || bindingChanged || authorityChanged) this.approvals.clear();
    if (changedHost) { this.lifecycle++; this.snapshotRead++; this.selected = null; this.snapshot = null; this.boundScope = null; }
    else if ((invalidated || bindingChanged) && this.reading === 0) this.snapshot = null;
    if (changedHost || authorityChanged || (invalidated || bindingChanged) && this.reading === 0) this.notify();
  }
  async initialize(): Promise<DesktopConnectionState> {
    const request = ++this.initializeRequest;
    if (!this.unsubscribe) {
      const subscription = ++this.subscriptionRevision;
      this.unsubscribe = this.bridge.onConnectionState((state) => { if (subscription === this.subscriptionRevision) this.update(state); });
    }
    const lifecycle = this.lifecycle, revision = this.stateRevision;
    let state: DesktopConnectionState;
    try { state = await this.bridge.getConnectionState(); }
    catch (error) {
      if (request === this.initializeRequest && lifecycle === this.lifecycle && revision === this.stateRevision) throw error;
      if (!this.state) throw new Error('Remote connection lifecycle changed or initialization superseded. Initialize again.');
      return desktopConnectionStateSchema.parse(this.state);
    }
    // Starting a newer read supersedes this one before either result can advance stateRevision.
    if (request === this.initializeRequest && lifecycle === this.lifecycle && revision === this.stateRevision) this.update(state);
    if (!this.state) throw new Error('Remote connection lifecycle changed or initialization superseded. Initialize again.');
    return desktopConnectionStateSchema.parse(this.state);
  }
  private async connectionAction(action: 'connect' | 'disconnect'): Promise<void> {
    if (!this.state) await this.initialize();
    const target = this.state;
    if (!target || target.kind !== 'remote' || !target.profile) throw new Error('Select an approved remote profile first.');
    this.initializeRequest++;
    const lifecycle = this.lifecycle, revision = this.stateRevision, operation = ++this.connectionOperation;
    const result = action === 'connect' ? await this.bridge.connectConnection(target.generation)
      : await this.bridge.disconnectConnection(target.generation);
    // Events are the newer authority. Even our own lifecycle event makes a delayed response
    // redundant; never overwrite newer same-generation metadata, selection or disconnect.
    const current = this.state;
    if (operation !== this.connectionOperation || lifecycle !== this.lifecycle || revision !== this.stateRevision
      || !current || current.generation !== target.generation || current.kind !== target.kind || !current.profile
      || current.profile.id !== target.profile.id || current.profile.hostId !== target.profile.hostId
      || result.generation !== target.generation + 1 || result.kind !== 'remote' || !result.profile
      || result.profile.id !== target.profile.id || result.profile.hostId !== target.profile.hostId) return;
    this.update(result);
  }
  connect(): Promise<void> { return this.connectionAction('connect'); }
  disconnect(): Promise<void> { return this.connectionAction('disconnect'); }
  private current(): DesktopConnectionState {
    if (!this.isConnected || !this.state?.profile || !this.state.serverEpoch) throw new Error('Connect the selected remote profile first.');
    return this.state;
  }
  private scope(workspace: WebWorkspace): RemoteScope {
    this.current();
    const scope = this.boundScope;
    if (!scope || !this.selected || scope.generation !== this.state!.generation || scope.hostId !== this.state!.profile!.hostId
      || scope.profileId !== this.state!.profile!.id || scope.serverEpoch !== this.state!.serverEpoch
      || workspace.workspaceId !== scope.workspaceId || workspace.workspaceGeneration !== scope.workspaceGeneration
      || !this.state?.scope || !sameScope(scope, this.state.scope)) {
      throw new Error('Refresh the selected remote workspace.');
    }
    return scope;
  }
  private async read<T>(workspace: WebWorkspace, operation: (scope: RemoteScope) => Promise<T>): Promise<T> {
    const scope = this.scope(workspace), lifecycle = this.lifecycle, snapshot = this.snapshot;
    const result = await operation(scope);
    if (lifecycle !== this.lifecycle || !this.isConnected || !sameScope(scope, this.scope(workspace)) || snapshot !== this.snapshot) {
      throw new Error('Remote workspace changed. Refresh before using this result.');
    }
    return result;
  }
  async listWorkspaces(): Promise<readonly WebWorkspace[]> {
    const state = this.current(), lifecycle = this.lifecycle;
    const workspaces = await this.bridge.remoteListWorkspaces(state.generation);
    if (lifecycle !== this.lifecycle || !this.isConnected || this.state?.generation !== state.generation) throw new Error('Remote host changed.');
    return workspaces;
  }
  async readSnapshot(workspace: WebWorkspace): Promise<WebSnapshot> {
    const state = this.current(), lifecycle = this.lifecycle, operation = ++this.snapshotRead;
    this.reading++;
    try {
      const result = await this.bridge.remoteReadSnapshot(state.generation, workspace), current = this.state;
      if (operation !== this.snapshotRead || lifecycle !== this.lifecycle || !this.isConnected || !current || result.scope.generation !== current.generation
        || result.scope.profileId !== current.profile?.id || result.scope.hostId !== current.profile?.hostId
        || result.scope.serverEpoch !== current.serverEpoch || result.scope.workspaceId !== workspace.workspaceId
        || result.scope.workspaceGeneration !== workspace.workspaceGeneration || !current.scope || !sameScope(result.scope, current.scope)
        || result.header.serverEpoch !== result.scope.serverEpoch || result.header.workspaceId !== result.scope.workspaceId
        || result.header.workspaceGeneration !== result.scope.workspaceGeneration || result.header.sessionId !== result.scope.sessionId
        || (result.header.selectionRevision ?? null) !== result.scope.selectionRevision) throw new Error('Remote host or workspace changed.');
      this.selected = workspace; this.boundScope = result.scope; this.snapshot = { header: result.header, items: result.items };
      return this.snapshot;
    } finally { this.reading--; }
  }
  async readMonitor(workspace: WebWorkspace, input: MonitorReadInput) {
    return this.read(workspace, async (scope) => {
      const result = await this.bridge.remoteReadMonitor(scope, input);
      if (!sameScope(result.scope, scope)) throw new Error('Monitor host changed.');
      return { scope: workspace, dashboard: result.dashboard };
    });
  }
  readGoal(workspace: WebWorkspace) { return this.read(workspace, (scope) => this.bridge.remoteReadGoal(scope)); }
  readTasks(workspace: WebWorkspace) { return this.read(workspace, (scope) => this.bridge.remoteReadTasks(scope)); }
  readGitStatus(workspace: WebWorkspace) { return this.read(workspace, (scope) => this.bridge.remoteReadGitStatus(scope)); }
  readGitHistory(workspace: WebWorkspace) { return this.read(workspace, (scope) => this.bridge.remoteReadGitHistory(scope)); }
  readHistory(workspace: WebWorkspace, pageId?: string) { return this.read(workspace, (scope) => this.bridge.remoteReadHistory(scope, pageId)); }
  readSessions(workspace: WebWorkspace, query = '') { return this.read(workspace, (scope) => this.bridge.remoteReadSessions(scope, query)); }
  readModels(workspace: WebWorkspace) { return this.read(workspace, (scope) => this.bridge.remoteReadModels(scope)); }
  readQueue(workspace: WebWorkspace) { return this.read(workspace, (scope) => this.bridge.remoteReadQueue(scope)); }
  readTeams(workspace: WebWorkspace) { return this.read(workspace, (scope) => this.bridge.remoteReadTeams(scope)); }
  readAgents(workspace: WebWorkspace) { return this.read(workspace, (scope) => this.bridge.remoteReadAgents(scope)); }
  readGitDiff(workspace: WebWorkspace, path: string) { return this.read(workspace, (scope) => this.bridge.remoteReadGitDiff(scope, path)); }
  readGitCombinedDiff(workspace: WebWorkspace) { return this.read(workspace, (scope) => this.bridge.remoteReadGitCombinedDiff(scope)); }
  readGitCommitDetails(workspace: WebWorkspace, hash: string) { return this.read(workspace, (scope) => this.bridge.remoteReadGitCommitDetails(scope, hash)); }
  readMonitorDetail(workspace: WebWorkspace, id: string) { return this.read(workspace, (scope) => this.bridge.remoteReadMonitorDetail(scope, id)); }
  uploadText(workspace: WebWorkspace, input: { name: string; text: string }) { return this.read(workspace, (scope) => this.bridge.remoteUploadText(scope, input)); }
  cancelTextAttachment(workspace: WebWorkspace, id: string) { return this.read(workspace, (scope) => this.bridge.remoteCancelText(scope, id)); }
  listFiles(workspace: WebWorkspace, directoryId: string | null) { return this.read(workspace, (scope) => this.bridge.remoteListFiles(scope, directoryId)); }
  previewText(workspace: WebWorkspace, fileId: string) { return this.read(workspace, (scope) => this.bridge.remotePreviewText(scope, fileId)); }
  private async controlRead<T>(workspace: WebWorkspace, operation: (scope: RemoteScope) => Promise<T>): Promise<T> {
    const scope = this.scope(workspace), lifecycle = this.lifecycle, result = await operation(scope), current = this.state?.scope;
    const refreshingSameBinding = current && this.reading > 0 && current.sessionId === null && current.selectionRevision === null
      && sameScope({ ...current, sessionId: scope.sessionId, selectionRevision: scope.selectionRevision }, scope);
    if (lifecycle !== this.lifecycle || !this.isConnected || !this.boundScope || !sameScope(scope, this.boundScope)
      || !current || !sameScope(scope, current) && !refreshingSameBinding) throw new Error('Remote control scope changed. Refresh the workspace.');
    return result;
  }
  claimControl(workspace: WebWorkspace) { return this.controlRead(workspace, (scope) => this.bridge.remoteClaimControl(scope)); }
  renewControl(workspace: WebWorkspace) { return this.controlRead(workspace, (scope) => this.bridge.remoteRenewControl(scope)); }
  takeOverControl(workspace: WebWorkspace) { return this.controlRead(workspace, (scope) => this.bridge.remoteTakeOverControl(scope)); }
  releaseControl(workspace: WebWorkspace) { return this.controlRead(workspace, (scope) => this.bridge.remoteReleaseControl(scope)); }
  async requestPermissionApproval(workspace: WebWorkspace, input: InputOf<'permission.issue'>): Promise<WireResultOf<'permission.issue'>> {
    const value = methodCatalog['permission.issue'].inputSchema.parse(input), header = this.snapshot?.header;
    if (!header || value.sessionId !== header.sessionId || value.oldLevel !== header.controls.permissionLevel) {
      throw new Error('Permission session changed. Refresh the workspace.');
    }
    const challenge = await this.read(workspace, (scope) => this.bridge.remoteIssuePermission(scope, value.newLevel));
    if (challenge.sessionId !== value.sessionId || challenge.oldLevel !== value.oldLevel || challenge.newLevel !== value.newLevel) throw new Error('Permission challenge changed.');
    this.approvals.set(challenge.challengeId, challenge); return challenge;
  }
  async respondPermissionApproval(workspace: WebWorkspace, input: InputOf<'permission.confirm'>): Promise<WireResultOf<'permission.confirm'>> {
    const value = methodCatalog['permission.confirm'].inputSchema.parse(input), challenge = this.approvals.get(value.challengeId), header = this.snapshot?.header;
    if (!challenge || !header || value.sessionId !== header.sessionId || value.oldLevel !== header.controls.permissionLevel
      || challenge.sessionId !== value.sessionId || challenge.oldLevel !== value.oldLevel || challenge.newLevel !== value.newLevel) {
      throw new Error('Permission challenge changed. Request a new approval.');
    }
    const scope = this.scope(workspace), lifecycle = this.lifecycle; this.approvals.delete(value.challengeId);
    const outcome = await this.bridge.remoteConfirmPermission(scope, value.challengeId);
    return methodCatalog['permission.confirm'].wireResultSchema.parse(this.mutationResponse(outcome, 'permission.confirm', scope, lifecycle).result);
  }
  private mutationResponse(outcome: RemoteMutation, method: MutationMethodName | 'permission.confirm', scope: RemoteScope, lifecycle: number) {
    if (outcome.status === 'not-started') throw new Error(`Command ${outcome.requestId} was not started. Keep your draft.`);
    if (outcome.status === 'outcome_unknown' || lifecycle !== this.lifecycle || !this.isConnected || !this.boundScope || !sameScope(scope, this.boundScope)) {
      throw new UnconfirmedCommand(outcome.requestId, outcome.response);
    }
    if (!outcome.response?.ok || outcome.response.method !== method) {
      throw new Error(outcome.response && !outcome.response.ok ? outcome.response.error.code : 'The command was not started.');
    }
    if (outcome.response.requestId !== outcome.requestId) throw new UnconfirmedCommand(outcome.requestId, outcome.response);
    return outcome.response;
  }
  private async operation(workspace: WebWorkspace, operation: RemoteOperation) {
    const scope = this.scope(workspace), lifecycle = this.lifecycle, outcome = await this.bridge.remoteApplyOperation(scope, operation);
    const receipt = operationReceiptSchema.parse(this.mutationResponse(outcome, operation.method, scope, lifecycle).result);
    if (receipt.operation !== operation.method) throw new UnconfirmedCommand(outcome.requestId, outcome.response);
    return receipt;
  }
  createSession(workspace: WebWorkspace) { return this.operation(workspace, { method: 'session.create', input: {} }); }
  setModel(workspace: WebWorkspace, provider: string, id: string) { return this.operation(workspace, { method: 'runtime.setModel', input: { provider, id } }); }
  setThinking(workspace: WebWorkspace, level: InputOf<'runtime.setThinking'>['level']) { return this.operation(workspace, { method: 'runtime.setThinking', input: { level } }); }
  mutateQueue(workspace: WebWorkspace, input: InputOf<'runtime.queue'>) { return this.operation(workspace, { method: 'runtime.queue', input }); }
  createGoal(workspace: WebWorkspace, input: WebInput<'goal.create'>) {
    return this.operation(workspace, { method: 'goal.create', input: methodCatalog['goal.create'].inputSchema.parse(input) });
  }
  controlGoal(workspace: WebWorkspace, input: InputOf<'goal.control'>) { return this.operation(workspace, { method: 'goal.control', input }); }
  updateGoal(workspace: WebWorkspace, input: InputOf<'goal.update'>) { return this.operation(workspace, { method: 'goal.update', input }); }
  clearGoal(workspace: WebWorkspace) { return this.operation(workspace, { method: 'goal.clear', input: {} }); }
  editGoalSteering(workspace: WebWorkspace, input: InputOf<'goal.editSteering'>) { return this.operation(workspace, { method: 'goal.editSteering', input }); }
  removeGoalSteering(workspace: WebWorkspace, input: InputOf<'goal.removeSteering'>) { return this.operation(workspace, { method: 'goal.removeSteering', input }); }
  createTask(workspace: WebWorkspace, input: WebInput<'task.create'>) {
    return this.operation(workspace, { method: 'task.create', input: methodCatalog['task.create'].inputSchema.parse(input) });
  }
  updateTask(workspace: WebWorkspace, input: InputOf<'task.update'>) { return this.operation(workspace, { method: 'task.update', input }); }
  reorderTasks(workspace: WebWorkspace, input: InputOf<'task.reorder'>) { return this.operation(workspace, { method: 'task.reorder', input }); }
  deleteTask(workspace: WebWorkspace, input: InputOf<'task.delete'>) { return this.operation(workspace, { method: 'task.delete', input }); }
  clearTasks(workspace: WebWorkspace) { return this.operation(workspace, { method: 'task.clear', input: {} }); }
  controlAgent(workspace: WebWorkspace, input: InputOf<'agent.control'>) { return this.operation(workspace, { method: 'agent.control', input }); }
  controlTeam(workspace: WebWorkspace, input: InputOf<'team.control'>) { return this.operation(workspace, { method: 'team.control', input }); }
  agentWorkspace(workspace: WebWorkspace, input: InputOf<'agent.workspace'>) { return this.operation(workspace, { method: 'agent.workspace', input }); }
  async sendPrompt(workspace: WebWorkspace, text: string, options: RemotePromptOptions = {}): Promise<WireResultOf<'runtime.prompt'>> {
    const scope = this.scope(workspace), lifecycle = this.lifecycle, outcome = await this.bridge.remoteSendPrompt(scope, text, options);
    return methodCatalog['runtime.prompt'].wireResultSchema.parse(this.mutationResponse(outcome, 'runtime.prompt', scope, lifecycle).result);
  }
  async abort(workspace: WebWorkspace): Promise<WireResultOf<'runtime.abort'>> {
    const scope = this.scope(workspace), lifecycle = this.lifecycle, outcome = await this.bridge.remoteAbort(scope);
    return methodCatalog['runtime.abort'].wireResultSchema.parse(this.mutationResponse(outcome, 'runtime.abort', scope, lifecycle).result);
  }
  async selectSession(workspace: WebWorkspace, sessionId: string): Promise<WireResultOf<'session.select'>> {
    const scope = this.scope(workspace), lifecycle = this.lifecycle, outcome = await this.bridge.remoteSelectSession(scope, sessionId);
    return methodCatalog['session.select'].wireResultSchema.parse(this.mutationResponse(outcome, 'session.select', scope, lifecycle).result);
  }
  reviewPromptStatus(workspace: WebWorkspace, requestId: string) {
    return this.read(workspace, (scope) => this.bridge.remoteReviewCommand(scope, requestId));
  }
  /** Main persists original IDs before sending; a renderer tab never stores a secret or request body. */
  assertPendingReviewStorageAvailable(): void {
    if (this.state?.outcomeStorage !== 'ready') throw new Error('Safe main-owned command recovery storage is unavailable. Prompt was not sent.');
  }
  rememberPendingPromptReview(workspace: WebWorkspace, sessionId: string, requestId: string, method: PendingCommandMethod = 'runtime.prompt'): void {
    if (!this.state?.pending.some((item) => item.requestId === requestId && item.sessionId === sessionId && item.method === method
      && item.scope.workspaceId === workspace.workspaceId && item.scope.workspaceGeneration === workspace.workspaceGeneration
      && item.scope.profileId === this.state?.profile?.id && item.scope.hostId === this.state?.profile?.hostId)) {
      throw new Error('Original command identity is unavailable. Do not resend.');
    }
  }
  pendingPromptReview(workspace: WebWorkspace, sessionId: string): PendingPromptReviewLookup {
    if (this.state?.outcomeStorage !== 'ready') return { kind: 'blocked', reason: 'unavailable' };
    const pending = this.state.pending.find((item) => !this.dismissed.has(item.requestId)
      && ['sending', 'outcome_unknown'].includes(item.status) && item.scope.profileId === this.state?.profile?.id
      && item.scope.hostId === this.state?.profile?.hostId && item.scope.workspaceId === workspace.workspaceId
      && item.scope.workspaceGeneration === workspace.workspaceGeneration);
    if (!pending) return { kind: 'none' };
    const value: PendingPromptReview = { version: 1, origin: this.origin, authSessionId: this.authenticatedSessionId,
      hostId: pending.scope.hostId, method: pending.method, workspaceId: pending.scope.workspaceId,
      workspaceGeneration: pending.scope.workspaceGeneration, sessionId: pending.sessionId,
      serverEpoch: pending.scope.serverEpoch, requestId: pending.requestId };
    return pending.sessionId !== sessionId ? { kind: 'blocked', reason: 'mismatch', value } : { kind: 'match', value };
  }
  clearPendingPromptReview(): void {
    for (const item of this.state?.pending ?? []) if (['confirmed', 'not-started'].includes(item.status)) this.dismissed.add(item.requestId);
  }
  /** Disconnect remains REMOTE. Selecting local is a separate explicit connection API action. */
  logout(): Promise<void> { return this.disconnect(); }
  close(): void {
    this.subscriptionRevision++; this.initializeRequest++;
    this.unsubscribe?.(); this.unsubscribe = null; this.listeners.clear(); this.lifecycle++; this.connectionOperation++; this.snapshotRead++; this.stateRevision++;
    this.state = null; this.snapshot = null; this.selected = null; this.boundScope = null; this.approvals.clear();
  }
}
