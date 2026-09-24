import { describe, expect, it } from 'vitest';
import { AgentTeamScheduler } from './AgentTeamScheduler';
import { DEFAULT_AGENT_TEAM_LIMITS } from './AgentTeamStore';

describe('AgentTeamScheduler', () => {
  it('does not cap concurrent read-only turns', () => {
    const scheduler = new AgentTeamScheduler({ ...DEFAULT_AGENT_TEAM_LIMITS });
    const leases = ['a', 'b', 'c', 'd', 'e'].map((id) => scheduler.acquire(id, 'read-only'));
    expect(scheduler.activeTurns).toBe(5);
    const sixth = scheduler.acquire('f', 'read-only');
    leases.forEach((lease) => lease.release());
    expect(scheduler.activeTurns).toBe(1);
    sixth.release();
    expect(scheduler.activeTurns).toBe(0);
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
