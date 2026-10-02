import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { MemoryStorage, ToolResultEntry } from '@earendil-works/pi-durable';
import { NativeDurableExecution } from '../../src/main/pi/durable/NativeDurableExecution';
import { bridgeFateTool } from '../../src/main/pi/durable/FateToolBridge';

const model = { provider: 'faux', modelId: 'faux-1' };
function binding(definition: ToolDefinition) {
  // A real context is provided by the host. This synthetic test double throws on
  // every unproven surface rather than pretending there is an SDK AgentSession.
  const ctx = new Proxy({ cwd: '/approved-fixture' }, { get(target, key) {
    if (key === 'then') return undefined;
    if (key === 'cwd') return target.cwd;
    throw new Error(`Unexpected SDK context surface: ${String(key)}`);
  } }) as ExtensionToolContext;
  return { definition, context: async () => ctx };
}

describe('Fate tool to native Harness boundary', () => {
  it('runs the original tool with its bound context, live authority, updates, images and details intact', async () => {
    let permitted = true;
    let effects = 0;
    const tool: ToolDefinition = {
      name: 'approved_write', label: 'Approved write', description: 'Synthetic approved effect', parameters: Type.Object({}),
      execute: async (callId, _args, signal, onUpdate, ctx) => {
        expect(ctx.cwd).toBe('/approved-fixture');
        expect(callId).toBe('first-write');
        expect(signal).toBeInstanceOf(AbortSignal);
        if (!permitted) throw new Error('Permission was revoked');
        effects++;
        onUpdate?.({ content: [{ type: 'text', text: 'Writing' }], details: { stage: 'writing' } });
        return { content: [{ type: 'text', text: 'Receipt' }, { type: 'image', mimeType: 'image/png', data: 'cGl4ZWxz' }], details: { attestationId: 'synthetic-proof' }, structuredContent: { changed: true } };
      },
    };
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage([{ type: 'toolCall', id: 'first-write', name: tool.name, arguments: {} }], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done'),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const execution = await NativeDurableExecution.open({ storage: new MemoryStorage(), models, model, assertOwnership: async () => {}, cwd: '/approved-fixture', systemPrompt: 'Trusted prompt', tools: [binding(tool)], settings: { retry: { enabled: false }, compaction: { enabled: false } } });
    const result = await execution.wait(await execution.submit({ type: 'input', requestId: 'write', content: 'Write' }));
    expect(result.status).toBe('done');
    expect(effects).toBe(1);
    const receipt = (await execution.entries()).items.find((entry) => entry.kind === ToolResultEntry.kind)!;
    const message = receipt.model?.[0];
    expect(message?.role).toBe('toolResult');
    if (message?.role !== 'toolResult') throw new Error('Missing tool result');
    expect(message.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'cGl4ZWxz' });
    expect(message.details).toEqual({ fate: { details: { attestationId: 'synthetic-proof' }, structuredContent: { changed: true } } });
    permitted = false;
    faux.setResponses([
      fauxAssistantMessage([{ type: 'toolCall', id: 'first-write', name: tool.name, arguments: {} }], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Must never run after permission denial'),
    ]);
    await expect(execution.wait(await execution.submit({ type: 'input', requestId: 'revoked', content: 'Write again' }))).rejects.toThrow('unconfirmed outcome');
    expect(effects).toBe(1);
    await execution.close();
  });

  it('refuses unsupported SDK loadout semantics before any native session starts', () => {
    const definition: ToolDefinition = { name: 'dynamic', label: 'Dynamic', description: '', parameters: Type.Object({}), prepareLoadout: () => undefined, execute: async () => ({ content: [], details: {} }) };
    expect(() => bridgeFateTool(binding(definition))).toThrow('loadout hooks');
    expect(() => bridgeFateTool(binding({ ...definition, prepareLoadout: undefined } as unknown as ToolDefinition))).not.toThrow();
  });
});
