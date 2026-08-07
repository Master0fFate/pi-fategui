import { describe, expect, it } from 'vitest';
import { classifyGoalMaxTool, parseGoalMaxPorcelain } from './GoalMaxProgressEngine';

describe('GoalMax progress evidence', () => {
  it('recognizes verification commands without treating plans as progress', () => {
    expect(classifyGoalMaxTool('bash', JSON.stringify({ command: 'pnpm typecheck && pnpm test' }), 'passed', false)).toMatchObject({ kind: 'test', meaningful: true, verification: true, exitCode: 0 });
    expect(classifyGoalMaxTool('bash', JSON.stringify({ command: 'pnpm test:e2e' }), 'passed', false)).toMatchObject({ kind: 'test', verification: true });
    expect(classifyGoalMaxTool('read', JSON.stringify({ path: 'README.md' }), 'text', false)).toMatchObject({ kind: 'runtime', investigation: true, meaningful: false, path: 'README.md' });
    expect(classifyGoalMaxTool('goalmax_report', '{}', 'reported', false)).toBeNull();
    expect(classifyGoalMaxTool('goalmax_complete', '{}', 'requested', false)).toBeNull();
  });

  it('keeps the current path from Git rename records', () => {
    expect(parseGoalMaxPorcelain('R  src/new.ts\0src/old.ts\0 M src/changed.ts\0')).toEqual([
      { status: 'R ', filePath: 'src/new.ts' },
      { status: ' M', filePath: 'src/changed.ts' },
    ]);
  });

  it('fingerprints repeated failures and records file mutations', () => {
    const first = classifyGoalMaxTool('bash', JSON.stringify({ command: 'pnpm test' }), 'same failure', true);
    const second = classifyGoalMaxTool('bash', JSON.stringify({ command: 'pnpm test' }), 'same failure', true);
    expect(first?.failureFingerprint).toBe(second?.failureFingerprint);
    expect(first).toMatchObject({ kind: 'test', meaningful: false, exitCode: 1 });
    expect(classifyGoalMaxTool('edit', JSON.stringify({ path: 'src/app.ts' }), 'done', false)).toMatchObject({ kind: 'file', path: 'src/app.ts', meaningful: true, investigation: false });
    expect(classifyGoalMaxTool('bash', JSON.stringify({ command: 'git diff --stat' }), 'src/app.ts | 2 +-', false)).toMatchObject({ kind: 'command', investigation: true, meaningful: false });
  });
});
