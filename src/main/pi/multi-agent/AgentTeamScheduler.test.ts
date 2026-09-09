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

  it('permits isolated writers concurrently but serializes a shared checkout', () => {
    const scheduler = new AgentTeamScheduler({ ...DEFAULT_AGENT_TEAM_LIMITS });
    const first = scheduler.acquire('writer-a', 'edit', 'checkout-a');
    const second = scheduler.acquire('writer-b', 'full-access', 'checkout-b');
    expect(scheduler.activeTurns).toBe(2);
    expect(() => scheduler.acquire('writer-c', 'edit', 'checkout-a')).toThrow(/writer lease/);
    expect(() => scheduler.acquire('writer-a', 'edit', 'checkout-a')).toThrow(/already has an active turn/);
    first.release();
    first.release();
    second.release();
    expect(scheduler.writer).toBeNull();
    expect(scheduler.activeTurns).toBe(0);
  });
});
