import { describe, expect, it } from 'vitest';
import { agentPathDepth, assertAgentPath, normalizeAgentSegment, reserveAgentPath } from './AgentPath';

describe('AgentPath', () => {
  it('normalizes and atomically reserves deterministic sibling paths', () => {
    expect(normalizeAgentSegment(' Security Reviewer! ')).toBe('security-reviewer');
    const first = reserveAgentPath('/root', 'Reviewer', new Set());
    const second = reserveAgentPath('/root', 'Reviewer', new Set([first.path]));
    expect(first).toEqual({ path: '/root/reviewer', handle: 'reviewer' });
    expect(second).toEqual({ path: '/root/reviewer-2', handle: 'reviewer-2' });
    expect(agentPathDepth('/root/reviewer/tester')).toBe(2);
  });

  it('rejects malformed and reserved paths', () => {
    expect(() => assertAgentPath('/other/agent')).toThrow(/Invalid agent path/);
    expect(() => assertAgentPath('/root/Bad Name')).toThrow(/Invalid agent path/);
    expect(normalizeAgentSegment('root')).toBe('agent');
  });
});
