import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { MemoryStorage, type Storage, type ToolRegistration } from '@earendil-works/pi-durable';
import { NativeDurableExecution } from '../../src/main/pi/durable/NativeDurableExecution';
import { createNativeChildTool, type NativeChildPolicy } from '../../src/main/pi/durable/NativeChildTool';

const allowed: ToolRegistration = { name: 'parent_capability', description: 'Approved', parameters: Type.Object({}), execute: async () => ({ content: [] }) };
const unavailable: ToolRegistration = { ...allowed, name: 'not_parent_capability' };
function keep(storage: Storage): Storage { return new Proxy(storage, { get(target, key) { if (key === 'close') return async () => {}; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } }); }

describe('native child authority allowlist', () => {
  it.each([null, { remove: [] }, [unavailable], [allowed, allowed]].map((tools) => ({ tools })))('rejects inherited/elevated/duplicate capabilities before child creation: %j', async ({ tools }) => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage([{ type: 'toolCall', id: 'delegate', name: 'fate_delegate', arguments: { task: 'Task' } }], { stopReason: 'toolUse' })]);
    const models = createModels(); models.setProvider(faux.provider);
    const child = createNativeChildTool({ resolve: async () => ({ cwd: '/same', instructions: 'Trusted child', tools }) } as unknown as NativeChildPolicy);
    const storage = new MemoryStorage();
    const execution = await NativeDurableExecution.open({ storage: keep(storage), models, model: { provider: 'faux', modelId: 'faux-1' }, cwd: '/same', systemPrompt: 'Root', nativeTools: [allowed, child], assertOwnership: async () => {}, settings: { compaction: { enabled: false }, retry: { enabled: false } } });
    await expect(execution.wait(await execution.submit({ type: 'input', requestId: 'reject', content: 'Delegate' }))).rejects.toThrow('unconfirmed outcome');
    await execution.close();
    expect((await storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT)).items).toHaveLength(1);
  });

  it.each([[], [allowed]].map((tools) => ({ tools })))('accepts an explicit allowed subset: %j', async ({ tools }) => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([fauxAssistantMessage([{ type: 'toolCall', id: 'delegate', name: 'fate_delegate', arguments: { task: 'Task' } }], { stopReason: 'toolUse' }), fauxAssistantMessage('Child'), fauxAssistantMessage('Parent')]);
    const models = createModels(); models.setProvider(faux.provider);
    const child = createNativeChildTool({ resolve: async () => ({ cwd: '/same', instructions: 'Trusted child', tools }) });
    const execution = await NativeDurableExecution.open({ storage: new MemoryStorage(), models, model: { provider: 'faux', modelId: 'faux-1' }, cwd: '/same', systemPrompt: 'Root', nativeTools: [allowed, child], assertOwnership: async () => {}, settings: { compaction: { enabled: false }, retry: { enabled: false } } });
    expect((await execution.wait(await execution.submit({ type: 'input', requestId: 'accepted', content: 'Delegate' }))).status).toBe('done');
    await execution.close();
  });
});
