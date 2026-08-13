import { describe, expect, it } from 'vitest';
import type { SubagentRun } from '../../../shared/contracts/ipc';
import type { AgentTeam } from '../../../shared/contracts/multiAgent';
import { agentMentionContext, findAgentMentions, findLiveAgentMentions, parseAgentStopCommand } from './agentMentions';

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
    expect(agentMentionContext('Ask @auth-re about it', 12)).toEqual({ symbol: '@', query: 'auth-re', start: 4, end: 12 });
    expect(agentMentionContext('Ask ~saved-work about it', 15)).toEqual({ symbol: '~', query: 'saved-work', start: 4, end: 15 });
    expect(agentMentionContext('Open @src/file.ts', 17)).toBeNull();
    expect(agentMentionContext('mail@example.com', 16)).toBeNull();
  });

  it('ranks active handle matches before historical agents', () => {
    const runs = [run('auth-reviewer-1', 'Auth Reviewer', 'completed'), run('auth-scout-1', 'Auth Scout', 'running')];
    expect(findAgentMentions(runs, 'auth').map((item) => item.handle)).toEqual(['auth-scout-1', 'auth-reviewer-1']);
    expect(findAgentMentions(runs, 'reviewer').map((item) => item.handle)).toEqual(['auth-reviewer-1']);
  });

  it('includes live Agent Team nodes and excludes archived legacy sessions', () => {
    const team = {
      id: 'team-1', rootSessionId: 'parent', projectPath: '/project', name: 'Review team', protocolVersion: 2, status: 'active', selected: true,
      rootNodeId: 'root-node', limits: { maxDepth: 2, maxNodes: 16, maxActiveTurns: 3, maxMessages: 256, maxMessageBytes: 32_768 }, activeTurns: 1, writerNodeId: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      nodes: [
        { id: 'root-node', teamId: 'team-1', parentNodeId: null, path: '/root', handle: 'root', displayName: 'Root', depth: 0, role: 'root', agentName: 'root', permissionLevel: 'read-only', enabledTools: [], model: run('x', 'x', 'completed').model, thinkingLevel: 'off', status: 'ready', childIds: ['node-review'], unreadMessages: 0, writer: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, createdAt: 1, updatedAt: 1 },
        { id: 'node-review', teamId: 'team-1', parentNodeId: 'root-node', path: '/root/reviewer', handle: 'team-reviewer', displayName: 'Team Reviewer', depth: 1, role: 'reviewer', agentName: 'direct', permissionLevel: 'read-only', enabledTools: [], model: run('x', 'x', 'completed').model, thinkingLevel: 'medium', status: 'active', childIds: [], unreadMessages: 0, writer: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, createdAt: 1, updatedAt: 2 },
      ], tasks: [{ id: 'task-1', teamId: 'team-1', assigneeNodeId: 'node-review', requesterNodeId: 'root-node', inputEnvelopeId: 'envelope-1', summary: 'Review authentication', status: 'running', createdAt: 1, startedAt: 1 }], envelopes: [], operationReceipts: [], timeline: [], createdAt: 1, updatedAt: 2,
    } satisfies AgentTeam;
    const mentions = findLiveAgentMentions([run('archived', 'Archived', 'completed')], [team], [], null, 'review');
    expect(mentions).toEqual([expect.objectContaining({ kind: 'team-node', handle: 'team-reviewer', active: true })]);
  });

  it('includes saved main sessions and excludes the active session', () => {
    const sessions = [
      { id: 'live-1', title: 'Clarify MCP adapter', firstMessage: 'Clarify Pi MCP', path: '/p/1.jsonl', messageCount: 3, modifiedAt: Date.now(), active: false, attention: 'running' },
      { id: 'idle-1', title: 'Idle background', firstMessage: 'Idle', path: '/p/2.jsonl', messageCount: 2, modifiedAt: Date.now(), active: false, attention: null },
      { id: 'active-me', title: 'Current session', firstMessage: 'Mine', path: '/p/3.jsonl', messageCount: 1, modifiedAt: Date.now(), active: true, attention: null },
      { id: 'done-1', title: 'Finished run', firstMessage: 'Done', path: '/p/4.jsonl', messageCount: 4, modifiedAt: Date.now(), active: false, attention: 'completed' },
    ] as unknown as Array<import('../../../shared/contracts/ipc').SessionSummary>;
    const mentions = findLiveAgentMentions([], [], sessions, 'active-me', 'mcp', 8, '~');
    expect(mentions.map((mention) => mention.id)).toEqual(['live-1']);
    expect(mentions[0]).toEqual(expect.objectContaining({ kind: 'session', handle: 'clarify-mcp-adapter', active: true, canReceive: true }));
    const done = findLiveAgentMentions([], [], sessions, 'active-me', 'done', 8, '~');
    expect(done[0]).toEqual(expect.objectContaining({ kind: 'session', id: 'done-1', active: false }));
    const idle = findLiveAgentMentions([], [], sessions, 'active-me', 'idle', 8, '~');
    expect(idle[0]).toEqual(expect.objectContaining({ kind: 'session', id: 'idle-1', active: false, canReceive: true }));
    expect(findLiveAgentMentions([], [], sessions, 'active-me', 'current', 8, '~')).toEqual([]);
    expect(findLiveAgentMentions([run('session-agent', 'Session Agent', 'running')], [], sessions, 'active-me', 'session', 8, '@'))
      .toEqual([expect.objectContaining({ kind: 'subagent', handle: 'session-agent' })]);
  });

  it('recognizes only exact deterministic stop forms', () => {
    expect(parseAgentStopCommand('@stop @reviewer-1')).toEqual({ target: '@reviewer-1' });
    expect(parseAgentStopCommand('@reviewer-1 stop')).toEqual({ target: '@reviewer-1' });
    expect(parseAgentStopCommand('@stop all')).toEqual({ target: 'all' });
    expect(parseAgentStopCommand('Tell the reviewer to stop.')).toBeNull();
    expect(parseAgentStopCommand('@reviewer-1 summarize')).toBeNull();
  });
});
