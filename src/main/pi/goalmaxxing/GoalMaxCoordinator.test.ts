import { describe, expect, it, vi } from 'vitest';
import type { GoalMaxEvent } from '../../../shared/contracts/goalmaxxing';
import { isTaskListGateSatisfied, type TaskEvent } from '../../../shared/contracts/tasks';
import { GoalMaxCoordinator, type GoalMaxCoordinatorHost, type GoalMaxRuntimeChild, type GoalMaxRuntimeSnapshot } from './GoalMaxCoordinator';
import { InMemoryGoalMaxRepository } from './GoalMaxRepository';
import { TaskService } from '../tasks/TaskService';
import { InMemoryTaskRepository } from '../tasks/TaskRepository';

function fixture(taskService: TaskService | null = null) {
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
  const coordinator = new GoalMaxCoordinator(host, repository, progress as never, taskService);
  return { coordinator, host, runtime, repository, events, progress };
}

async function captureTestPlan(coordinator: GoalMaxCoordinator): Promise<void> {
  const current = (await coordinator.statusForModel('session-1')).details;
  if (current.timeline.some((event) => event.summary.startsWith('Execution task plan captured:'))) return;
  await coordinator.report('session-1', {
    outcome: 'progress', phase: 'planning', summary: 'Captured the test execution plan.', taskPlan: [
      { title: 'Implement the requested result', detail: 'Complete the concrete implementation work described by the persisted objective.' },
      { title: 'Exercise the changed behavior', detail: 'Run focused checks that demonstrate the requested behavior and relevant edge cases.' },
    ],
  });
}

async function addCompletionEvidence(coordinator: GoalMaxCoordinator, outcome: 'progress' | 'completion-candidate' = 'progress'): Promise<void> {
  await captureTestPlan(coordinator);
  coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'completion-test', toolName: 'bash', args: { command: 'pnpm test' } } as never);
  coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: 'completion-test', toolName: 'bash', result: 'passed', isError: false } as never);
  const state = (await coordinator.statusForModel('session-1')).details;
  const evidence = state.evidence.findLast((item) => item.kind === 'test' && item.current && item.exitCode === 0);
  if (!evidence) throw new Error('Expected current test evidence.');
  await coordinator.report('session-1', {
    outcome,
    summary: outcome === 'completion-candidate' ? 'Ready for verification' : 'Current test evidence recorded.',
    criterionUpdates: state.criteria.filter((criterion) => criterion.required).map((criterion) => ({ criterionId: criterion.id, status: 'satisfied', evidenceIds: [evidence.id] })),
  });
}

describe('GoalMax coordinator', () => {
  it('persists before starting and schedules exactly one evidence-backed continuation after settle', async () => {
    const { coordinator, host, runtime, repository } = fixture();
    const goal = await coordinator.create({ objective: 'Implement and test the control plane', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await captureTestPlan(coordinator);
    expect(await repository.load('/project', 'session-1')).toMatchObject({ id: goal.id, revision: 2 });
    expect(host.startGoal).toHaveBeenCalledWith('session-1', goal.objective, expect.stringContaining('GOALMAX OBJECTIVE · ACTIVE'));

    runtime.idle = false; runtime.streaming = true;
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'status-1', toolName: 'goalmax_status', args: {} } as never);
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

  it('blocks implementation work before the execution task plan is captured', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Implement the settings workflow', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    runtime.idle = false; runtime.streaming = true;
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'edit-early', toolName: 'edit', args: { path: 'src/settings.ts' } } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: 'edit-early', toolName: 'edit', result: 'done', isError: false } as never);
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('blocked'));
    expect(host.continueGoal).not.toHaveBeenCalled();
    expect((await coordinator.statusForModel('session-1')).details.blockedReason).toContain('plan gate');
  });

  it('blocks a working turn that never consults the goal plane', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Implement and verify the release', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await captureTestPlan(coordinator);
    runtime.idle = false; runtime.streaming = true;
    coordinator.observeSessionEvent('session-1', { type: 'agent_start' } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'edit-silent', toolName: 'edit', args: { path: 'src/release.ts' } } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: 'edit-silent', toolName: 'edit', result: 'done', isError: false } as never);
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('blocked'));
    expect(host.continueGoal).not.toHaveBeenCalled();
    expect((await coordinator.statusForModel('session-1')).details.blockedReason).toContain('goal plane');
  });

  it('requires task planning before progress, implementation, or completion reports', async () => {
    const { coordinator } = fixture();
    await coordinator.create({ objective: 'Implement and validate the settings workflow', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });

    await expect(coordinator.report('session-1', { outcome: 'progress', phase: 'implementation', summary: 'Started implementation.' })).rejects.toThrow(/task plan/);
    await expect(coordinator.report('session-1', { outcome: 'completion-candidate', phase: 'verification', summary: 'Claimed completion.' })).rejects.toThrow(/task plan/);
    const unplanned = (await coordinator.statusForModel('session-1')).details;
    await expect(coordinator.requestCompletion('session-1', {
      summary: 'Premature completion.',
      criterionEvidence: [{ criterionId: unplanned.criteria[0]!.id, evidenceIds: ['missing-evidence'] }],
    })).resolves.toMatchObject({ text: expect.stringContaining('task plan first'), details: { status: 'active' } });
    await expect(coordinator.report('session-1', { outcome: 'blocked', phase: 'implementation', summary: 'Blocked.', blocker: 'A dependency is unavailable.' })).rejects.toThrow(/intake or planning/);
    await expect(coordinator.report('session-1', { outcome: 'blocked', phase: 'intake', summary: 'Blocked.', blocker: 'A dependency is unavailable.' })).resolves.toMatchObject({ details: { phase: 'intake', status: 'blocked' } });
  });

  it('rejects copied, placeholder, duplicate, and model-owned verification plan items', async () => {
    const { coordinator } = fixture();
    const objective = 'Build a polished settings workflow with validation, persistence, tests, and recovery states.';
    await coordinator.create({ objective, verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    const reportPlan = (taskPlan: NonNullable<Parameters<GoalMaxCoordinator['report']>[1]['taskPlan']>) => coordinator.report('session-1', {
      outcome: 'progress', phase: 'planning', summary: 'Prepared the work plan.', taskPlan,
    });
    const safeTask = { title: 'Trace the settings data flow', detail: 'Map the renderer, preload, persistence, and validation boundaries.' };

    await expect(reportPlan([safeTask, { title: 'Implement the workflow', detail: objective }])).rejects.toThrow(/cannot copy the full objective/);
    await expect(reportPlan([safeTask, { title: 'Implement the workflow', detail: 'Do the work.' }])).rejects.toThrow(/placeholder text/);
    await expect(reportPlan([safeTask, { title: safeTask.title, detail: 'Record a second set of implementation notes.' }])).rejects.toThrow(/duplicates another task/);
    await expect(reportPlan([safeTask, { title: 'Run final checks', detail: 'Use current evidence to confirm the delivered result.' }])).rejects.toThrow(/final verification task/);
    await expect(coordinator.report('session-1', {
      outcome: 'progress', phase: 'planning', summary: 'Mixed incompatible task changes.',
      taskPlan: [safeTask, { title: 'Implement the workflow', detail: 'Build the concrete workflow behavior and its durable state transitions.' }],
      pendingTaskChanges: { add: [{ title: 'Document the workflow', detail: 'Record the operator-visible behavior and its recovery steps.' }] },
    })).rejects.toThrow(/without pending changes/);
  });

  it('replaces provisional criteria with one detailed model-authored execution plan', async () => {
    const { coordinator } = fixture();
    const created = await coordinator.create({ objective: 'Build a polished settings workflow with validation, persistence, tests, and recovery states.', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    expect(created.criteria.map((criterion) => criterion.title)).toEqual(['Plan the execution', 'Verify the delivered result']);

    const planned = (await coordinator.report('session-1', {
      outcome: 'progress',
      phase: 'planning',
      summary: 'Decomposed the objective into ordered implementation work.',
      taskPlan: [
        { title: 'Trace the settings data flow', detail: 'Map the renderer, preload, persistence, and validation boundaries that the change must preserve.' },
        { title: 'Implement the settings workflow', detail: 'Add the required controls, validation, durable save path, and explicit recovery feedback.' },
        { title: 'Cover behavior and edge cases', detail: 'Add focused tests for successful saves, invalid values, storage failures, and regression behavior.' },
      ],
    })).details;

    expect(planned.criteria.map((criterion) => criterion.title)).toEqual([
      'Trace the settings data flow', 'Implement the settings workflow', 'Cover behavior and edge cases', 'Verify the delivered result',
    ]);
    expect(planned.criteria.map((criterion) => criterion.status)).toEqual(['active', 'pending', 'pending', 'pending']);
    expect(planned.taskPlanCaptured).toBe(true);
    expect(planned.timeline.at(-1)?.summary).toBe('Execution task plan captured: 3 implementation tasks.');
    await expect(coordinator.report('session-1', {
      outcome: 'progress', summary: 'Replace the plan again.', taskPlan: [
        { title: 'Inspect the implementation', detail: 'Inspect all current implementation boundaries and record the relevant behavior.' },
        { title: 'Change the implementation', detail: 'Apply the required implementation changes and retain all existing constraints.' },
      ],
    })).rejects.toThrow(/already captured/);
  });

  it('merges new scope by changing untouched pending tasks only', async () => {
    const { coordinator } = fixture();
    await coordinator.create({ objective: 'Implement and test the workflow', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await captureTestPlan(coordinator);
    const before = (await coordinator.statusForModel('session-1')).details;
    const active = before.criteria.find((criterion) => criterion.status === 'active')!;
    const removable = before.criteria.find((criterion) => criterion.status === 'pending' && criterion.title !== 'Verify the delivered result')!;
    const verification = before.criteria.find((criterion) => criterion.title === 'Verify the delivered result')!;

    const updated = (await coordinator.report('session-1', {
      outcome: 'progress', summary: 'Reconciled new user scope.', pendingTaskChanges: {
        removeCriterionIds: [removable.id],
        add: [{ title: 'Document the new behavior', detail: 'Record the added workflow behavior and its operator-visible recovery path.' }],
      },
    })).details;

    expect(updated.criteria.find((criterion) => criterion.id === active.id)).toEqual(active);
    expect(updated.criteria.some((criterion) => criterion.id === removable.id)).toBe(false);
    expect(updated.criteria.find((criterion) => criterion.title === 'Document the new behavior')).toMatchObject({ status: 'pending', required: true });
    expect(updated.criteria.at(-1)?.id).toBe(verification.id);
    await expect(coordinator.report('session-1', {
      outcome: 'progress', summary: 'Tried to remove active work.', pendingTaskChanges: { removeCriterionIds: [active.id] },
    })).rejects.toThrow(/Only untouched pending tasks/);
  });

  it('injects accepted user steering into the active root without rewriting its tasks', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Implement and test the workflow', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await captureTestPlan(coordinator);
    const before = (await coordinator.statusForModel('session-1')).details;
    runtime.idle = false; runtime.streaming = true;

    const updated = await coordinator.recordSteering('session-1', 'Also document the recovery path.', 'steer');

    expect(updated?.criteria).toEqual(before.criteria);
    expect(updated?.steering.at(-1)?.text).toBe('Also document the recovery path.');
    expect(host.steerGoal).toHaveBeenCalledWith('session-1', expect.stringContaining('Also document the recovery path.'), before.id, expect.any(Number));
  });

  it('keeps an incomplete completion request active without creating warning tasks', async () => {
    const { coordinator, host } = fixture();
    await coordinator.create({ objective: 'Implement and test the workflow', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await captureTestPlan(coordinator);

    const result = await coordinator.requestCompletion('session-1', { summary: 'Claimed completion without evidence.' });

    expect(result.text).toContain('Completion was not accepted');
    expect(result.details.status).toBe('active');
    expect(result.details.criteria.every((criterion) => criterion.status !== 'failed')).toBe(true);
    expect(host.verifyGoal).not.toHaveBeenCalled();
  });

  it('does not complete while delegated work is still active', async () => {
    const { coordinator, runtime } = fixture();
    await coordinator.create({ objective: 'Implement and test the workflow', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await addCompletionEvidence(coordinator);
    runtime.activeChildren = 2;

    const result = await coordinator.requestCompletion('session-1', { summary: 'All root work is finished.' });

    expect(result.text).toContain('Wait for 2 active child tasks to settle');
    expect(result.details).toMatchObject({ status: 'active', blockedReason: null, failure: null });
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

  it('completes atomically when current evidence covers the work after the latest edit', async () => {
    const tasks = new TaskService({ emit: vi.fn() }, new InMemoryTaskRepository());
    const { coordinator, host, runtime, progress } = fixture(tasks);
    await coordinator.create({ objective: 'Edit then test the result', verificationLevel: 'strict', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await captureTestPlan(coordinator);
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
      criterionEvidence: evidenceState.criteria.filter((criterion) => criterion.required && criterion.title !== 'Verify the delivered result').map((criterion) => ({ criterionId: criterion.id, evidenceIds: [testEvidence.id] })),
    });
    expect(completion).toMatchObject({ details: { status: 'completed', phase: 'handoff', executionState: 'idle', blockedReason: null, failure: null } });
    expect(completion.text).toContain('GoalMax completed');
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    expect(host.verifyGoal).not.toHaveBeenCalled();
    const completed = (await coordinator.statusForModel('session-1')).details;
    expect(completed.evidence.find((item) => item.kind === 'test')).toMatchObject({ current: true, exitCode: 0 });
    const verificationCriterion = completed.criteria.find((criterion) => criterion.title === 'Verify the delivered result')!;
    const verifierEvidence = completed.evidence.find((item) => item.kind === 'verification')!;
    expect(verificationCriterion).toMatchObject({ status: 'satisfied' });
    expect(verificationCriterion.evidenceIds).toContain(verifierEvidence.id);
    expect(verifierEvidence.criterionIds).toEqual(completed.criteria.filter((criterion) => criterion.required && criterion.status !== 'waived').map((criterion) => criterion.id));
    expect(completed.criteria.filter((criterion) => criterion.id !== verificationCriterion.id).every((criterion) => !criterion.evidenceIds.includes(verifierEvidence.id))).toBe(true);
    expect(verificationCriterion.evidenceIds.some((id) => completed.evidence.some((item) => item.id === id && item.current && item.kind !== 'verification'))).toBe(true);
    await vi.waitFor(() => expect(isTaskListGateSatisfied(tasks.get('/project', 'session-1'))).toBe(true));
    expect(tasks.get('/project', 'session-1')?.tasks.filter((task) => task.source === 'goalmax').every((task) => task.status === 'done' && task.verified)).toBe(true);
  });

  it('rejects completion when steering changes the goal during the atomic gate', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Finish without losing late steering', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await addCompletionEvidence(coordinator);
    runtime.idle = false;
    runtime.streaming = true;
    let injectSteering = true;
    let completionRuntimeCalls = 0;
    vi.mocked(host.runtime).mockImplementation((sessionId) => {
      if (injectSteering) {
        completionRuntimeCalls += 1;
        if (completionRuntimeCalls === 2) {
          injectSteering = false;
          void coordinator.recordSteering('session-1', 'Also cover the late compatibility case.', 'steer');
        }
      }
      return !sessionId || sessionId === runtime.sessionId ? { ...runtime } : null;
    });

    const completion = await coordinator.requestCompletion('session-1', { summary: 'The original plan is complete.' });

    expect(completion.text).toContain('goal changed during the completion gate');
    expect(completion.details).toMatchObject({ status: 'active', blockedReason: null, failure: null });
    expect(completion.details.steering.at(-1)?.text).toBe('Also cover the late compatibility case.');
    expect(completion.details.timeline.some((event) => event.type === 'goal.completed')).toBe(false);
  });

  it('requires the verification gate before completion', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Produce the requested result', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await addCompletionEvidence(coordinator, 'completion-candidate');
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

  it('completes cleanly when verifier evidence evicts an older linked record at the ledger limit', async () => {
    const { coordinator, runtime } = fixture();
    await coordinator.create({ objective: 'Complete with a saturated evidence ledger', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await captureTestPlan(coordinator);

    for (let index = 0; index < 255; index += 1) {
      const toolCallId = `ledger-edit-${index}`;
      coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId, toolName: 'edit', args: { path: `src/ledger-${index}.ts` } } as never);
      coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId, toolName: 'edit', result: 'done', isError: false } as never);
      if ((index + 1) % 64 === 0) await coordinator.statusForModel('session-1');
    }
    let state = (await coordinator.statusForModel('session-1')).details;
    const oldestEvidenceId = state.evidence[0]!.id;

    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'ledger-test', toolName: 'bash', args: { command: 'pnpm test' } } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: 'ledger-test', toolName: 'bash', result: 'passed', isError: false } as never);
    state = (await coordinator.statusForModel('session-1')).details;
    const testEvidence = state.evidence.findLast((item) => item.kind === 'test')!;
    expect(state.evidence).toHaveLength(256);

    await coordinator.requestCompletion('session-1', {
      summary: 'The saturated ledger still has current completion evidence.',
      criterionEvidence: state.criteria.filter((criterion) => criterion.required).map((criterion) => ({
        criterionId: criterion.id,
        evidenceIds: [oldestEvidenceId, testEvidence.id],
      })),
    });
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('completed'));
    const completed = (await coordinator.statusForModel('session-1')).details;
    expect(completed).toMatchObject({ status: 'completed', blockedReason: null, failure: null });
    expect(completed.evidence).toHaveLength(256);
    expect(completed.evidence.some((item) => item.id === oldestEvidenceId)).toBe(false);
    expect(completed.criteria.every((criterion) => !criterion.evidenceIds.includes(oldestEvidenceId))).toBe(true);
    expect(completed.criteria.filter((criterion) => criterion.required).every((criterion) => criterion.evidenceIds.includes(testEvidence.id))).toBe(true);
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

    await addCompletionEvidence(coordinator);
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
    await addCompletionEvidence(coordinator, 'completion-candidate');
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
    await captureTestPlan(coordinator);
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

  it('keeps verifier infrastructure failure active without a blocker warning', async () => {
    const { coordinator, host, runtime } = fixture();
    vi.mocked(host.verifyGoal).mockRejectedValueOnce(new Error(`verifier unavailable ${'x'.repeat(5_000)}`));
    await coordinator.create({ objective: 'Require independent evidence', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await addCompletionEvidence(coordinator, 'completion-candidate');
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('active'));
    await vi.waitFor(() => expect(host.continueGoal).toHaveBeenCalledOnce());
    const state = (await coordinator.statusForModel('session-1')).details;
    expect(state).toMatchObject({ status: 'active', blockedReason: null, failure: null });
    expect(state.continuation.reason).toBeTruthy();
    expect(state.evidence.findLast((item) => item.kind === 'verification')).toMatchObject({ current: true, title: 'Independent completion review unavailable' });
    expect(state.criteria.some((criterion) => criterion.title.includes('Independent verifier unavailable'))).toBe(false);
  });

  it('returns a verifier timeout to active retry without a blocker warning', async () => {
    const { coordinator, host, runtime } = fixture();
    vi.mocked(host.verifyGoal).mockResolvedValueOnce({
      verdict: 'fail',
      report: 'VERDICT: fail\nFINDINGS:\n- major — verification — verifier timed out — retry verification',
      nodeId: 'verifier-timeout',
      infrastructureFailure: 'timeout',
    });
    await coordinator.create({ objective: 'Bound independent verification', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await addCompletionEvidence(coordinator, 'completion-candidate');
    runtime.idle = true; runtime.streaming = false;
    coordinator.observeSessionEvent('session-1', { type: 'agent_settled' } as never);

    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.status).toBe('active'));
    await vi.waitFor(() => expect(host.continueGoal).toHaveBeenCalledOnce());
    const state = (await coordinator.statusForModel('session-1')).details;
    expect(state).toMatchObject({ status: 'active', blockedReason: null, failure: null });
    expect(state.evidence.findLast((item) => item.kind === 'verification')).toMatchObject({ current: true, title: 'Independent completion review unavailable' });
    expect(state.criteria.some((criterion) => criterion.title.includes('verifier timed out'))).toBe(false);
  });

  it('bounds long-running evidence and removes references to evicted records', async () => {
    const { coordinator } = fixture();
    await coordinator.create({ objective: 'Sustain a bounded evidence ledger', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await captureTestPlan(coordinator);
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

  it('edits a recorded goal update and re-steers the running root with the new capsule', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Implement the release workflow', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    runtime.idle = false; runtime.streaming = true;
    await coordinator.recordSteering('session-1', 'Original constraint', 'steer');
    const before = (await coordinator.statusForModel('session-1')).details;
    const edited = await coordinator.updateSteering('session-1', before.steering[0]!.id, 'Edited constraint');

    expect(edited?.steering[0]).toMatchObject({ id: before.steering[0]!.id, text: 'Edited constraint' });
    await vi.waitFor(() => expect(host.steerGoal).toHaveBeenCalledWith('session-1', expect.stringContaining('Edited constraint'), edited?.id, edited?.revision));
  });

  it('withdraws a recorded goal update and refuses edits to unknown steering ids', async () => {
    const { coordinator, host, runtime } = fixture();
    await coordinator.create({ objective: 'Implement the release workflow', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    runtime.idle = false; runtime.streaming = true;
    await coordinator.recordSteering('session-1', 'Temporary note', 'steer');
    const before = (await coordinator.statusForModel('session-1')).details;
    const removed = await coordinator.removeSteering('session-1', before.steering[0]!.id);

    expect(removed?.steering).toHaveLength(0);
    await vi.waitFor(() => expect(host.steerGoal).toHaveBeenCalledWith('session-1', expect.not.stringContaining('Temporary note'), removed?.id, removed?.revision));
    await expect(coordinator.updateSteering('session-1', 'steering-missing', 'Nope')).rejects.toThrow(/no longer listed/);
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
    await captureTestPlan(coordinator);
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
    await expect(coordinator.requestCompletion('session-1', { summary: 'Late completion call.' })).resolves.toMatchObject({
      text: expect.stringContaining('was cancelled'),
      details: { status: 'cancelled' },
    });
    await expect(coordinator.clear()).resolves.toMatchObject({ cleared: true });
    expect(repository.archives).toHaveLength(1);
    await expect(repository.load('/project', 'session-1')).resolves.toBeNull();
  });

  it('Gate A: verification at normal level fails closed without current non-verifier evidence per criterion', async () => {
    const { coordinator } = fixture();
    await coordinator.create({ objective: 'Implement and verify the result', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    const before = (await coordinator.statusForModel('session-1')).details;
    await coordinator.control({ action: 'verify' });
    const after = await coordinator.statusForModel('session-1');
    // The goal must NOT complete: required criteria lack current non-verifier evidence.
    expect(after.details.status).not.toBe('completed');
    // A deterministic finding returns as pending follow-up work, not a warning-state task.
    expect(after.details.criteria.some((criterion) => criterion.status === 'pending' && /non-verifier evidence/iu.test(criterion.title))).toBe(true);
    void before;
  });

  it('Gate A: syncs required criteria into the canonical task list and keeps it unverified', async () => {
    const { coordinator } = fixture();
    const taskEvents: TaskEvent[] = [];
    const taskRepository = new InMemoryTaskRepository();
    const tasks = new TaskService({ emit: (event) => { taskEvents.push(event); } }, taskRepository);
    const bound = new GoalMaxCoordinator(
      { runtime: vi.fn(() => ({ projectPath: '/project', sessionId: 'session-1', projectTrusted: true, permissionLevel: 'edit' as const, idle: true, streaming: false, queuedUserMessages: 0, tokensUsed: 0, activeChildren: 0, children: [] })),
        startGoal: vi.fn(async () => true), continueGoal: vi.fn(async () => undefined), steerGoal: vi.fn(async () => undefined), abortGoal: vi.fn(async () => undefined),
        verifyGoal: vi.fn(async () => ({ verdict: 'pass' as const, report: 'VERDICT: pass' })), diagnoseGoal: vi.fn(async () => ({ report: 'ok' })), persistSessionEvent: vi.fn(), emit: vi.fn() },
      new InMemoryGoalMaxRepository(),
      { capture: vi.fn(async () => ({ fingerprint: 'base', changedFileCount: 0, paths: [], repository: true })) } as never,
      tasks,
    );
    await bound.create({ objective: 'Implement and verify the result', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await vi.waitFor(() => expect(tasks.get('/project', 'session-1')).not.toBeNull());
    const list = tasks.get('/project', 'session-1');
    expect(list!.goalId).toBeTruthy();
    expect(list!.tasks.some((task) => task.source === 'goalmax' && task.required)).toBe(true);
    expect(list!.tasks.every((task) => !task.verified)).toBe(true);
    await bound.dispose();
  });

  it('rejects completion when a new child appears during the atomic gate and stays active', async () => {
    const { coordinator, host, runtime, repository } = fixture();
    await coordinator.create({ objective: 'Complete without losing a late child', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await addCompletionEvidence(coordinator);
    const newChild: GoalMaxRuntimeChild = {
      nodeId: 'child-late', label: 'Late worker', objective: 'Handle the edge case',
      status: 'running', permissionLevel: 'edit', requestedModel: null, effectiveModel: null,
      requestedThinking: null, effectiveThinking: null, startedAt: Date.now(), endedAt: null,
      result: null, error: null, observations: [],
    };
    const originalSave = repository.save.bind(repository);
    repository.save = async (state, expected) => {
      if (state.status === 'completed') coordinator.syncChildren('session-1', [newChild]);
      return originalSave(state, expected);
    };
    void host; void runtime;

    const completion = await coordinator.requestCompletion('session-1', { summary: 'The original plan is complete.' });

    expect(completion.text).toContain('child task started during the completion gate');
    expect(completion.details).toMatchObject({ status: 'active', executionState: 'idle', blockedReason: null, failure: null });
    expect(completion.details.timeline.some((event) => event.type === 'goal.completed')).toBe(false);
    // After the fence clears, the late child is reconciled into the still-active goal.
    coordinator.syncChildren('session-1', [newChild]);
    await vi.waitFor(async () => expect((await coordinator.statusForModel('session-1')).details.childAssignments.some((assignment) => assignment.nodeId === 'child-late' && assignment.status === 'running')).toBe(true));
  });

  it('rebinds a completed goal and repairs stale GoalMax tasks to done and verified', async () => {
    const taskRepository = new InMemoryTaskRepository();
    const tasks = new TaskService({ emit: vi.fn() }, taskRepository);
    const repository = new InMemoryGoalMaxRepository();
    const progress = { capture: vi.fn(async () => ({ fingerprint: 'base', changedFileCount: 0, paths: [], repository: true })) };
    const host: GoalMaxCoordinatorHost = {
      runtime: vi.fn((): GoalMaxRuntimeSnapshot => ({ projectPath: '/project', sessionId: 'session-1', projectTrusted: true, permissionLevel: 'edit', idle: true, streaming: false, queuedUserMessages: 0, tokensUsed: 0, activeChildren: 0, children: [] })),
      startGoal: vi.fn(async () => true), continueGoal: vi.fn(async () => undefined), steerGoal: vi.fn(async () => undefined), abortGoal: vi.fn(async () => undefined),
      verifyGoal: vi.fn(async () => ({ verdict: 'pass' as const, report: 'ok' })), diagnoseGoal: vi.fn(async () => ({ report: 'ok' })), persistSessionEvent: vi.fn(), emit: vi.fn(),
    };
    const coordinator = new GoalMaxCoordinator(host, repository, progress as never, tasks);
    await coordinator.create({ objective: 'Repair the projection after rebind', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await captureTestPlan(coordinator);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_start', toolCallId: 'repair-test', toolName: 'bash', args: { command: 'pnpm test' } } as never);
    coordinator.observeSessionEvent('session-1', { type: 'tool_execution_end', toolCallId: 'repair-test', toolName: 'bash', result: 'passed', isError: false } as never);
    const evidenceState = (await coordinator.statusForModel('session-1')).details;
    const testEvidence = evidenceState.evidence.find((item) => item.kind === 'test')!;
    await coordinator.requestCompletion('session-1', {
      summary: 'Work is complete',
      criterionEvidence: evidenceState.criteria.filter((criterion) => criterion.required && criterion.title !== 'Verify the delivered result').map((criterion) => ({ criterionId: criterion.id, evidenceIds: [testEvidence.id] })),
    });
    const completed = (await coordinator.statusForModel('session-1')).details;
    expect(completed.status).toBe('completed');
    // Simulate a stale projection: detach the goal tasks as if a prior sync failed.
    await tasks.detachGoal('/project', 'session-1', completed.id);
    expect(tasks.get('/project', 'session-1')?.tasks.filter((task) => task.source === 'goalmax')).toHaveLength(0);

    // A fresh coordinator rebinds the completed goal from durable storage and
    // repairs the canonical task projection.
    const restored = new GoalMaxCoordinator(host, repository, progress as never, tasks);
    await restored.bind('/project', 'session-1');

    const repaired = tasks.get('/project', 'session-1');
    expect(repaired?.tasks.filter((task) => task.source === 'goalmax').every((task) => task.status === 'done' && task.verified)).toBe(true);
    expect(isTaskListGateSatisfied(repaired)).toBe(true);
  });

  it('reactivates a verifying goal to active when a rejected completion has no criterion evidence', async () => {
    const { coordinator, runtime } = fixture();
    await coordinator.create({ objective: 'Reactivate after a verifying rejection', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null });
    await captureTestPlan(coordinator);
    await coordinator.report('session-1', { outcome: 'completion-candidate', summary: 'Ready', phase: 'verification' });
    let verifying = (await coordinator.statusForModel('session-1')).details;
    expect(verifying.status).toBe('verifying');
    runtime.idle = false; runtime.streaming = true;
    const completion = await coordinator.requestCompletion('session-1', { summary: 'Complete without evidence linkage.' });
    expect(completion.details.status).toBe('active');
    expect(completion.details.executionState).toBe('idle');
    expect(completion.details.blockedReason).toBeNull();
    expect(completion.details.failure).toBeNull();
  });
});
