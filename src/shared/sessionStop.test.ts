import { describe, expect, it } from 'vitest';
import { canStopSession, hasStoppableChildWork } from './sessionStop';

const idleTeam = {
  activeTurns: 0,
  nodes: [{ depth: 1, status: 'ready' }],
  tasks: [{ status: 'completed' }],
};

const activeTeam = {
  activeTurns: 1,
  nodes: [{ depth: 1, status: 'active' }],
  tasks: [{ status: 'running' }],
};

describe('hasStoppableChildWork', () => {
  it('is false for idle retained children', () => {
    expect(hasStoppableChildWork({})).toBe(false);
    expect(hasStoppableChildWork({ agentTeams: [idleTeam], subagents: [{ status: 'completed' }], subagentWorkflows: [{ nodes: [{ status: 'completed' }] }] })).toBe(false);
    expect(hasStoppableChildWork({ agentTeams: [{ activeTurns: 0, nodes: [{ depth: 1, status: 'interrupted' }], tasks: [{ status: 'interrupted' }] }], subagents: [{ status: 'blocked' }] })).toBe(false);
  });

  it('is true for running or queued owned work', () => {
    expect(hasStoppableChildWork({ subagents: [{ status: 'running' }] })).toBe(true);
    expect(hasStoppableChildWork({ subagents: [{ status: 'queued' }] })).toBe(true);
    expect(hasStoppableChildWork({ agentTeams: [activeTeam] })).toBe(true);
    expect(hasStoppableChildWork({ agentTeams: [{ activeTurns: 0, nodes: [{ depth: 1, status: 'creating' }], tasks: [] }] })).toBe(true);
    expect(hasStoppableChildWork({ agentTeams: [{ activeTurns: 0, nodes: [{ depth: 0, status: 'active' }], tasks: [{ status: 'queued' }] }] })).toBe(true);
    expect(hasStoppableChildWork({ subagentWorkflows: [{ nodes: [{ status: 'pending' }] }] })).toBe(true);
    expect(hasStoppableChildWork({ subagentWorkflows: [{ nodes: [{ status: 'running' }] }] })).toBe(true);
  });
});

describe('canStopSession', () => {
  it('accepts absent optional fields from validated runtime snapshots', () => {
    expect(canStopSession({ streaming: false, activeSessionRunning: undefined, agentTeams: undefined, subagents: undefined, subagentWorkflows: undefined })).toBe(false);
  });

  it('covers root turns and child work without collapsing them', () => {
    expect(canStopSession({ streaming: false })).toBe(false);
    expect(canStopSession({ streaming: true })).toBe(true);
    expect(canStopSession({ streaming: false, activeSessionRunning: true })).toBe(true);
    expect(canStopSession({ streaming: false, subagents: [{ status: 'running' }] })).toBe(true);
    expect(canStopSession({ streaming: false, agentTeams: [idleTeam] })).toBe(false);
  });
});
