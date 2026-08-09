import { describe, expect, it } from 'vitest';
import type { PiEvent } from '../../shared/contracts/ipc';
import { backgroundAttentionUpdate } from './MultiProjectPiRuntime';

const started = { type: 'run.started', runId: 'run-1', timestamp: 1 } satisfies PiEvent;
const completed = { type: 'run.completed', runId: 'run-1', aborted: false, timestamp: 2 } satisfies PiEvent;
const aborted = { type: 'run.completed', runId: 'run-1', aborted: true, timestamp: 2 } satisfies PiEvent;
const failed = {
  type: 'error',
  timestamp: 2,
  error: { code: 'PI_RUNTIME_ERROR', message: 'failed', retryable: true },
} satisfies PiEvent;

describe('backgroundAttentionUpdate', () => {
  it('tracks running and successful completion for a globally background selected session', () => {
    expect(backgroundAttentionUpdate([started])).toBe('running');
    expect(backgroundAttentionUpdate([completed])).toBe('completed');
  });

  it('uses chronological event order and clears attention for an aborted run', () => {
    expect(backgroundAttentionUpdate([completed, failed])).toBe('error');
    expect(backgroundAttentionUpdate([completed, started])).toBe('running');
    expect(backgroundAttentionUpdate([failed, started, completed])).toBe('completed');
    expect(backgroundAttentionUpdate([aborted])).toBeNull();
    expect(backgroundAttentionUpdate([])).toBeUndefined();
  });
});
