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
const workspace = Type.Object({
  mode: enumString(['shared', 'worktree'], 'shared inherits the caller checkout; worktree creates a managed isolated checkout.'),
  baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  branch: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
}, { additionalProperties: false });
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
  workspace: Type.Optional(workspace),
}, { additionalProperties: false });

function text(content: string, details: unknown) {
  return { content: [{ type: 'text' as const, text: content }], details };
}

function workspacePolicyContent(policy: ReturnType<AgentTeamCoordinator['getWorkspacePolicy']>): string {
  return `${policy.explanation}\n${JSON.stringify({ preferredMode: policy.preferredMode, strict: policy.strict })}`;
}

function workspaceResultContent(operation: string, result: unknown): string {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, 'utf8') <= 48 * 1024) return `Workspace ${operation} completed:\n${serialized}`;
  if (operation === 'review' && result && typeof result === 'object') {
    const review = result as { sourceHead?: unknown; targetHead?: unknown; targetBranch?: unknown; dirty?: unknown; targetDirty?: unknown };
    return `Workspace review is too large for model context and remains blocked from integration until a fresh bounded review is performed in the UI or locally:\n${JSON.stringify({ sourceHead: review.sourceHead, targetHead: review.targetHead, targetBranch: review.targetBranch, dirty: review.dirty, targetDirty: review.targetDirty, truncated: true, diff: '[omitted from model context]' })}`;
  }
  return `Workspace ${operation} completed, but its result exceeds the model-visible output bound. Inspect it in the UI or locally.`;
}

export function createAgentCollaborationTools(
  coordinator: AgentTeamCoordinator,
  callerNodeId: string | null,
  modelRuntime: ModelRuntime,
): ToolDefinition[] {
  const caller = (sessionId: string, requestedTeamId?: string) => callerNodeId ?? coordinator.rootNodeId(sessionId, requestedTeamId);
  const workspacePolicyTool = defineTool({
    name: 'get_agent_workspace_policy', label: 'Get Agent workspace policy', promptSnippet: 'Inspect the current global Agent workspace policy',
    description: 'Read the live global preference for future Agent Team executable admissions. Omitted spawn workspace uses preferredMode; strict policy rejects incompatible requested modes. Change it only in Settings > Agent.',
    parameters: Type.Object({}, { additionalProperties: false }), executionMode: 'parallel',
    execute: async () => {
      const policy = coordinator.getWorkspacePolicy();
      return text(workspacePolicyContent(policy), policy);
    },
  });
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
    workspacePolicyTool,
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
      description: 'Create a direct child in the current agent tree and start its initial task. Omit workspace to use the live global preference; an explicit mode overrides only when global strict mode is off. Worktrees are not security sandboxes. Depth, total nodes, active turns, authority, context, and per-checkout writer leases are enforced atomically.',
      promptGuidelines: ['Delegate one bounded outcome.', 'Omit workspace to use the global preference. When policy is soft, shared children inherit the caller checkout and isolated worktrees require parent review; strict policy rejects an incompatible explicit mode.', 'Worktrees start from committed files; uncommitted parent changes stay behind. Choose shared explicitly if the task needs those files and strict policy permits it.', 'Capacity errors are explicit; wait for existing work and retry.'],
      parameters: spawnParameters, executionMode: 'sequential',
      execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
        const receipt = await coordinator.spawn(caller(ctx.sessionManager.getSessionId(), params.teamId), params, toolCallId, modelRuntime, signal);
        const workspaceDetails = receipt.workspace ? ` workspace=${receipt.workspace.mode} path=${receipt.workspace.path}${receipt.workspace.branch ? ` branch=${receipt.workspace.branch}` : ''}` : '';
        return text(`Spawned @${receipt.handle} at ${receipt.path} (${receipt.status}).${workspaceDetails}`, {
          ...receipt, kind: 'fate-agent-team-spawn', version: 1,
        });
      },
    }),
    defineTool({
      name: 'agent_workspace', label: 'Review or integrate agent workspace', promptSnippet: 'Review/checkpoint/integrate/cleanup an owned child workspace',
      description: 'Parent-owned workspace operations. Review is required before explicit integration; checkpoint creates no automatic integration; cleanup keeps the branch and is never forced.',
      parameters: Type.Object({ teamId, target, operation: enumString(['review', 'checkpoint', 'integrate', 'cleanup'], 'Workspace operation.'), message: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })), strategy: Type.Optional(enumString(['ff-only', 'cherry-pick'], 'Integration strategy.')), commits: Type.Optional(Type.Array(Type.String({ minLength: 40, maxLength: 64 }), { minItems: 1, maxItems: 128 })), expectedSourceHead: Type.Optional(Type.String({ minLength: 40, maxLength: 64 })), expectedTargetHead: Type.Optional(Type.String({ minLength: 40, maxLength: 64 })) }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (_id, params, _signal, _update, ctx) => {
        const result = await coordinator.workspace(caller(ctx.sessionManager.getSessionId(), params.teamId), params.target, params.operation as 'review' | 'checkpoint' | 'integrate' | 'cleanup', { ...(params.message ? { message: params.message } : {}), ...(params.strategy === 'ff-only' || params.strategy === 'cherry-pick' ? { strategy: params.strategy } : {}), ...(params.commits ? { commits: params.commits } : {}), ...(params.expectedSourceHead ? { expectedSourceHead: params.expectedSourceHead } : {}), ...(params.expectedTargetHead ? { expectedTargetHead: params.expectedTargetHead } : {}), ...(params.operation === 'review' ? { modelVisibleReviewBytes: 48 * 1024 } : {}) });
        return text(workspaceResultContent(params.operation, result), result);
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
        return text(`Follow-up ${receipt.taskId} for ${receipt.path} is ${receipt.status}.`, receipt);
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
      name: 'list_agents', label: 'List agents', promptSnippet: 'Inspect the bounded agent tree',
      description: 'List a stable bounded projection of this root-scoped team, optionally below a canonical path prefix.',
      parameters: Type.Object({ teamId, pathPrefix: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) }, { additionalProperties: false }), executionMode: 'parallel',
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const result = coordinator.list(caller(ctx.sessionManager.getSessionId(), params.teamId), params.pathPrefix);
        return text(result.nodes.map((node) => `${'  '.repeat(node.depth)}- ${node.path} · @${node.handle} · ${node.status} · ${node.model.provider}/${node.model.id} · task:${node.currentTaskId ?? 'none'} · unread:${node.unreadMessages}`).join('\n') || 'No agents match that prefix.', result);
      },
    }),
    ...(callerNodeId ? [workspacePolicyTool] : []),
    ...rootLifecycleTools,
  ] as ToolDefinition[];
}
