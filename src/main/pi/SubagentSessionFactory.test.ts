import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';
import { type AgentSession, ModelRuntime, defineTool } from '@earendil-works/pi-coding-agent';
import { createSdkChildSession, subagentChildBoundary, usageFromMessages } from './SubagentSessionFactory';

describe('SubagentSessionFactory boundaries', () => {
  it('passes arbitrary role and profile labels without inventing scenario instructions', () => {
    const boundary = subagentChildBoundary('database-migration-specialist', 'project/db-expert', 'edit', ['read', 'grep', 'write']);

    expect(boundary).toContain('Delegated role label: database-migration-specialist');
    expect(boundary).toContain('Agent profile: project/db-expert');
    expect(boundary).toContain('Enforced authority: edit');
    expect(boundary).toContain('perform the edits, commands, and verification directly');
    expect(boundary).toContain('intermediate tool output remain in this child session');
    expect(boundary).toContain('Nested Fate subagent orchestration is unavailable');
    expect(boundary).not.toMatch(/scout|planner|reviewer|implementation plan/iu);
  });

  it('audits observable SDK usage accurately', () => {
    const usage = usageFromMessages([
      { role: 'assistant', usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { total: 0.02 } } },
      { role: 'assistant', usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { total: 0.01 } } },
      { role: 'user', usage: { input: 1_000 } },
    ]);

    expect(usage).toEqual({ input: 15, output: 7, cacheRead: 2, cacheWrite: 1, cost: 0.03, contextTokens: 8, turns: 2 });
  });

  it('registers and activates every Agent Team collaboration tool', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-child-session-test-'));
    let session: AgentSession | undefined;
    try {
      const modelRuntime = await ModelRuntime.create({
        authPath: path.join(projectPath, 'auth.json'),
        modelsPath: null,
      });
      const model = modelRuntime.getModels()[0];
      expect(model).toBeDefined();
      if (!model) throw new Error('Pi SDK test model catalog is empty.');

      const names = ['spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'interrupt_agent', 'list_agents'];
      const collaborationTools = names.map((name) => defineTool({
        name,
        label: name,
        description: `${name} test tool`,
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
      }));

      session = await createSdkChildSession({
        projectPath,
        modelRuntime,
        model,
        thinkingLevel: 'off',
        permissionLevel: 'read-only',
        role: 'test-agent',
        agentName: 'test-agent',
        profileSystemPrompt: '',
        toolNames: ['read'],
        skillMode: 'none',
        selectedSkills: [],
        collaborationTools,
      });

      expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(['read', ...names]));
      for (const tool of collaborationTools) expect(session.getToolDefinition(tool.name)).toBe(tool);
    } finally {
      session?.dispose();
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
