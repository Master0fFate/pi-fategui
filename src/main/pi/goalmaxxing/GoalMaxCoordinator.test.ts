import { describe, expect, it, vi } from 'vitest';
import type { GoalMaxEvent } from '../../../shared/contracts/goalmaxxing';
import { GoalMaxCoordinator, type GoalMaxCoordinatorHost, type GoalMaxRuntimeSnapshot } from './GoalMaxCoordinator';
import { InMemoryGoalMaxRepository } from './GoalMaxRepository';

function fixture() {
  const events: GoalMaxEvent[] = [];
  const runtime: GoalMaxRuntimeSnapshot = {
    projectPath: '/project', sessionId: 'session-1', projectTrusted: true, permissionLevel: 'edit',
    idle: true, streaming: false, queuedUserMessages: 0, tokensUsed: 100, activeChildren: 0, children: [],
  };
  const host: GoalMaxCoordinatorHost = {
    runtime: vi.fn((sessionId) => !sessionId || sessionId === runtime.sessionId ? { ...runtime } : null),
    startGoal: vi.fn(async () => true),
    continueGoal: vi.fn(async () => undefined),
    steerGoal: vi.fn(async () => undefined),
    abortGoal: vi.fn(async () => undefined),
    verifyGoal: vi.fn(async () => ({ verdict: 'pass' as const, report: 'VERDICT: pass\nFINDINGS:\n- note — all — current repository — none\nUNCERTAINTY: none', nodeId: 'verifier-1' })),
    diagnoseGoal: vi.fn(async () => ({ report: 'DIAGNOSIS: repeated planning\nNEXT_ACTION: edit the implementation\nRISK: none', nodeId: 'diagnostic-1' })),
    persistSessionEvent: vi.fn(),
    emit: vi.fn((event) => { events.push(event); }),
  };
  const repository = new InMemoryGoalMaxRepository();
  const progress = { capture: vi.fn(async () => ({ fingerprint: 'baseline', changedFileCount: 0, paths: [] as string[], repository: true })) };
  const coordinator = new GoalMaxCoordinator(host, repository, progress as never);
  return { coordinator, host, runtime, repository, events, progress };
}

describe('GoalMax coordinator', () => {
  it('persists before starting and schedules exactly one evidence-backed continuation after settle', async () => {
    const { coordinator, host, runtime, repository } = fixture();
    const goal = await coordinator.create({ objective: 'Implement and test the control plane', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    expect(await repository.load('/project', 'session-1')).toMatchObject({ id: goal.id, revision: 1 });
    expect(host.startGoal).toHaveBeenCalledWith('session-1', goal.objective, expect.stringContaining('GOALMAX OBJECTIVE · ACTIVE'));

    runtime.idle = false; runtime.streaming = true;
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'edit-1', toolName: 'edit', args: { path: 'src/app.ts' } } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: 'edit-1', toolName: 'edit', result: { content: [{ type: 'text', text: 'done' }] }, isError: false } as never);
    runtime.idle = true; runtime.streaming = false; runtime.tokensUsed = 250;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(() => expect(host.continueGoal).toHaveBeenCalledOnce());
    const current = await repository.load('/project', 'session-1');
    expect(current).toMatchObject({ status: 'active', executionState: 'running-root', tokensUsed: 150 });
    expect(current?.evidence.some((evidence) => evidence.kind === 'file' && evidence.path === 'src/app.ts')).toBe(true);
    expect(current?.progress.meaningfulTurnCount).toBe(1);
  });

  it('recovers an interrupted run as idle and reconciles workspace evidence after rebind', async () => {
    const { coordinator, host, repository, progress } = fixture();
    const created = await coordinator.create({ objective: 'Recover after restart', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    await vi.waitFor(async () => expect((await repository.load('/project', 'session-1'))?.executionState).toBe('running-root'));
    await coordinator.dispose();
    progress.capture.mockResolvedValue({ fingerprint: 'after-restart', changedFileCount: 1, paths: ['src/recovered.ts'], repository: true });
    const restoredCoordinator = new GoalMaxCoordinator(host, repository, progress as never);

    const restored = await restoredCoordinator.bind('/project', 'session-1');

    expect(restored).toMatchObject({ id: created.id, status: 'active', executionState: 'idle', progress: { latestWorkspaceFingerprint: 'after-restart' } });
    expect(restored?.evidence.at(-1)).toMatchObject({ kind: 'git-diff', current: true });
    await vi.waitFor(() => expect(host.continueGoal).toHaveBeenCalledOnce());
    await restoredCoordinator.dispose();
  });

  it('pauses future continuations without aborting the active root turn', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Keep working', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    runtime.streaming = true; runtime.idle = false;
    await coordinator.control({ action: 'pause', reason: 'Reviewing' });
    runtime.streaming = false; runtime.idle = true;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.abortGoal).not.toHaveBeenCalled();
    expect(host.continueGoal).not.toHaveBeenCalled();
    expect((await coordinator.statusForModel('session-1')).details.status).toBe('paused');
  });

  it('keeps a successful verification command current when it ran after the latest edit', async () => {
    const { coordinator, host, runtime, progress } = fixture();
    await coordinator.create({ objective: 'Edit then test the result', verificationLevel: 'strict', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    progress.capture.mockResolvedValue({ fingerprint: 'changed', changedFileCount: 1, paths: ['src/app.ts'], repository: true });
    runtime.idle = false; runtime.streaming = true;
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'edit-1', toolName: 'edit', args: { path: 'src/app.ts' } } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: 'edit-1', toolName: 'edit', result: 'done', isError: false } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'test-1', toolName: 'bash', args: { command: 'pnpm test' } } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: 'test-1', toolName: 'bash', result: 'passed', isError: false } as never);
    const evidenceState = (await coordinator.statusForModel('session-1')).details;
    const testEvidence = evidenceState.evidence.find((item) => item.kind === 'test')!;
    const completion = await coordinator.requestCompletion('session-1', {
      summary: 'Implementation and tests are ready',
      criterionEvidence: evidenceState.criteria.filter((criterion) => criterion.required).map((criterion) => ({ criterionId: criterion.id, evidenceIds: [testEvidence.id] })),
    });
    expect(completion).toMatchObject({ details: { status: 'verifying', phase: 'verification', executionState: 'waiting' } });
    expect(completion.text).toContain('end the current root turn');
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('completed'));
    expect(host.verifyGoal).toHaveBeenCalledOnce();
    expect((await coordinator.statusForModel('session-1')).details.evidence.find((item) => item.kind === 'test')).toMatchObject({ current: true, exitCode: 0 });
  });

  it('requires the verification gate before completion', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Produce the requested result', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await coordinator.report('session-1', { outcome: 'completion-candidate', summary: 'Ready for verification' });
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);
    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('completed'));
    expect(host.verifyGoal).toHaveBeenCalledOnce();
    const completed = (await coordinator.statusForModel('session-1')).details;
    expect(completed.criteria.filter((criterion) => criterion.required).every((criterion) => criterion.status === 'satisfied')).toBe(true);
    expect(completed.evidence.at(-1)).toMatchObject({ kind: 'verification', current: true });
    expect(completed.timeline.slice(-2).map((event) => event.type)).toEqual(['verification.passed', 'goal.completed']);
    await expect(coordinator.requestCompletion('session-1', { summary: 'Already done' })).resolves.toMatchObject({
      text: expect.stringContaining('already completed'),
      details: { status: 'completed' },
    });
    expect(host.verifyGoal).toHaveBeenCalledOnce();
  });

  it('targets the selected runtime instead of the first bound background goal', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Background goal', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    const selected = { ...runtime, sessionId: 'session-2' };
    vi.mocked(host.runtime).mockImplementation((sessionId) => !sessionId || sessionId === selected.sessionId
      ? { ...selected }
      : sessionId === runtime.sessionId ? { ...runtime } : null);

    const goal = await coordinator.create({ objective: 'Selected goal', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });

    expect(goal.sessionId).toBe('session-2');
    expect(host.startGoal).toHaveBeenLastCalledWith('session-2', goal.objective, expect.any(String));
  });

  it('waits for active children before starting independent verification', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Verify only after delegated work settles', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    const child = {
      nodeId: 'child-verify', label: 'Implementation', objective: 'Finish the delegated work', status: 'running' as const,
      permissionLevel: 'edit' as const, requestedModel: null, effectiveModel: null,
      requestedThinking: null, effectiveThinking: null, startedAt: Date.now(), endedAt: null,
      result: null, error: null, observations: [],
    };
    runtime.activeChildren = 1; runtime.children = [child];
    coordinator.syncChildren('session-1', [child]);
    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.executionState).toBe('running-children'));

    await coordinator.control({ action: 'verify' });
    expect(host.verifyGoal).not.toHaveBeenCalled();
    runtime.activeChildren = 0; runtime.children = [];
    coordinator.syncChildren('session-1', [{ ...child, status: 'completed', endedAt: Date.now() }]);

    await vi.waitFor(() => expect(host.verifyGoal).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('completed'));
  });

  it('returns a child-held execution lease to idle and resumes when children settle', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Finish after delegated research', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    runtime.activeChildren = 1;
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);
    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.executionState).toBe('running-children'));

    const child = {
      nodeId: 'child-1', label: 'Research', objective: 'Inspect the implementation', status: 'running' as const,
      permissionLevel: 'read-only' as const, requestedModel: null, effectiveModel: null,
      requestedThinking: null, effectiveThinking: null, startedAt: Date.now(), endedAt: null,
      result: null, error: null, observations: [],
    };
    coordinator.syncChildren('session-1', [child]);
    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.childAssignments).toHaveLength(1));
    runtime.activeChildren = 0;
    coordinator.syncChildren('session-1', [{ ...child, status: 'completed', endedAt: Date.now() }]);

    await vi.waitFor(() => expect(host.continueGoal).toHaveBeenCalledOnce());
  });

  it('keeps failed tool evidence current until the same operation succeeds', async () => {
    const { coordinator } = fixture();
    await coordinator.create({ objective: 'Run the verification command', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    const observe = (id: string, isError: boolean) => {
      coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: 'pnpm test' } } as never);
      coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: id, toolName: 'bash', result: isError ? 'failed' : 'passed', isError } as never);
    };
    observe('test-1', true);
    let state = (await coordinator.statusForModel('session-1')).details;
    expect(state.evidence.at(-1)).toMatchObject({ kind: 'test', exitCode: 1, current: true });

    observe('test-2', false);
    state = (await coordinator.statusForModel('session-1')).details;
    expect(state.evidence.filter((item) => item.command === 'pnpm test').map((item) => item.current)).toEqual([false, true]);
  });

  it('keeps exploratory command failures visible without blocking the completion gate', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Debug and verify the runtime', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    runtime.idle = false; runtime.streaming = true;
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'probe-1', toolName: 'bash', args: { command: 'rg missing-symbol src' } } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: 'probe-1', toolName: 'bash', result: 'no matches', isError: true } as never);
    await coordinator.report('session-1', { outcome: 'completion-candidate', summary: 'The debug pass is complete.' });
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('completed'));
    expect(host.verifyGoal).toHaveBeenCalledOnce();
    expect((await coordinator.statusForModel('session-1')).details.evidence)
      .toContainEqual(expect.objectContaining({ kind: 'command', exitCode: 1, current: true }));
  });

  it('scrubs credential-shaped diagnostics restored from an older snapshot', async () => {
    const { coordinator, host, repository, progress } = fixture();
    await coordinator.create({ objective: 'Restore diagnostics safely', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    const saved = (await repository.load('/project', 'session-1'))!;
    const rawSecret = 'sk-restore-example-123456789012';
    await repository.save({
      ...saved,
      revision: saved.revision + 1,
      evidence: [{
        id: 'evidence-legacy-secret', kind: 'command', title: `Passed command: --api-key ${rawSecret}`,
        summary: `INFERENCE_API_KEY  ${rawSecret}`, criterionIds: [], source: 'root-tool', timestamp: Date.now(),
        current: true, command: `tool --api-key ${rawSecret}`, exitCode: 0,
      }],
      updatedAt: Date.now(),
    }, saved.revision);
    await coordinator.dispose();
    const restored = new GoalMaxCoordinator(host, repository, progress as never);

    const rebound = await restored.bind('/project', 'session-1');

    expect(JSON.stringify(rebound)).not.toContain(rawSecret);
    expect(JSON.stringify(await repository.load('/project', 'session-1'))).not.toContain(rawSecret);
    expect(rebound?.timeline.at(-1)?.summary).toContain('redacted during restore');
    await restored.dispose();
  });

  it('redacts credential-shaped diagnostic evidence before persistence and events', async () => {
    const { coordinator, repository, events } = fixture();
    await coordinator.create({ objective: 'Inspect diagnostics safely', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    const command = 'curl -H "Authorization: Bearer bearer-example-123456" --api-key "sk-example-123456789012" https://example.test';
    const output = [
      'INFERENCE_API_KEY  sk-environment-123456789012',
      'PASSWORD=correct-horse-battery-staple',
      'credential redacted',
    ].join('\n');
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'secret-1', toolName: 'bash', args: { command } } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: 'secret-1', toolName: 'bash', result: output, isError: false } as never);

    await coordinator.statusForModel('session-1');
    await coordinator.control({ action: 'checkpoint' });
    const firstPass = (await repository.load('/project', 'session-1'))!.evidence.find((item) => item.command?.includes('curl'))!;
    await coordinator.control({ action: 'checkpoint' });
    const secondPass = (await repository.load('/project', 'session-1'))!.evidence.find((item) => item.id === firstPass.id)!;

    expect({ title: secondPass.title, summary: secondPass.summary, command: secondPass.command })
      .toEqual({ title: firstPass.title, summary: firstPass.summary, command: firstPass.command });
    const persisted = JSON.stringify(await repository.load('/project', 'session-1'));
    const emitted = JSON.stringify(events);
    for (const secret of ['bearer-example-123456', 'sk-example-123456789012', 'sk-environment-123456789012', 'correct-horse-battery-staple']) {
      expect(persisted).not.toContain(secret);
      expect(emitted).not.toContain(secret);
    }
    expect(persisted).toContain('<redacted>');
    expect(persisted).not.toContain('[credential redacted]');
    expect(persisted).not.toMatch(/\[(?:credential )?redacted\]|<redacted>\]+/u);
  });

  it('preserves provider exhaustion as a resumable usage-limited state', async () => {
    const { coordinator, host, runtime } = fixture();
    const usageError = Object.assign(new Error('Provider quota exhausted'), { code: 'USAGE_LIMITED' });
    vi.mocked(host.continueGoal).mockRejectedValueOnce(usageError);
    await coordinator.create({ objective: 'Continue until provider availability returns', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('usage-limited'));
    expect((await coordinator.statusForModel('session-1')).details.blockedReason).toContain('quota exhausted');
  });

  it('returns an edited verification candidate to an idle active state', async () => {
    const { coordinator } = fixture();
    await coordinator.create({ objective: 'Original completion candidate', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    const candidate = (await coordinator.report('session-1', { outcome: 'completion-candidate', summary: 'Ready' })).details;
    expect(candidate).toMatchObject({ status: 'verifying', executionState: 'waiting' });

    const edited = await coordinator.update({ expectedRevision: candidate.revision, objective: 'Revised completion candidate' });

    expect(edited).toMatchObject({ status: 'active', executionState: 'idle', objective: 'Revised completion candidate' });
  });

  it('blocks instead of leaving the goal in process when root settlement fails', async () => {
    const { coordinator, host, progress } = fixture();
    await coordinator.create({ objective: 'Settle the final root turn safely', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    progress.capture.mockRejectedValueOnce(new Error('workspace snapshot unavailable'));
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.executionState).toBe('running-root'));
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('blocked'));
    const state = (await coordinator.statusForModel('session-1')).details;
    expect(state).toMatchObject({
      executionState: 'idle',
      failure: { code: 'GOALMAX_SETTLEMENT_FAILED', retryable: true },
    });
    expect(state.blockedReason).toContain('workspace snapshot unavailable');
    expect(host.continueGoal).not.toHaveBeenCalled();
  });

  it('fails closed in memory when settlement recovery cannot be persisted', async () => {
    const { coordinator, host, progress, repository } = fixture();
    await coordinator.create({ objective: 'Stop safely when durable settlement fails', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    await vi.waitFor(async () => expect((await repository.load('/project', 'session-1'))?.executionState).toBe('running-root'));
    progress.capture.mockRejectedValueOnce(new Error('workspace snapshot unavailable'));
    const save = vi.spyOn(repository, 'save').mockRejectedValue(new Error('goal storage is read-only'));

    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(() => expect(coordinator.get('/project', 'session-1')?.status).toBe('blocked'));
    const visible = coordinator.get('/project', 'session-1')!;
    expect(visible).toMatchObject({
      status: 'blocked',
      executionState: 'idle',
      failure: { code: 'GOALMAX_SETTLEMENT_FAILED', retryable: true },
    });
    expect(visible.blockedReason).toContain('goal storage is read-only');
    expect(coordinator.hasRunnableGoal('session-1')).toBe(false);
    expect(host.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'goalmax.snapshot', goal: expect.objectContaining({ status: 'blocked' }) }));
    expect(host.continueGoal).not.toHaveBeenCalled();

    save.mockRestore();
    await expect(coordinator.control({ action: 'checkpoint' })).resolves.toMatchObject({ status: 'blocked' });
    expect(coordinator.hasRunnableGoal('session-1')).toBe(false);
    await coordinator.control({ action: 'resume' });
    expect(coordinator.get('/project', 'session-1')).toMatchObject({ status: 'active', failure: null });
    expect(coordinator.hasRunnableGoal('session-1')).toBe(true);
  });

  it('blocks cleanly without root continuation spam when the independent verifier is unavailable', async () => {
    const { coordinator, host, runtime } = fixture();
    vi.mocked(host.verifyGoal).mockRejectedValueOnce(new Error(`verifier unavailable ${'x'.repeat(5_000)}`));
    await coordinator.create({ objective: 'Require independent evidence', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await coordinator.report('session-1', { outcome: 'completion-candidate', summary: 'Ready for verification' });
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('blocked'));
    const state = (await coordinator.statusForModel('session-1')).details;
    expect(state).toMatchObject({ phase: 'verification', executionState: 'idle' });
    expect(state.blockedReason).toMatch(/^Independent verifier unavailable: verifier unavailable/u);
    expect(state.blockedReason).toHaveLength(4_000);
    expect(state.evidence.at(-1)).toMatchObject({ kind: 'verification', current: true, title: 'Completion gate failed' });
    expect(state.criteria.some((criterion) => criterion.title.includes('Independent verifier unavailable'))).toBe(false);
    expect(host.continueGoal).not.toHaveBeenCalled();
  });

  it('turns a verifier timeout into one actionable blocker instead of no-progress continuations', async () => {
    const { coordinator, host, runtime } = fixture();
    vi.mocked(host.verifyGoal).mockResolvedValueOnce({
      verdict: 'fail',
      report: 'VERDICT: fail\nFINDINGS:\n- major — verification — verifier timed out — retry verification',
      nodeId: 'verifier-timeout',
      infrastructureFailure: 'timeout',
    });
    await coordinator.create({ objective: 'Bound independent verification', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await coordinator.report('session-1', { outcome: 'completion-candidate', summary: 'Ready for bounded verification' });
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('blocked'));
    const state = (await coordinator.statusForModel('session-1')).details;
    expect(state).toMatchObject({
      phase: 'verification',
      executionState: 'idle',
      blockedReason: 'Independent verifier timed out. Retry verification.',
      progress: { noProgressTurnCount: 1 },
    });
    expect(state.criteria.some((criterion) => criterion.title.includes('verifier timed out'))).toBe(false);
    expect(host.continueGoal).not.toHaveBeenCalled();
  });

  it('bounds long-running evidence and removes references to evicted records', async () => {
    const { coordinator } = fixture();
    await coordinator.create({ objective: 'Sustain a bounded evidence ledger', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    let firstEvidenceId = '';
    let firstCriterionId = '';
    for (let batch = 0; batch < 5; batch += 1) {
      for (let index = 0; index < 64; index += 1) {
        const id = `edit-${batch}-${index}`;
        coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: id, toolName: 'edit', args: { path: `src/file-${batch}-${index}.ts` } } as never);
        coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: id, toolName: 'edit', result: 'done', isError: false } as never);
      }
      const state = (await coordinator.statusForModel('session-1')).details;
      if (batch === 0) {
        firstEvidenceId = state.evidence[0]!.id;
        firstCriterionId = state.criteria[0]!.id;
        await coordinator.report('session-1', {
          outcome: 'progress', summary: 'Linked initial evidence',
          criterionUpdates: [{ criterionId: firstCriterionId, status: 'satisfied', evidenceIds: [firstEvidenceId] }],
        });
      }
    }
    const state = (await coordinator.statusForModel('session-1')).details;
    expect(state.evidence).toHaveLength(256);
    expect(state.evidence.some((item) => item.id === firstEvidenceId)).toBe(false);
    expect(state.criteria.find((criterion) => criterion.id === firstCriterionId)).toMatchObject({ status: 'active', evidenceIds: [] });
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(4 * 1024 * 1024);
  });

  it('clears an archived long-brief reference when the objective becomes concise', async () => {
    const { coordinator } = fixture();
    const longBrief = `Long brief\n\n${'detail '.repeat(2_100)}`;
    const created = await coordinator.create({ objective: longBrief, verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    expect(created.originalBriefRef).not.toBeNull();

    const updated = await coordinator.update({ expectedRevision: created.revision, objective: 'Concise replacement objective' });

    expect(updated).toMatchObject({ objective: 'Concise replacement objective', originalBriefRef: null, originalBriefHash: null });
  });

  it('counts a novel relevant read-only investigation as progress without treating repeated reads as mutations', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Investigate the authentication token refresh lifecycle failure', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    runtime.idle = false; runtime.streaming = true;
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'read-auth', toolName: 'read', args: { path: 'src/auth.ts' } } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: 'read-auth', toolName: 'read', result: 'refreshToken returns before the session write settles', isError: false } as never);
    coordinator.observeSessionEvent('session-1', { type: 'message_end', message: { role: 'assistant', content: 'The authentication token refresh lifecycle failure comes from returning before the refreshed session write settles, so the next request observes stale credentials. The next action is to await that write.' } } as never);
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(() => expect(host.continueGoal).toHaveBeenCalledOnce());
    const state = (await coordinator.statusForModel('session-1')).details;
    expect(state.progress).toMatchObject({ meaningfulTurnCount: 1, noProgressTurnCount: 0, planningOnlyTurnCount: 0 });
    expect(state.evidence).toContainEqual(expect.objectContaining({ kind: 'runtime', path: 'src/auth.ts', current: true }));
  });

  it('persists bounded authoritative user steering for recovery capsules', async () => {
    const { coordinator, repository } = fixture();
    await coordinator.create({ objective: 'Implement the release workflow', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    for (let index = 0; index < 40; index += 1) await coordinator.recordSteering('session-1', `Constraint ${index}: preserve compatibility`, index % 2 ? 'steer' : 'followUp');

    const state = (await coordinator.statusForModel('session-1')).details;
    expect(state.steering).toHaveLength(32);
    expect(state.steering[0]?.text).toContain('Constraint 8');
    expect(state.steering.at(-1)?.text).toContain('Constraint 39');
    expect((await repository.load('/project', 'session-1'))?.steering).toEqual(state.steering);
    expect((await coordinator.statusForModel('session-1')).text).toContain('AUTHORITATIVE USER STEERING');
  });

  it('links child tool evidence to inferred criterion ownership', async () => {
    const { coordinator } = fixture();
    const goal = await coordinator.create({ objective: 'Implement authentication refresh\n- Implement the authentication refresh handler', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    const now = Math.max(Date.now(), goal.createdAt + 1);
    coordinator.syncChildren('session-1', [{
      nodeId: 'child-auth', label: 'Auth implementer', objective: 'Implement the authentication refresh handler', status: 'completed',
      permissionLevel: 'edit', requestedModel: null, effectiveModel: null, requestedThinking: null, effectiveThinking: null,
      startedAt: now, endedAt: now + 10, result: 'Implemented the refresh handler.', error: null,
      observations: [{ key: 'edit-auth', kind: 'file', title: 'Changed src/auth.ts', summary: 'Updated refresh handling.', timestamp: now + 5, meaningful: true, path: 'src/auth.ts', exitCode: 0 }],
    }]);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.childAssignments).toHaveLength(1));
    const state = (await coordinator.statusForModel('session-1')).details;
    const assignment = state.childAssignments[0]!;
    expect(assignment.criterionIds.length).toBeGreaterThan(0);
    expect(assignment.evidenceIds).toHaveLength(1);
    expect(state.evidence.find((item) => item.id === assignment.evidenceIds[0])).toMatchObject({ source: 'child-tool', criterionIds: assignment.criterionIds });
    expect(state.criteria.filter((criterion) => assignment.criterionIds.includes(criterion.id)).every((criterion) => criterion.ownerNodeIds.includes('child-auth') && criterion.evidenceIds.includes(assignment.evidenceIds[0]!))).toBe(true);
  });

  it('does not persist or rerender identical child evidence twice', async () => {
    const { coordinator, host } = fixture();
    const goal = await coordinator.create({ objective: 'Inspect and preserve the runtime boundary', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    const now = Math.max(Date.now(), goal.createdAt + 1);
    const child = {
      nodeId: 'child-stable', label: 'Runtime reviewer', objective: 'Inspect the runtime boundary', status: 'completed' as const,
      permissionLevel: 'read-only' as const, requestedModel: null, effectiveModel: null, requestedThinking: null, effectiveThinking: null,
      startedAt: now, endedAt: now + 5, result: 'Boundary inspected.', error: null,
      observations: [{ key: 'read-runtime-once', kind: 'runtime' as const, title: 'Inspected runtime', summary: 'Confirmed the stable boundary.', timestamp: now + 2, meaningful: true, exitCode: 0 }],
    };

    coordinator.syncChildren('session-1', [child]);
    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.childAssignments).toHaveLength(1));
    const first = (await coordinator.statusForModel('session-1')).details;
    const persistenceCalls = vi.mocked(host.persistSessionEvent).mock.calls.length;

    coordinator.syncChildren('session-1', [child]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = (await coordinator.statusForModel('session-1')).details;

    expect(second.revision).toBe(first.revision);
    expect(second.evidence).toHaveLength(first.evidence.length);
    expect(host.persistSessionEvent).toHaveBeenCalledTimes(persistenceCalls);
  });

  it('ignores a completed child that started before the current goal', async () => {
    const { coordinator } = fixture();
    const goal = await coordinator.create({ objective: 'Do not ingest stale child work', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    coordinator.syncChildren('session-1', [{
      nodeId: 'stale-child', label: 'Old worker', objective: 'Previous goal', status: 'completed', permissionLevel: 'read-only',
      requestedModel: null, effectiveModel: null, requestedThinking: null, effectiveThinking: null,
      startedAt: goal.createdAt - 1_000, endedAt: goal.createdAt + 1_000, result: 'Old result', error: null,
      observations: [{ key: 'old-read', kind: 'runtime', title: 'Old observation', summary: 'Old result', timestamp: goal.createdAt + 500, meaningful: true, exitCode: 0 }],
    }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await coordinator.statusForModel('session-1')).details.childAssignments).toEqual([]);
  });

  it('runs one bounded diagnostic reviewer at the third zero-progress turn', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Escape repeated planning and implement the feature', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    for (let turn = 1; turn <= 3; turn += 1) {
      runtime.idle = false; runtime.streaming = true;
      coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
      coordinator.observeSessionEvent('session-1', { type: 'message_end', message: { role: 'assistant', content: 'I will make another plan before changing anything.' } } as never);
      runtime.idle = true; runtime.streaming = false;
      coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);
      await vi.waitFor(() => expect((host.continueGoal as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(turn));
    }
    await vi.waitFor(() => expect(host.diagnoseGoal).toHaveBeenCalledOnce());
    const state = (await coordinator.statusForModel('session-1')).details;
    expect(state.progress.noProgressTurnCount).toBe(3);
    expect(state.evidence).toContainEqual(expect.objectContaining({ kind: 'subagent', title: 'Diagnostic review completed' }));
  });

  it('enforces strict criterion evidence before invoking the independent verifier', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Strictly verify the release', verificationLevel: 'strict', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await coordinator.report('session-1', { outcome: 'completion-candidate', summary: 'Claimed ready without evidence' });
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('active'));
    expect(host.verifyGoal).not.toHaveBeenCalled();
    expect((await coordinator.statusForModel('session-1')).details.criteria.some((criterion) => criterion.title.startsWith('Attach current non-verifier evidence'))).toBe(true);
  });

  it('re-resolves visible permissions immediately before continuation dispatch', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Continue with current permission policy', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    runtime.idle = false; runtime.streaming = true;
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    runtime.permissionLevel = 'full-access'; runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(() => expect(host.continueGoal).toHaveBeenCalledOnce());
    const state = (await coordinator.statusForModel('session-1')).details;
    expect(state.permission).toMatchObject({ permissionLevel: 'full-access', revision: 2 });
    expect(host.continueGoal).toHaveBeenCalledWith('session-1', expect.stringContaining('permission full-access'), state.id, state.revision);
  });

  it('honors only explicit budgets and resumes after the user extends one', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Finish within an explicit budget', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: 50, timeLimitMs: null });
    runtime.idle = false; runtime.streaming = true;
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    runtime.tokensUsed = 151; runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('budget-limited'));
    const limited = (await coordinator.statusForModel('session-1')).details;
    expect(limited).toMatchObject({ budget: { tokenLimit: 50, source: 'user-explicit' }, blockedReason: 'The explicit user budget was reached.' });
    expect(host.continueGoal).not.toHaveBeenCalled();

    await coordinator.update({ expectedRevision: limited.revision, tokenLimit: 1_000 });
    await vi.waitFor(() => expect(host.continueGoal).toHaveBeenCalledOnce());
    expect((await coordinator.statusForModel('session-1')).details).toMatchObject({ status: 'active', budget: { tokenLimit: 1_000, source: 'user-explicit' } });
  });

  it('cancels on control and archives on clear', async () => {
    const { coordinator, host, repository } = fixture();
    await coordinator.create({ objective: 'Cancel safely', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await coordinator.control({ action: 'cancel' });
    expect(host.abortGoal).toHaveBeenCalledWith('session-1');
    expect((await coordinator.statusForModel('session-1')).details.status).toBe('cancelled');
    await expect(coordinator.clear()).resolves.toMatchObject({ cleared: true });
    expect(repository.archives).toHaveLength(1);
    await expect(repository.load('/project', 'session-1')).resolves.toBeNull();
  });
});
