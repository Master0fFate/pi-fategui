import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleLongTimeout } from './SubagentTimer';

afterEach(() => vi.useRealTimers());

describe('subagent long-duration timer', () => {
  it('supports durations beyond the native 32-bit timeout without firing early', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const elapsed = vi.fn();
    scheduleLongTimeout(elapsed, 2_147_483_647 + 10_000);

    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(elapsed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(elapsed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(elapsed).toHaveBeenCalledOnce();
  });

  it('cancels a long timer explicitly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const elapsed = vi.fn();
    const timer = scheduleLongTimeout(elapsed, 10_000);
    timer.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(elapsed).not.toHaveBeenCalled();
  });
});
