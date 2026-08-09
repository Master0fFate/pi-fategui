import { Type } from 'typebox';
import { defineTool, type ModelRuntime, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentTeamCoordinator } from './AgentTeamCoordinator';
import { childToolNames, modelSelectionSchema, permissions, thinkingLevels } from '../SubagentProtocol';

function enumString(values: readonly string[], description: string) {
  return Type.Unsafe<string>({ type: 'string', enum: values, description });
}

const teamId = Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: 'Explicit team ID. Root calls use the selected team when omitted; child calls remain bound to their own team.' }));
const target = Type.String({ minLength: 1, maxLength: 512, description: 'Same-team target by immutable node ID, canonical path, or stable @handle.' });
const message = Type.String({ minLength: 1, maxLength: 32 * 1024 });
const deliveryModes = ['queue', 'steer'] as const;
const spawnParameters = Type.Object({
  teamId,
  task: Type.String({ minLength: 1, maxLength: 200_000 }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  role: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  permission: Type.Optional(enumString(permissions, 'Same-or-narrower authority.')),
  model: Type.Optional(modelSelectionSchema),
  thinkingLevel: Type.Optional(enumString(thinkingLevels, 'Independent child reasoning effort.')),
  tools: Type.Optional(Type.Array(enumString(childToolNames, 'Ordinary child tool.'), { maxItems: childToolNames.length })),
  instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 200_000 })),
  skills: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 64 })),
  skillMode: Type.Optional(enumString(['all', 'selected', 'none'], 'Child skill discovery visibility.')),
  preloadSkills: Type.Optional(Type.Boolean()),
  contextTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: 'Sanitized recent parent user/assistant turns. Omit for fresh context.' })),
}, { additionalProperties: false });

function text(content: string, details: unknown) {
  return { content: [{ type: 'text' as const, text: content }], details };
}

export function createAgentCollaborationTools(
  coordinator: AgentTeamCoordinator,
  callerNodeId: string | null,
  modelRuntime: ModelRuntime,
): ToolDefinition[] {
  const caller = (sessionId: string, requestedTeamId?: string) => callerNodeId ?? coordinator.rootNodeId(sessionId, requestedTeamId);
  const rootLifecycleTools: ToolDefinition[] = callerNodeId ? [] : [
    defineTool({
      name: 'create_team', label: 'Create team', promptSnippet: 'Create a new Agent Team',
      description: 'Create a new independent team for this root session and project. The first team becomes selected; later teams can be selected explicitly.',
      parameters: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (_id, params, _signal, _update, ctx) => text('Team created.', coordinator.createTeam(ctx.sessionManager.getSessionId(), params.name)),
    }),
    defineTool({
      name: 'list_teams', label: 'List teams', promptSnippet: 'List teams for this root session',
      description: 'List active and historical teams, including the selected team, lifecycle state, and capacity.',
      parameters: Type.Object({}, { additionalProperties: false }), executionMode: 'parallel',
      execute: async (_id, _params, _signal, _update, ctx) => {
        const teams = coordinator.getTeams(ctx.sessionManager.getSessionId());
        return text(teams.map((team) => `${team.selected ? '*' : '-'} ${team.name} · ${team.id} · ${team.status} · ${team.nodes.filter((node) => node.depth > 0 && node.status !== 'released').length}/${team.limits.maxNodes} nodes`).join('\n') || 'No teams exist.', { teams });
      },
    }),
    defineTool({
      name: 'inspect_team', label: 'Inspect team', promptSnippet: 'Inspect one Agent Team',
      description: 'Return the current snapshot and lifecycle capacity for an explicit team.',
      parameters: Type.Object({ teamId: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false }), executionMode: 'parallel',
      execute: async (_id, params, _signal, _update, ctx) => {
        const team = coordinator.getTeams(ctx.sessionManager.getSessionId()).find((candidate) => candidate.id === params.teamId);
        if (!team) throw new Error(`Unknown team ${params.teamId}.`);
        return text(`${team.name} (${team.id}) is ${team.status}.`, team);
      },
    }),
    ...(['select', 'pause', 'resume', 'close', 'reset'] as const).map((action) => defineTool({
      name: `${action}_team`, label: `${action[0]!.toUpperCase()}${action.slice(1)} team`, promptSnippet: `${action} an Agent Team`,
      description: action === 'close' ? 'Close a team. Active work is refused unless force is explicit; force aborts turns and cancels tasks.' : action === 'reset' ? 'Reset a team to an empty active state. Active work is refused unless force is explicit.' : `${action[0]!.toUpperCase()}${action.slice(1)} an explicit team idempotently.`,
      parameters: Type.Object({ teamId: Type.String({ minLength: 1, maxLength: 160 }), ...((action === 'close' || action === 'reset') ? { force: Type.Optional(Type.Boolean()) } : {}) }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (_id, params, _signal, _update, ctx) => {
        const root = ctx.sessionManager.getSessionId();
        const value = action === 'select' ? coordinator.selectTeam(root, params.teamId) : action === 'pause' ? coordinator.pauseTeam(root, params.teamId) : action === 'resume' ? coordinator.resumeTeam(root, params.teamId) : action === 'close' ? await coordinator.closeTeam(root, params.teamId, params.force === true) : await coordinator.resetTeam(root, params.teamId, params.force === true);
        return text(`Team ${value.id} is ${value.status}.`, value);
      },
    })),
  ];
  return [
    defineTool({
      name: 'spawn_agent', label: 'Spawn agent', promptSnippet: 'Create one direct child agent',
      description: 'Create a direct child in the current Agent Team V2 tree and start its initial task. Depth, total nodes, active turns, authority, context, and the single-writer lease are enforced atomically.',
      promptGuidelines: ['Delegate one bounded outcome.', 'Children share the project tree. Only one write-capable child turn may run at once.', 'Capacity errors are explicit; wait for existing work and retry.'],
      parameters: spawnParameters, executionMode: 'sequential',
      execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
        const receipt = await coordinator.spawn(caller(ctx.sessionManager.getSessionId(), params.teamId), params, toolCallId, modelRuntime, signal);
        return text(`Spawned @${receipt.handle} at ${receipt.path} (${receipt.status}).`, receipt);
      },
    }),
    defineTool({
      name: 'send_message', label: 'Send agent message', promptSnippet: 'Queue information for a team agent',
      description: 'Persist and deliver bounded information to another same-team agent. delivery=queue (default) holds the message until the recipient\'s current task settles and delivers it once without waking an idle agent; delivery=steer injects into a streaming turn and never starts a new executable task.',
      parameters: Type.Object({ teamId, target, message, delivery: Type.Optional(enumString(deliveryModes, 'queue holds the message until the recipient\'s current task settles and delivers it once; steer injects into a streaming turn without starting a new task. Omit for queue.')) }, { additionalProperties: false }), executionMode: 'parallel',
      execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
        const delivery = params.delivery === 'steer' ? 'steer' : 'queue';
        const receipt = await coordinator.sendMessage(caller(ctx.sessionManager.getSessionId(), params.teamId), params.target, params.message, toolCallId, delivery);
        return text(`Message ${receipt.envelopeId} is ${receipt.state}.`, receipt);
      },
    }),
    defineTool({
      name: 'followup_task', label: 'Follow-up task', promptSnippet: 'Assign executable work to a direct child',
      description: 'Create a new persisted task for an owned direct child. An idle/interrupted child is resumed with its existing Pi context.',
      parameters: Type.Object({ teamId, target, task: message }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
        const receipt = await coordinator.followUp(caller(ctx.sessionManager.getSessionId(), params.teamId), params.target, params.task, toolCallId, modelRuntime, signal);
        return text(`Follow-up ${receipt.taskId} assigned to ${receipt.path}.`, receipt);
      },
    }),
    defineTool({
      name: 'wait_agent', label: 'Wait for agents', promptSnippet: 'Wait for bounded team activity',
      description: 'Wait for mailbox activity or direct-child state changes. It returns changed paths; message content is delivered separately as typed context.',
      parameters: Type.Object({
        teamId,
        targets: Type.Array(target, { minItems: 1, maxItems: 16 }),
        timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 300, default: 30 })),
      }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const result = await coordinator.wait(caller(ctx.sessionManager.getSessionId(), params.teamId), params.targets, (params.timeoutSeconds ?? 30) * 1_000, signal);
        return text(result.changed.length ? `Changed agents:\n${result.changed.map((item) => `- ${item.path}: ${item.reason}`).join('\n')}` : 'No matching agent activity before timeout.', result);
      },
    }),
    defineTool({
      name: 'interrupt_agent', label: 'Interrupt agent', promptSnippet: 'Interrupt an owned descendant turn',
      description: 'Abort an active owned descendant turn while preserving its persistent session for later follow-up.',
      parameters: Type.Object({ teamId, target, reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })) }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const result = await coordinator.interrupt(caller(ctx.sessionManager.getSessionId(), params.teamId), params.target, params.reason);
        return text(`Interrupted ${result.path}; its session remains reusable.`, result);
      },
    }),
    defineTool({
      name: 'inspect_agent', label: 'Inspect agent', promptSnippet: 'Inspect node lifecycle and runtime resources',
      description: 'Inspect a same-team node lifecycle plus its loaded session, streaming turn, lease, timer, listener, wait-edge, and index resource state.',
      parameters: Type.Object({ teamId, target }, { additionalProperties: false }), executionMode: 'parallel',
      execute: async (_id, params, _signal, _update, ctx) => {
        const result = coordinator.inspectNode(caller(ctx.sessionManager.getSessionId(), params.teamId), params.target);
        return text(`${result.node.path} is ${result.node.status}.`, result);
      },
    }),
    defineTool({
      name: 'close_agent', label: 'Close agent', promptSnippet: 'Close an agent node while retaining history',
      description: 'Close a node so it cannot accept future work. Active work is refused unless force is explicit. Close preserves logical history but does not declare capacity released.',
      parameters: Type.Object({ teamId, target, force: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (_id, params, _signal, _update, ctx) => {
        const result = await coordinator.close(caller(ctx.sessionManager.getSessionId(), params.teamId), params.target, params.force === true);
        return text(`Closed ${result.path}; history is retained.`, result);
      },
    }),
    defineTool({
      name: 'release_agent', label: 'Release agent', promptSnippet: 'Release an agent node and free capacity',
      description: 'Release a node after work stops. Release frees sessions, leases, timers, indexes, wait edges, and node capacity. Active work is refused unless force aborts it. Repeated release is safe.',
      parameters: Type.Object({ teamId, target, force: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (_id, params, _signal, _update, ctx) => {
        const result = await coordinator.release(caller(ctx.sessionManager.getSessionId(), params.teamId), params.target, params.force === true);
        return text(`Released ${result.path}; capacity is available.`, result);
      },
    }),
    defineTool({
      name: 'list_agents', label: 'List agents', promptSnippet: 'Inspect the bounded Agent Team V2 tree',
      description: 'List a stable bounded projection of this root-scoped team, optionally below a canonical path prefix.',
      parameters: Type.Object({ teamId, pathPrefix: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) }, { additionalProperties: false }), executionMode: 'parallel',
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const result = coordinator.list(caller(ctx.sessionManager.getSessionId(), params.teamId), params.pathPrefix);
        return text(result.nodes.map((node) => `${'  '.repeat(node.depth)}- ${node.path} · @${node.handle} · ${node.status} · ${node.model.provider}/${node.model.id} · task:${node.currentTaskId ?? 'none'} · unread:${node.unreadMessages}`).join('\n') || 'No agents match that prefix.', result);
      },
    }),
    ...rootLifecycleTools,
  ] as ToolDefinition[];
}
