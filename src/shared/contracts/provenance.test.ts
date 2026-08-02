import { describe, expect, it } from 'vitest';
import { MAX_PROVENANCE_PATHS, projectRelativePathSchema, toolProvenanceSchema } from './provenance';

const rootProvenance = (path: string) => ({ actor: { kind: 'root' as const }, affectedPaths: [{ path, operation: 'read' as const }] });

describe('structured tool provenance', () => {
  it('accepts normalized project-relative paths and all actor identities', () => {
    expect(projectRelativePathSchema.parse('src/features/app.ts')).toBe('src/features/app.ts');
    expect(toolProvenanceSchema.parse(rootProvenance('src/app.ts')).actor.kind).toBe('root');
    expect(toolProvenanceSchema.parse({ actor: { kind: 'legacy', runId: 'run-1', parentToolCallId: 'parent-1' }, affectedPaths: [{ path: 'src/app.ts', operation: 'edit' }] }).actor.kind).toBe('legacy');
    expect(toolProvenanceSchema.parse({ actor: { kind: 'team', teamId: 'team-1', nodeId: 'node-1', taskId: 'task-1' }, affectedPaths: [{ path: 'src/app.ts', operation: 'write' }] }).actor.kind).toBe('team');
  });

  it.each(['', '/etc/passwd', 'C:/secret.txt', '//server/share', '../secret', 'src/../secret', './src/app.ts', 'src\\app.ts', 'src//app.ts', 'src/./app.ts', `src/\0app.ts`])('rejects unsafe path %j', (path) => {
    expect(projectRelativePathSchema.safeParse(path).success).toBe(false);
  });

  it('rejects duplicate, oversized, malformed, and extra provenance fields', () => {
    expect(toolProvenanceSchema.safeParse({ actor: { kind: 'root' }, affectedPaths: [
      { path: 'src/app.ts', operation: 'read' },
      { path: 'src/app.ts', operation: 'edit' },
    ] }).success).toBe(false);
    expect(toolProvenanceSchema.safeParse({ actor: { kind: 'root' }, affectedPaths: Array.from({ length: MAX_PROVENANCE_PATHS + 1 }, (_, index) => ({ path: `src/${index}.ts`, operation: 'read' })) }).success).toBe(false);
    expect(toolProvenanceSchema.safeParse({ ...rootProvenance('src/app.ts'), command: 'cat /etc/passwd' }).success).toBe(false);
    expect(toolProvenanceSchema.safeParse({ actor: { kind: 'legacy', runId: '', parentToolCallId: 'p' }, affectedPaths: [{ path: 'src/app.ts', operation: 'read' }] }).success).toBe(false);
  });
});
