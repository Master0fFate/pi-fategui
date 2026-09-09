import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { activationSchema, emptyActivation, LEARNING_LIMITS, lessonContentSchema, memoryLearningSettingsSchema, modelDraftResultSchema, utf8Bytes } from '../../shared/contracts/learning';
import { emptyLearningSnapshot, learningDigest, learningIdentity } from './LearningRepository';
import { selectLearning } from './LearningSelection';
import { learningMarkdown } from '../../shared/learningMarkdown';

describe('Learning contracts and selection limits', () => {
  it('defaults off and rejects paths, authority fields and UTF-8 overflow', () => {
    expect(memoryLearningSettingsSchema.parse(undefined)).toEqual({ enabled: false, global: true, project: true });
    expect(memoryLearningSettingsSchema.parse({ enabled: true, scope: 'global' })).toEqual({ enabled: true, global: true, project: true });
    for (const relative of ['/secret', '../secret', 'C:\\secret', 'src/../secret', '**/*.ts']) expect(activationSchema.safeParse({ ...emptyActivation, relativePaths: [relative] }).success).toBe(false);
    expect(utf8Bytes('😀')).toBe(4);
    expect(lessonContentSchema.safeParse({ kind: 'note', title: 'Unicode', body: { guidance: '😀'.repeat(600), rationale: '', exceptions: [] }, activation: emptyActivation }).success).toBe(false);
    expect(modelDraftResultSchema.safeParse({ outcome: 'no_lesson', reason: 'none', approved: true }).success).toBe(false);
  });
  it('renders procedures deterministically without executing commands and skips whole oversized items', async () => {
    const content = lessonContentSchema.parse({ kind: 'procedure', title: 'Managed procedure', activation: emptyActivation, body: { purpose: 'Verify safely', useWhen: ['Requested explicitly'], doNotUseWhen: [], preconditions: [], steps: Array.from({ length: 8 }, (_, index) => `${index}: ${'x'.repeat(780)}`), verification: ['pnpm test'], stopConditions: ['Tests fail'] } });
    expect(learningMarkdown(content)).toContain('## Stop conditions');
    expect(learningMarkdown(content)).toBe(learningMarkdown(content));
    const state = emptyLearningSnapshot(learningIdentity('/project', 'project'));
    const id = randomUUID(); const revisionId = randomUUID();
    state.lessons.push({ id, activeRevisionId: revisionId, enabled: true, freshness: 'current', conflict: false, createdAt: 0, updatedAt: 0 });
    state.revisions.push({ id: revisionId, lessonId: id, revisionNumber: 1, content, evidenceIds: [], contentDigest: learningDigest({ content, evidenceIds: [] }), approvedAt: 0, approvalSource: 'local-user', createdFromDraftId: randomUUID(), supersedesRevisionId: null });
    const selected = await selectLearning({ snapshot: state, enabled: true, root: '/project', projectKey: state.projectKey, text: 'procedure', pins: [{ lessonId: id, revisionId }], branch: null });
    expect(selected.block).toBe(''); expect(selected.selection.skipped[0]!.reason).toContain('no steps were truncated');
  });
  it('measures bounded warm selection for 100 approved lessons, including Unicode keyword matching', async () => {
    const state = emptyLearningSnapshot(learningIdentity('/project', 'project')); state.mode = 'automatic';
    for (let index = 0; index < LEARNING_LIMITS.lessons; index++) {
      const id = randomUUID(); const revisionId = randomUUID();
      const content = lessonContentSchema.parse({ kind: 'note', title: `Note ${index}`, body: { guidance: 'Preserve the main process boundary.', rationale: '', exceptions: [] }, activation: { ...emptyActivation, keywords: ['renderer', '文件系统'] } });
      state.lessons.push({ id, activeRevisionId: revisionId, enabled: true, freshness: 'current', conflict: false, createdAt: 0, updatedAt: 0 });
      state.revisions.push({ id: revisionId, lessonId: id, revisionNumber: 1, content, evidenceIds: [], contentDigest: learningDigest({ content, evidenceIds: [] }), approvedAt: 0, approvalSource: 'local-user', createdFromDraftId: randomUUID(), supersedesRevisionId: null });
    }
    const timings: number[] = [];
    let first: string | undefined;
    for (let index = 0; index < 60; index++) {
      const start = performance.now();
      const selected = await selectLearning({ snapshot: state, enabled: true, root: '/project', projectKey: state.projectKey, text: 'renderer 文件系统', pins: [], branch: null });
      if (index >= 10) timings.push(performance.now() - start);
      expect(selected.selection.selected).toHaveLength(3);
      first ??= selected.block; expect(selected.block).toBe(first);
    }
    const p95 = timings.sort((a, b) => a - b)[Math.floor(timings.length * 0.95)]!;
    process.stdout.write(`Learning selection: ${os.platform()}/${os.arch()} ${os.cpus()[0]?.model}; 100 synthetic notes, 50 warm runs, no file I/O; p95=${p95.toFixed(2)}ms\n`);
    expect(p95).toBeLessThan(100);
  });
});
