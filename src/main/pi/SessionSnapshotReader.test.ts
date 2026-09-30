import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSessionSnapshot } from './SessionSnapshotReader';

describe('Agent Team deletion snapshot retention', () => {
  it.each([0, 25])('retains deletion markers with %i MiB of later history', async (paddingMiB) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'team-deletion-snapshot-'));
    const file = path.join(directory, 'session.jsonl');
    const timestamp = '2026-01-01T00:00:00.000Z';
    const marker = { kind: 'fate-agent-team-event', version: 1, teamId: 'deleted-team', sequence: 2, timestamp: 2, type: 'team.deleted', payload: {} };
    try {
      const fd = openSync(file, 'w');
      try {
        const append = (value: unknown) => writeSync(fd, `${JSON.stringify(value)}\n`);
        append({ type: 'session', version: 3, id: 'root', cwd: directory, timestamp });
        append({ type: 'custom', id: 'old-team', parentId: null, timestamp, customType: 'fate-agent-team-event', data: { ...marker, sequence: 1, type: 'team.closed', payload: { team: { id: 'deleted-team' } } } });
        append({ type: 'custom', id: 'deleted', parentId: 'old-team', timestamp, customType: 'fate-agent-team-event', data: marker });
        const padding = 'x'.repeat(1024 * 1024);
        for (let index = 0; index < paddingMiB; index += 1) {
          append({ type: 'custom', id: `padding-${index}`, parentId: index ? `padding-${index - 1}` : 'deleted', timestamp, customType: 'other-extension', data: padding });
        }
      } finally { closeSync(fd); }
      const snapshot = await readSessionSnapshot(file, 'root');
      expect(snapshot?.branch.find((entry) => entry.id === 'deleted')?.data).toEqual(marker);
      expect(snapshot?.previewNotice ?? '').not.toContain('child-agent state');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
