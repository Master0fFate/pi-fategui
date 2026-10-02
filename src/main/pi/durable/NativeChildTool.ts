import { Type } from 'typebox';
import { NativeCapabilityError } from './FateToolBridge';
import { AssistantEntry, configure, defineTool, type AgentChange, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable';

export interface NativeChildPolicy {
  /** Evaluate caller ownership, depth, permission ceiling, selected skills and worktree here. */
  resolve(task: string, api: ToolExecutionApi): Promise<Pick<AgentChange, 'cwd' | 'model' | 'thinkingLevel' | 'instructions'> & { readonly tools: readonly ToolRegistration[] }>;
}

/**
 * Native foreground child scheduling. The owning pi.tool task, child conversation,
 * submission, abort propagation and join are ALL upstream objects, not Fate task mirrors.
 * This is intentionally not the unrestricted upstream example's same-tools delegation.
 */
export function createNativeChildTool(policy: NativeChildPolicy): ToolRegistration {
  return defineTool({
    name: 'fate_delegate',
    description: 'Delegate a self-contained task to an authorized isolated child and collect its result.',
    parameters: Type.Object({ task: Type.String({ minLength: 1 }) }),
    replay: 'unsafe',
    executionMode: 'sequential',
    execute: async (args, api, context) => {
      const agent = await policy.resolve(args.task, api);
      const parent = await api.agent(context);
      if (agent.cwd !== parent.cwd) throw new NativeCapabilityError('child-specific worktree capability rebinding');
      if (typeof agent.instructions !== 'string' || !agent.instructions.trim()) throw new Error('Native child policy must supply the complete trusted child prompt.');
      if (!Array.isArray(agent.tools)) throw new Error('Native child policy must supply an explicit tool allowlist array.');
      const parentTools = new Set(parent.tools.map((tool) => tool.name));
      if (new Set(agent.tools.map((tool) => tool.name)).size !== agent.tools.length || agent.tools.some((tool) => !parentTools.has(tool.name))) {
        throw new Error('Native child tools must be a unique subset of the parent offered capabilities.');
      }
      if (typeof agent.cwd !== 'string' || !agent.cwd) throw new Error('Native child policy must supply an authorized checkout.');
      const childId = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
        await configure(tx, child.id, agent);
        return child.id;
      }, context);
      await api.details({ conversationId: childId }, context);
      const child = await api.conversation(childId, context);
      if (!child) throw new Error('Native child conversation is unavailable.');
      const settled = await (await child.submit({ type: 'input', content: args.task, requestId: `fate-child:${api.taskId}` }, context)).wait(context);
      if (settled.status !== 'done' || settled.type !== 'input') throw new Error(`Native child ${childId} did not complete: ${settled.status}.`);
      const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      const answer = entry?.model?.[0];
      const text = answer?.role === 'assistant' ? answer.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('') : '';
      return { content: [{ type: 'text', text }], details: { conversationId: childId, answerEntryId: settled.answer } };
    },
  });
}
