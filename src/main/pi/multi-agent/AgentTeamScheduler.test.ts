import { describe, expect, it } from 'vitest';
import { AgentTeamScheduler } from './AgentTeamScheduler';
import { DEFAULT_AGENT_TEAM_LIMITS } from './AgentTeamStore';

describe('AgentTeamScheduler', () => {
  it('enforces root-wide turn capacity', () => {
    const scheduler = new AgentTeamScheduler({ ...DEFAULT_AGENT_TEAM_LIMITS });
    const leases = ['a', 'b', 'c'].map((id) => scheduler.acquire(id, 'read-only'));
    expect(scheduler.activeTurns).toBe(3);
    expect(() => scheduler.acquire('d', 'read-only')).toThrow(/capacity is full/);
    leases[0]!.release();
    expect(scheduler.acquire('d', 'read-only').nodeId).toBe('d');
  });

  it('serializes write-capable child turns and releases idempotently', () => {
    const scheduler = new AgentTeamScheduler({ ...DEFAULT_AGENT_TEAM_LIMITS });
    const writer = scheduler.acquire('writer-a', 'edit');
    expect(scheduler.writer).toBe('writer-a');
    expect(() => scheduler.acquire('writer-b', 'full-access')).toThrow(/writer lease/);
    expect(() => scheduler.acquire('writer-a', 'edit')).toThrow(/already has an active turn/);
    writer.release();
    writer.release();
    expect(scheduler.writer).toBeNull();
    expect(scheduler.activeTurns).toBe(0);
  });
});
