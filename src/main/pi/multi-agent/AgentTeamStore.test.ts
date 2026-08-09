import { describe, expect, it } from 'vitest';
import { agentTeamSchema } from '../../../shared/contracts/multiAgent';
import { addEnvelope, addTask, createTeamRuntime, hydrateTeamRuntime, ledgerSnapshot, projectTeam } from './AgentTeamStore';

const model = { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 128_000 };

describe('AgentTeamStore', () => {
  it('keeps node, task, and envelope lifecycles separate and schema-bounded', () => {
    const runtime = createTeamRuntime('root-session', '/project', model, 'high', 'edit', { now: 10 });
    const root = runtime.nodes.get(runtime.state.rootNodeId)!;
    const envelope = addEnvelope(runtime, { kind: 'NEW_TASK', authorNodeId: root.id, recipientNodeId: root.id, content: 'task', triggerTurn: true }, 11);
    const task = addTask(runtime, { assigneeNodeId: root.id, requesterNodeId: root.id, inputEnvelopeId: envelope.id, summary: 'task', status: 'queued' }, 12);
    envelope.taskId = task.id;
    const team = projectTeam(runtime);
    expect(agentTeamSchema.parse(team)).toEqual(team);
    expect(team.tasks[0]?.id).not.toBe(team.rootNodeId);
    expect(team.envelopes[0]?.id).not.toBe(team.tasks[0]?.id);
  });

  it('restores active work honestly as interrupted', () => {
    const runtime = createTeamRuntime('root-session', '/project', model, 'max', 'full-access');
    const root = runtime.nodes.get(runtime.state.rootNodeId)!;
    root.status = 'active';
    const event = ledgerSnapshot(runtime, 'checkpoint');
    const restored = hydrateTeamRuntime(event.payload.team)!;
    expect(restored.state.status).toBe('restored-interrupted');
    expect(restored.nodes.get(root.id)?.status).toBe('active');
    expect(restored.state.activeTurns).toBe(0);
    expect(restored.state.writerNodeId).toBeNull();
  });

  it('migrates legacy single-team snapshots with explicit project ownership and selection', () => {
    const legacy = projectTeam(createTeamRuntime('root-session', '/project', model, 'medium', 'read-only')) as unknown as Record<string, unknown>;
    delete legacy.projectPath;
    delete legacy.name;
    delete legacy.selected;
    const restored = hydrateTeamRuntime(legacy, '/migrated-project');
    expect(restored?.state).toMatchObject({ projectPath: '/migrated-project', name: 'Agent Team', selected: true });
  });

  it('rejects oversized UTF-8 messages before insertion', () => {
    const runtime = createTeamRuntime('root-session', '/project', model, 'medium', 'read-only');
    const root = runtime.nodes.get(runtime.state.rootNodeId)!;
    expect(() => addEnvelope(runtime, { kind: 'MESSAGE', authorNodeId: root.id, recipientNodeId: root.id, content: '😀'.repeat(9_000), triggerTurn: false })).toThrow(/UTF-8 bytes/);
    expect(runtime.envelopes.size).toBe(0);
  });
});
