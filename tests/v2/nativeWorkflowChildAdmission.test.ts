import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Type } from 'typebox';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { ModelRuntime, type AgentSession, type ExtensionToolContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createSdkChildSession } from '../../src/main/pi/SubagentSessionFactory';
import { createProjectConfinedTools, type ProjectToolAccess } from '../../src/main/pi/PiToolPolicy';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function project() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-native-child-admission-')); roots.push(root); return root; }
function held() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe('actual SDK child and retained capability host admission', () => {
  it('fences an already-running SDK child before its next model request and rejects retained tools/queued input', async () => {
    const root = await project();
    const gate = held();
    let fenced = false;
    let entered = false;
    let providerCalls = 0;
    const assertAdmission = () => { if (fenced) throw new Error('Native host safety fence'); };
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([
      () => { providerCalls++; return fauxAssistantMessage([{ type: 'toolCall', id: 'held-call', name: 'held_effect', arguments: {} }], { stopReason: 'toolUse' }); },
      () => { providerCalls++; return fauxAssistantMessage('Must never be requested after the fence'); },
    ]);
    const models = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null, modelsStorePath: path.join(root, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
    models.registerNativeProvider(faux.provider);
    const tool: ToolDefinition = { name: 'held_effect', label: 'Held effect', description: 'Synthetic existing in-flight work', parameters: Type.Object({}), execute: async () => { entered = true; await gate.promise; return { content: [{ type: 'text', text: 'Original operation settled' }], details: {} }; } };
    let session: AgentSession | undefined;
    try {
      session = await createSdkChildSession({ projectPath: root, agentDir: path.join(root, 'agent'), serverProfile: true, approvedSkills: [], modelRuntime: models, model: models.getModel('faux', 'faux-1')!, thinkingLevel: 'off', permissionLevel: 'read-only', role: 'test', agentName: 'direct', profileSystemPrompt: '', toolNames: ['read', 'generate_image'], skillMode: 'none', selectedSkills: [], collaborationTools: [tool], assertExecutionAdmission: assertAdmission });
      const retainedRead = session.getToolDefinition('read')!;
      const retainedImage = session.getToolDefinition('generate_image')!;
      const prompt = session.prompt('Run the held effect').catch(() => {});
      await expect.poll(() => entered).toBe(true);
      fenced = true;
      await expect(session.followUp('New follow-up')).rejects.toThrow('safety fence');
      await expect(session.steer('New steering')).rejects.toThrow('safety fence');
      await expect(session.compact()).rejects.toThrow('safety fence');
      await expect(session.prompt('New prompt')).rejects.toThrow('safety fence');
      await expect(retainedRead.execute('retained-read', { path: 'must-not-read' }, undefined, undefined, {} as ExtensionToolContext)).rejects.toThrow('safety fence');
      await expect(retainedImage.execute('retained-image', { prompt: 'No provider dispatch' }, undefined, undefined, {} as ExtensionToolContext)).rejects.toThrow('safety fence');
      gate.resolve();
      await prompt;
      expect(providerCalls).toBe(1);
      await session.abort(); // Stopping remains available even after admission is fenced.
    } finally { gate.resolve(); session?.dispose(); }
  });

  it('blocks retained controlled root read/search/image capabilities independently of the read-only permission level', async () => {
    const root = await project();
    await fs.writeFile(path.join(root, 'example.txt'), 'fixture');
    let fenced = false;
    const access: ProjectToolAccess = { fullAccess: false, permissionLevel: 'read-only', assertExecutionAdmission: () => { if (fenced) throw new Error('Host is fenced'); } };
    const tools = await createProjectConfinedTools(root, access, [], { searchTools: true });
    fenced = true;
    for (const name of ['read', 'ls', 'grep', 'find', 'generate_image']) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      await expect(tool.execute('retained', {} as never, undefined, undefined, {} as ExtensionToolContext)).rejects.toThrow('Host is fenced');
    }
    expect(await fs.readFile(path.join(root, 'example.txt'), 'utf8')).toBe('fixture');
  });
});
