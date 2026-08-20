import { describe, expect, it } from 'vitest';
import { SESSION_EXPORT_FIELD_LIMIT, buildSessionExport, sessionExportOutcome } from './SessionExport';

describe('SessionExport', () => {
  it('builds markdown and json with prompts, tools, and outcome', () => {
    const artifact = buildSessionExport({
      sessionId: 'sess-1',
      title: 'Fix IPC',
      projectPath: '/proj',
      model: 'xai/grok-4.6',
      permissionLevel: 'edit',
      messages: [
        { role: 'user', text: 'Export this session' },
        { role: 'assistant', text: 'Wrote the exporter.' },
      ],
      tools: [{ name: 'edit', status: 'succeeded', output: 'updated SessionExport.ts' }],
    });
    expect(artifact.markdown).toContain('# Fate UI session export');
    expect(artifact.markdown).toContain('Export this session');
    expect(artifact.markdown).toContain('edit (succeeded)');
    expect(artifact.markdown).toContain('Wrote the exporter.');
    const parsed = JSON.parse(artifact.json) as { outcome: string; messages: unknown[] };
    expect(parsed.outcome).toBe('Wrote the exporter.');
    expect(parsed.messages).toHaveLength(2);
  });

  it('exports an empty session and bounds long fields', () => {
    const long = 'x'.repeat(SESSION_EXPORT_FIELD_LIMIT + 50);
    const empty = buildSessionExport({ sessionId: null, messages: [], tools: [] });
    expect(sessionExportOutcome({ sessionId: null, messages: [], tools: [] })).toBe('No assistant outcome yet.');
    expect(empty.markdown).toContain('_No messages._');
    expect(empty.markdown).toContain('_No tools._');
    const artifact = buildSessionExport({
      sessionId: null,
      messages: [{ role: 'user', text: long }],
      tools: [{ name: 'read', status: 'running', output: long }],
    });
    expect(artifact.json).toContain('truncated');
    expect(JSON.parse(artifact.json).messages[0].text.length).toBeLessThan(long.length);
  });
});
