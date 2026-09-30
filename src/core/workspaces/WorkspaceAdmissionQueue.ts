export interface RuntimeSelectionView { getState(includeMessages: false): { sessionId: string | null } }

export class WorkspaceAdmissionError extends Error {
  constructor(readonly code: 'STALE_WORKSPACE' | 'STALE_SESSION' | 'CONTROL_REQUIRED' | 'PERMISSION_REQUIRED' | 'STORAGE_UNAVAILABLE') {
    super(code);
  }
}

export interface SessionAdmission {
  readonly workspaceGeneration: number;
  readonly expectedSessionId: string | null;
  readonly selectionRevision: number;
  readonly controlGeneration: number;
}
export interface AdmissionAuthority {
  readonly controlGeneration: number | null;
  readonly permission: boolean;
  readonly currentGeneration: number;
  readonly principalId?: string;
}

export interface WorkspaceAdmissionPort<Runtime extends RuntimeSelectionView> {
  readonly pending: number;
  seal(): void;
  settled(): Promise<void>;
  observeSelection(sessionId: string | null): void;
  snapshot(): { selectedSessionId: string | null; selectionRevision: number };
  assertCurrent(command: SessionAdmission, authorize: () => AdmissionAuthority, allowStop?: boolean): { runtime: Runtime; sessionId: string | null };
  run<T>(command: SessionAdmission, authorize: () => AdmissionAuthority,
    perform: (captured: { runtime: Runtime; sessionId: string | null }) => T | Promise<T>, select?: boolean, allowStop?: boolean): Promise<T>;
}

/** Short per-workspace lane. A queued operation never changes its selected target. */
export class WorkspaceAdmissionQueue<Runtime extends RuntimeSelectionView = RuntimeSelectionView> implements WorkspaceAdmissionPort<Runtime> {
  private tail: Promise<void> = Promise.resolve();
  private outstanding = 0;
  private sealed = false;
  private selected: string | null;
  private revision = 0;

  constructor(private readonly runtime: Runtime, private readonly generation: number,
    private readonly assertStorageAdmission: (sessionId: string | null, principalId?: string) => void = () => undefined) {
    this.selected = runtime.getState(false).sessionId;
  }

  get pending(): number { return this.outstanding; }
  /** Close the lane before any asynchronous teardown. A failed close stays fenced. */
  seal(): void { this.sealed = true; }
  /** Existing admitted operations keep ownership until they actually finish. */
  settled(): Promise<void> { return this.tail; }

  /** Reconcile local desktop changes until T19 puts local selection in this lane too. */
  observeSelection(sessionId: string | null): void {
    if (sessionId !== this.selected) { this.selected = sessionId; this.revision += 1; }
  }

  snapshot(): { selectedSessionId: string | null; selectionRevision: number } {
    this.observeSelection(this.runtime.getState(false).sessionId);
    return { selectedSessionId: this.selected, selectionRevision: this.revision };
  }

  /** Also call immediately after awaited preparation, before invoking a runtime method. */
  assertCurrent(command: SessionAdmission, authorize: () => AdmissionAuthority, allowStop = false): { runtime: Runtime; sessionId: string | null } {
    if (this.sealed) throw new WorkspaceAdmissionError('STALE_WORKSPACE');
    const scope = authorize();
    if (!allowStop) this.assertStorageAdmission(command.expectedSessionId, scope.principalId);
    if (command.workspaceGeneration !== this.generation || scope.currentGeneration !== this.generation) throw new WorkspaceAdmissionError('STALE_WORKSPACE');
    if (scope.controlGeneration === null || !Number.isSafeInteger(command.controlGeneration) || command.controlGeneration !== scope.controlGeneration) throw new WorkspaceAdmissionError('CONTROL_REQUIRED');
    if (!scope.permission) throw new WorkspaceAdmissionError('PERMISSION_REQUIRED');
    const current = this.snapshot();
    if (current.selectedSessionId !== command.expectedSessionId || current.selectionRevision !== command.selectionRevision) throw new WorkspaceAdmissionError('STALE_SESSION');
    return { runtime: this.runtime, sessionId: current.selectedSessionId };
  }

  /** Authorization is checked at the queue head, not when the request was enqueued. */
  run<T>(command: SessionAdmission, authorize: () => AdmissionAuthority,
    perform: (captured: { runtime: Runtime; sessionId: string | null }) => T | Promise<T>,
    select = false, allowStop = false): Promise<T> {
    if (!allowStop) {
      try { this.assertStorageAdmission(command.expectedSessionId, authorize().principalId); }
      catch (error) { return Promise.reject(error); }
    }
    if (this.sealed) return Promise.reject(new WorkspaceAdmissionError('STALE_WORKSPACE'));
    this.outstanding += 1;
    const execute = async (): Promise<T> => {
      const captured = this.assertCurrent(command, authorize, allowStop);
      const result = await perform(captured);
      if (select) this.snapshot();
      return result;
    };
    const result = this.tail.then(execute);
    this.tail = result.then(() => undefined, () => undefined);
    void result.finally(() => { this.outstanding -= 1; }).catch(() => undefined);
    return result;
  }
}
