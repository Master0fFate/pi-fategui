import { describe, expect, it } from 'vitest';
import { stripReplayedFailedAssistants } from './RestoredAgentMessages';

describe('stripReplayedFailedAssistants', () => {
  it('strips error and length assistants anywhere in the list', () => {
    const messages = [
      { role: 'assistant', stopReason: 'error' },
      { role: 'user' },
      { role: 'assistant', stopReason: 'length' },
    ];
    expect(stripReplayedFailedAssistants(messages)).toEqual([{ role: 'user' }]);
  });

  it('keeps other assistant, user, and tool result messages', () => {
    const messages = [
      { role: 'assistant', stopReason: 'aborted' },
      { role: 'assistant', stopReason: 'stop' },
      { role: 'user' },
      { role: 'toolResult' },
    ];
    expect(stripReplayedFailedAssistants(messages)).toEqual(messages);
  });

  it('handles an empty list', () => {
    expect(stripReplayedFailedAssistants([])).toEqual([]);
  });

  it('returns a new array without mutating input', () => {
    const messages = [{ role: 'user' }];
    const result = stripReplayedFailedAssistants(messages);
    expect(result).not.toBe(messages);
    expect(messages).toEqual([{ role: 'user' }]);
  });
});
