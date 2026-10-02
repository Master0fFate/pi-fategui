import { describe, expect, it } from 'vitest';
import { RecoveredExecutionPolicy } from '../../src/main/pi/RecoveredExecutionPolicy';

describe('reviewed UNKNOWN fresh execution policy', () => {
  it('requires a fresh identity-bound intent each process/generation, never an old receipt', () => {
    const policy = new RecoveredExecutionPolicy(true);
    expect(policy.allowsAutomaticContinuation('a', 1)).toBe(false);
    policy.recordExplicitIntent('a', 1);
    expect(policy.allowsAutomaticContinuation('a', 1)).toBe(true);
    expect(policy.allowsAutomaticContinuation('b', 1)).toBe(false);
    expect(policy.allowsAutomaticContinuation('a', 2)).toBe(false);
    expect(new RecoveredExecutionPolicy(true).allowsAutomaticContinuation('a', 1)).toBe(false);
    policy.recordExplicitIntent('a', 1, 3);
    expect(policy.allowsAutomaticContinuation('a', 1, 3)).toBe(true);
    expect(policy.allowsAutomaticContinuation('a', 1, 4)).toBe(false);
    expect(policy.allowsAutomaticContinuation('a', 1)).toBe(false);
    policy.forget('a'); expect(policy.allowsAutomaticContinuation('a', 1)).toBe(false);
    policy.recordExplicitIntent('a', 2); policy.clear(); expect(policy.allowsAutomaticContinuation('a', 2)).toBe(false);
  });
  it('leaves ordinary profiles unchanged and bounds retained intent without opening any scope', () => {
    expect(new RecoveredExecutionPolicy(false).allowsAutomaticContinuation('ordinary', 0)).toBe(true);
    const policy = new RecoveredExecutionPolicy(true);
    for (let index = 0; index < 1025; index++) policy.recordExplicitIntent(String(index), 0);
    expect(policy.allowsAutomaticContinuation('0', 0)).toBe(false);
    expect(policy.allowsAutomaticContinuation('1024', 0)).toBe(true);
    expect(() => policy.recordExplicitIntent('', 0)).toThrow();
    expect(() => policy.recordExplicitIntent('x', -1)).toThrow();
  });
});
