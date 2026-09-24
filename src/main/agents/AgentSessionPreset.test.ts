import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { agentSessionPermission, bindAgentSessionPreset, filterAgentSessionTools, readAgentSessionPreset, SAVED_AGENT_SESSION_TYPE } from './AgentSessionPreset';
import type { SavedAgentSession } from '../../shared/contracts/agents';

export const presetFixture: SavedAgentSession = { schemaVersion: 1, agentId: 'a392d8b9-76cc-4158-a381-1151ccf818fb', revision: 1, name: 'Reviewer', instructions: 'System only.', skillRefs: [], defaults: { model: { provider: 'test', id: 'model' }, permission: 'read-only', thinkingLevel: 'high', workspace: 'shared' }, background: false, runId: null, projectPath: '/project' };
describe('saved Agent session restoration boundaries', () => {
  it('rejects ambiguous or malformed ownership instead of silently adopting a persona', () => {
    const entry = { type: 'custom', customType: SAVED_AGENT_SESSION_TYPE, data: presetFixture };
    expect(readAgentSessionPreset({ getEntries: () => [entry] })).toEqual(presetFixture);
    expect(() => readAgentSessionPreset({ getEntries: () => [entry, entry] })).toThrow(/ambiguous/);
    expect(() => readAgentSessionPreset({ getEntries: () => [{ ...entry, data: { ...presetFixture, defaults: { ...presetFixture.defaults, permission: 'full-access' } } }] })).toThrow();
    expect(readAgentSessionPreset({ getEntries: () => [{ type: 'message', message: { role: 'user', content: 'persona' } }] })).toBeNull();
  });
  it('prevents generic root tool activation from regranting removed effects', () => {
    const session = {} as AgentSession;
    bindAgentSessionPreset(session, presetFixture, ['read']);
    expect(agentSessionPermission(session, 'full-access')).toBe('read-only');
    expect(filterAgentSessionTools(session, ['read', 'write', 'bash', 'generate_image', 'browser_click'])).toEqual(['read']);
  });
  it('opens saved background run histories read-only, without replaying approval authority', () => {
    const session = {} as AgentSession;
    bindAgentSessionPreset(session, { ...presetFixture, background: true, defaults: { ...presetFixture.defaults, permission: 'edit' } }, ['read']);
    expect(agentSessionPermission(session, 'edit')).toBe('read-only');
  });
});
