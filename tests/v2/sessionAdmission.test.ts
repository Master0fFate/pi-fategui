import { describe, expect, it } from 'vitest';
import { WorkspaceAdmissionQueue } from '../../src/core/workspaces/WorkspaceAdmissionQueue';

function fixture() {
  const view = { sessionId: 'A' as string | null, getState: (_includeMessages: false) => ({ sessionId: view.sessionId }) };
  const queue = new WorkspaceAdmissionQueue(view, 4);
  const command = { workspaceGeneration: 4, expectedSessionId: 'A', selectionRevision: 0, controlGeneration: 2 };
  let controlGeneration = 2;
  let permission = true;
  let currentGeneration = 4;
  return { view, queue, command, authorize: () => ({ controlGeneration, permission, currentGeneration }),
    setControl: (value: number) => { controlGeneration = value; },
    setPermission: (value: boolean) => { permission = value; },
    setGeneration: (value: number) => { currentGeneration = value; } };
}

describe('per-workspace short admission', () => {
  it('serializes a prompt waiting for acceptance with a session switch, without retargeting either', async () => {
    const f = fixture();
    let accept!: () => void;
    const admitted = new Promise<void>((resolve) => { accept = resolve; });
    const targets: Array<string | null> = [];
    const prompt = f.queue.run(f.command, f.authorize, async ({ sessionId }) => { targets.push(sessionId); await admitted; return 'accepted'; });
    const switchSession = f.queue.run(f.command, f.authorize, async ({ sessionId }) => { targets.push(sessionId); f.view.sessionId = 'B'; }, true);
    await Promise.resolve();
    expect(targets).toEqual(['A']);
    accept();
    expect(await prompt).toBe('accepted');
    await switchSession;
    expect(targets).toEqual(['A', 'A']);
    expect(f.queue.snapshot()).toEqual({ selectedSessionId: 'B', selectionRevision: 1 });
    await expect(f.queue.run(f.command, f.authorize, () => { throw new Error('never'); })).rejects.toMatchObject({ code: 'STALE_SESSION' });
    expect(f.queue.pending).toBe(0);
  });

  it('keeps a transition revision even if selection returns to A between snapshots', async () => {
    const f = fixture();
    f.queue.observeSelection('B');
    f.queue.observeSelection('A');
    expect(f.queue.snapshot()).toEqual({ selectedSessionId: 'A', selectionRevision: 2 });
    await expect(f.queue.run(f.command, f.authorize, () => { throw new Error('never'); })).rejects.toMatchObject({ code: 'STALE_SESSION' });
  });

  it('lets B admit while A waits; never holds the lane for the whole provider turn', async () => {
    const a = fixture(); const b = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = a.queue.run(a.command, a.authorize, async () => { await gate; return 'admitted'; });
    expect(await b.queue.run(b.command, b.authorize, () => 'B admitted')).toBe('B admitted');
    release();
    expect(await first).toBe('admitted');
    // A real prompt handler returns acceptance here. Its provider turn runs elsewhere.
  });

  it('rechecks permission, control, generation and selected session at the queue head', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = f.queue.run(f.command, f.authorize, async () => { await gate; });
    await Promise.resolve(); // First admission has entered before the queued permission change.
    let invoked = false;
    const denied = f.queue.run(f.command, f.authorize, () => { invoked = true; });
    f.setPermission(false);
    release(); await first;
    await expect(denied).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(invoked).toBe(false);
    f.setPermission(true); f.setControl(3);
    await expect(f.queue.run(f.command, f.authorize, () => { invoked = true; })).rejects.toMatchObject({ code: 'CONTROL_REQUIRED' });
    f.setControl(2); f.setGeneration(5);
    await expect(f.queue.run(f.command, f.authorize, () => { invoked = true; })).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
    f.setGeneration(4); f.view.sessionId = 'B';
    await expect(f.queue.run(f.command, f.authorize, () => { invoked = true; })).rejects.toMatchObject({ code: 'STALE_SESSION' });
    expect(f.queue.snapshot().selectionRevision).toBe(1);
    expect(invoked).toBe(false);
  });
});
