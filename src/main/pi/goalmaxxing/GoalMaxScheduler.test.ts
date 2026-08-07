import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalMaxScheduler } from './GoalMaxScheduler';

afterEach(() => vi.useRealTimers());

describe('GoalMax scheduler', () => {
  it('coalesces duplicate triggers and rejects stale revisions', async () => {
    vi.useFakeTimers();
    const scheduler = new GoalMaxScheduler();
    const run = vi.fn(async () => undefined);
    expect(scheduler.schedule({ goalId: 'goal-1', expectedRevision: 2, reason: 'settled' }, run)).toBe(true);
    expect(scheduler.schedule({ goalId: 'goal-1', expectedRevision: 2, reason: 'child' }, run)).toBe(false);
    expect(scheduler.schedule({ goalId: 'goal-1', expectedRevision: 1, reason: 'stale' }, run)).toBe(false);
    expect(scheduler.schedule({ goalId: 'goal-1', expectedRevision: 3, reason: 'newer' }, run)).toBe(true);
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 3, reason: 'newer' }));
  });

  it('retains the newest trigger that arrives while a continuation lease is active', async () => {
    vi.useFakeTimers();
    const scheduler = new GoalMaxScheduler();
    let release!: () => void;
    const firstLease = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async (request: { expectedRevision: number }) => {
      if (request.expectedRevision === 1) await firstLease;
    });
    scheduler.schedule({ goalId: 'goal-1', expectedRevision: 1, reason: 'first' }, run);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();

    scheduler.schedule({ goalId: 'goal-1', expectedRevision: 2, reason: 'settled-during-lease' }, run);
    release();
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 2 }));
  });

  it('cancels pending continuation work', async () => {
    vi.useFakeTimers();
    const scheduler = new GoalMaxScheduler();
    const run = vi.fn(async () => undefined);
    scheduler.schedule({ goalId: 'goal-1', expectedRevision: 1, reason: 'settled' }, run);
    scheduler.cancel('goal-1');
    await vi.runAllTimersAsync();
    expect(run).not.toHaveBeenCalled();
  });
});
