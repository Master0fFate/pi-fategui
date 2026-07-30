import { describe, expect, it } from 'vitest';
import type { SubagentRun } from '../../../shared/contracts/ipc';
import { agentMentionContext, findAgentMentions, parseAgentStopCommand } from './agentMentions';

const run = (handle: string, displayName: string, status: SubagentRun['status'], task = 'Review auth'): SubagentRun => ({
  id: `run-${handle}`, parentSessionId: 'parent', parentToolCallId: 'tool', task, role: 'reviewer', handle, displayName,
  agentName: 'direct', agentSource: 'direct', permissionLevel: 'read-only', enabledTools: [], skills: [], skillMode: 'none', preloadedSkills: [],
  status, model: { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 1_000 }, routingModels: [], thinkingLevel: 'medium',
  executionMode: 'managed', controlCount: 0, attempt: 1, maxAttempts: 1, mailbox: { state: 'disabled', ttlMs: 0, followUpCount: 0 },
  notification: 'never', dependsOn: [], createdAt: 1, updatedAt: 2, messages: [], tools: [], omittedActivity: 0, transcriptTruncated: false,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
});

describe('agent mentions', () => {
  it('locates a mention at the caret without taking over file references', () => {
    expect(agentMentionContext('Ask @auth-re about it', 12)).toEqual({ query: 'auth-re', start: 4, end: 12 });
    expect(agentMentionContext('Open @src/file.ts', 17)).toBeNull();
    expect(agentMentionContext('mail@example.com', 16)).toBeNull();
  });

  it('ranks active handle matches before historical agents', () => {
    const runs = [run('auth-reviewer-1', 'Auth Reviewer', 'completed'), run('auth-scout-1', 'Auth Scout', 'running')];
    expect(findAgentMentions(runs, 'auth').map((item) => item.handle)).toEqual(['auth-scout-1', 'auth-reviewer-1']);
    expect(findAgentMentions(runs, 'reviewer').map((item) => item.handle)).toEqual(['auth-reviewer-1']);
  });

  it('recognizes only exact deterministic stop forms', () => {
    expect(parseAgentStopCommand('@stop @reviewer-1')).toEqual({ target: '@reviewer-1' });
    expect(parseAgentStopCommand('@reviewer-1 stop')).toEqual({ target: '@reviewer-1' });
    expect(parseAgentStopCommand('@stop all')).toEqual({ target: 'all' });
    expect(parseAgentStopCommand('Tell the reviewer to stop.')).toBeNull();
    expect(parseAgentStopCommand('@reviewer-1 summarize')).toBeNull();
  });
});
