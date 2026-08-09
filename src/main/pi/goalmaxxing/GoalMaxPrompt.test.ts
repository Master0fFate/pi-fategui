import { describe, expect, it } from 'vitest';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import { AGENT_TEAM_MAX_MESSAGE_BYTES } from '../../../shared/contracts/multiAgent';
import { GOALMAX_CAPSULE_MAX_BYTES, GOALMAX_VERIFIER_PROMPT_MAX_BYTES, goalMaxCapsule, goalMaxVerificationPrompt } from './GoalMaxPrompt';

function largeGoal(): GoalMaxState {
  const now = Date.now();
  return {
    schemaVersion: 2,
    id: 'goal-large-prompt',
    sessionId: 'session-1',
    projectPath: '/project',
    revision: 1,
    objective: `Verify a Unicode-heavy project ${'🧪'.repeat(6_000)}`,
    originalBriefRef: null,
    originalBriefHash: null,
    status: 'verifying',
    phase: 'verification',
    executionState: 'waiting',
    verificationLevel: 'strict',
    agentStrategy: 'auto',
    criteria: Array.from({ length: 32 }, (_value, index) => ({
      id: `criterion-${index}`,
      title: `Required result ${index} ${'界'.repeat(180)}`,
      description: `Inspect criterion ${index} ${'検証'.repeat(1_000)}`,
      required: true,
      status: 'satisfied' as const,
      evidenceIds: [],
      ownerNodeIds: [],
      updatedAt: now,
    })),
    budget: { tokenLimit: null, timeLimitMs: null, source: null },
    permission: { permissionLevel: 'full-access', projectTrusted: true, revision: 1, resolvedAt: now },
    progress: {
      meaningfulTurnCount: 1, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0,
      changedFileCount: 1, baselineWorkspaceFingerprint: 'a', latestWorkspaceFingerprint: 'b',
      latestEvidenceAt: now, latestMeaningfulProgressAt: now, lastFailureFingerprint: null,
    },
    evidence: Array.from({ length: 40 }, (_value, index) => ({
      id: `evidence-${index}`,
      kind: 'test' as const,
      title: `Verification command ${index} ${'測'.repeat(180)}`,
      summary: `Current output ${index} ${'出力'.repeat(2_000)}`,
      criterionIds: [],
      source: 'root-tool' as const,
      timestamp: now + index,
      current: true,
      command: `pnpm test --filter ${index} ${'界'.repeat(1_000)}`,
      exitCode: 0,
    })),
    continuation: { pending: false, attempt: 1, lastScheduledAt: now, lastSettledAt: now, reason: null },
    steering: [],
    childAssignments: [],
    tokensUsed: 1,
    tokenBaseline: 0,
    elapsedMs: 1,
    timeline: [],
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    blockedReason: null,
    failure: null,
  };
}

describe('GoalMax prompts', () => {
  it('keeps the continuation capsule compact without truncating its control contract', () => {
    const base = largeGoal();
    const goal = {
      ...base,
      revision: 40,
      steering: Array.from({ length: 32 }, (_value, index) => ({
        id: `steering-${index}`, text: `constraint-${index} ${'🧭'.repeat(4_000)}`, behavior: 'followUp' as const,
        timestamp: base.createdAt + index, revision: index + 1,
      })),
    };

    const capsule = goalMaxCapsule(goal);

    expect(Buffer.byteLength(capsule, 'utf8')).toBeLessThanOrEqual(GOALMAX_CAPSULE_MAX_BYTES);
    for (let index = 0; index < 32; index += 1) expect(capsule).toContain(`criterion-${index}`);
    expect(capsule).toContain('constraint-24');
    expect(capsule).toContain('constraint-31');
    expect(capsule).not.toContain('constraint-23');
    expect(capsule).not.toContain('�');
    expect(capsule).toContain('call goalmax_complete exactly once');
    expect(capsule).toMatch(/Completion is decided atomically by the control plane from current evidence\.$/u);
  });

  it('requires one detailed AI task plan during intake and stops asking after capture', () => {
    const intake = { ...largeGoal(), phase: 'intake' as const, status: 'active' as const, executionState: 'running-root' as const };
    const initialCapsule = goalMaxCapsule(intake);
    expect(initialCapsule).toContain('PLANNING CONTRACT');
    expect(initialCapsule).toContain('taskPlan containing 2-12 concrete implementation tasks');
    expect(initialCapsule).toContain('Do not copy the objective');

    const plannedCapsule = goalMaxCapsule({
      ...intake,
      phase: 'planning',
      taskPlanCaptured: true,
      timeline: [],
    });
    expect(plannedCapsule).not.toContain('PLANNING CONTRACT');
  });

  it('fits the Agent Team UTF-8 envelope while retaining every criterion and the newest evidence', () => {
    const prompt = goalMaxVerificationPrompt(largeGoal());

    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(GOALMAX_VERIFIER_PROMPT_MAX_BYTES);
    expect(GOALMAX_VERIFIER_PROMPT_MAX_BYTES).toBeLessThan(AGENT_TEAM_MAX_MESSAGE_BYTES);
    for (let index = 0; index < 32; index += 1) expect(prompt).toContain(`criterion-${index}`);
    expect(prompt).toContain('evidence-39');
    expect(prompt).not.toContain('evidence-0 ·');
    expect(prompt).not.toContain('�');
    expect(prompt).toMatch(/A model claim alone is never evidence\.$/u);
  });
});
