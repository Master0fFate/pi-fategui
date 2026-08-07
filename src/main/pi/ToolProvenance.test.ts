import { describe, expect, it } from 'vitest';
import { createToolProvenance } from './ToolProvenance';

describe('createToolProvenance', () => {
  it.each([
    ['read', 'src/app.ts', 'read'],
    ['write', 'src/new-app.ts', 'write'],
    ['edit', 'src/features/app.ts', 'edit'],
  ] as const)('records direct %s arguments as validated structured paths', (toolName, inputPath, operation) => {
    expect(createToolProvenance(toolName, { path: inputPath, ignored: 'not copied' }, { kind: 'root' })).toEqual({
      actor: { kind: 'root' },
      affectedPaths: [{ path: inputPath, operation }],
    });
  });

  it.each([
    ['bash', { path: 'src/app.ts' }],
    ['grep', { path: 'src/app.ts' }],
    ['read', { path: '../secret' }],
    ['read', { path: './src/app.ts' }],
    ['read', { path: 'src/features/../app.ts' }],
    ['read', { path: 'C:/secret' }],
    ['read', { path: 'src\\app.ts' }],
    ['read', { path: 42 }],
    ['read', '{"path":"src/app.ts"}'],
  ])('fails closed for %s with untrusted arguments', (toolName, args) => {
    expect(createToolProvenance(toolName, args, { kind: 'root' })).toBeUndefined();
  });

  it('preserves validated legacy and team actor identity without raw metadata', () => {
    expect(createToolProvenance('edit', { path: 'src/app.ts' }, { kind: 'legacy', runId: 'run-1', parentToolCallId: 'parent-1' })?.actor).toEqual({ kind: 'legacy', runId: 'run-1', parentToolCallId: 'parent-1' });
    expect(createToolProvenance('write', { path: 'src/app.ts' }, { kind: 'team', teamId: 'team-1', nodeId: 'node-1', taskId: 'task-1' })?.actor).toEqual({ kind: 'team', teamId: 'team-1', nodeId: 'node-1', taskId: 'task-1' });
  });
});
