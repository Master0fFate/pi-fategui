import { Type } from 'typebox';
import { defineTool, type ModelRuntime, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentTeamCoordinator } from './AgentTeamCoordinator';
import { childToolNames, modelSelectionSchema, permissions, thinkingLevels } from '../SubagentProtocol';

function enumString(values: readonly string[], description: string) {
  return Type.Unsafe<string>({ type: 'string', enum: values, description });
}

const target = Type.String({ minLength: 1, maxLength: 512, description: 'Same-team target by immutable node ID, canonical path, or stable @handle.' });
const message = Type.String({ minLength: 1, maxLength: 32 * 1024 });
const spawnParameters = Type.Object({
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
  const caller = (sessionId: string) => callerNodeId ?? coordinator.rootNodeId(sessionId);
  return [
    defineTool({
      name: 'spawn_agent', label: 'Spawn agent', promptSnippet: 'Create one direct child agent',
      description: 'Create a direct child in the current Agent Team V2 tree and start its initial task. Depth, total nodes, active turns, authority, context, and the single-writer lease are enforced atomically.',
      promptGuidelines: ['Delegate one bounded outcome.', 'Children share the project tree. Only one write-capable child turn may run at once.', 'Capacity errors are explicit; wait for existing work and retry.'],
      parameters: spawnParameters, executionMode: 'sequential',
      execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
        const receipt = await coordinator.spawn(caller(ctx.sessionManager.getSessionId()), params, toolCallId, modelRuntime, signal);
        return text(`Spawned @${receipt.handle} at ${receipt.path} (${receipt.status}).`, receipt);
      },
    }),
    defineTool({
      name: 'send_message', label: 'Send agent message', promptSnippet: 'Queue information for a team agent',
      description: 'Persist and deliver bounded information to another same-team agent without waking an otherwise idle agent.',
      parameters: Type.Object({ target, message }, { additionalProperties: false }), executionMode: 'parallel',
      execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
        const receipt = await coordinator.sendMessage(caller(ctx.sessionManager.getSessionId()), params.target, params.message, toolCallId);
        return text(`Message ${receipt.envelopeId} is ${receipt.state}.`, receipt);
      },
    }),
    defineTool({
      name: 'followup_task', label: 'Follow-up task', promptSnippet: 'Assign executable work to a direct child',
      description: 'Create a new persisted task for an owned direct child. An idle/interrupted child is resumed with its existing Pi context.',
      parameters: Type.Object({ target, task: message }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
        const receipt = await coordinator.followUp(caller(ctx.sessionManager.getSessionId()), params.target, params.task, toolCallId, modelRuntime, signal);
        return text(`Follow-up ${receipt.taskId} assigned to ${receipt.path}.`, receipt);
      },
    }),
    defineTool({
      name: 'wait_agent', label: 'Wait for agents', promptSnippet: 'Wait for bounded team activity',
      description: 'Wait for mailbox activity or direct-child state changes. It returns changed paths; message content is delivered separately as typed context.',
      parameters: Type.Object({
        targets: Type.Array(target, { minItems: 1, maxItems: 16 }),
        timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 300, default: 30 })),
      }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const result = await coordinator.wait(caller(ctx.sessionManager.getSessionId()), params.targets, (params.timeoutSeconds ?? 30) * 1_000, signal);
        return text(result.changed.length ? `Changed agents:\n${result.changed.map((item) => `- ${item.path}: ${item.reason}`).join('\n')}` : 'No matching agent activity before timeout.', result);
      },
    }),
    defineTool({
      name: 'interrupt_agent', label: 'Interrupt agent', promptSnippet: 'Interrupt an owned descendant turn',
      description: 'Abort an active owned descendant turn while preserving its persistent session for later follow-up.',
      parameters: Type.Object({ target, reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })) }, { additionalProperties: false }), executionMode: 'sequential',
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const result = await coordinator.interrupt(caller(ctx.sessionManager.getSessionId()), params.target, params.reason);
        return text(`Interrupted ${result.path}; its session remains reusable.`, result);
      },
    }),
    defineTool({
      name: 'list_agents', label: 'List agents', promptSnippet: 'Inspect the bounded Agent Team V2 tree',
      description: 'List a stable bounded projection of this root-scoped team, optionally below a canonical path prefix.',
      parameters: Type.Object({ pathPrefix: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) }, { additionalProperties: false }), executionMode: 'parallel',
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const result = coordinator.list(caller(ctx.sessionManager.getSessionId()), params.pathPrefix);
        return text(result.nodes.map((node) => `${'  '.repeat(node.depth)}- ${node.path} · @${node.handle} · ${node.status} · ${node.model.provider}/${node.model.id} · task:${node.currentTaskId ?? 'none'} · unread:${node.unreadMessages}`).join('\n') || 'No agents match that prefix.', result);
      },
    }),
  ] as ToolDefinition[];
}
