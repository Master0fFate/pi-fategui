import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { savedAgentSessionSchema, type SavedAgentSession } from '../../shared/contracts/agents';
import type { PermissionLevel } from '../../shared/contracts/ipc';

export const SAVED_AGENT_SESSION_TYPE = 'fate-saved-agent-v1';
const presets = new WeakMap<AgentSession, SavedAgentSession>();
const allowed = new WeakMap<AgentSession, ReadonlySet<string>>();
export function readAgentSessionPreset(manager: { getEntries(): readonly unknown[] }): SavedAgentSession | null {
  const entries = manager.getEntries().filter((entry): entry is { type: string; customType: string; data: unknown } => Boolean(entry && typeof entry === 'object' && 'type' in entry && entry.type === 'custom' && 'customType' in entry && entry.customType === SAVED_AGENT_SESSION_TYPE));
  if (!entries.length) return null;
  if (entries.length !== 1) throw new Error('Saved Agent session has ambiguous ownership.');
  return savedAgentSessionSchema.parse(entries[0]!.data);
}
export function bindAgentSessionPreset(session: AgentSession, preset: SavedAgentSession, toolNames: readonly string[]): void {
  presets.set(session, preset);
  allowed.set(session, new Set(toolNames));
}
export const getAgentSessionPreset = (session: AgentSession): SavedAgentSession | undefined => presets.get(session);
export function agentSessionPermission(session: AgentSession, requested: PermissionLevel): PermissionLevel {
  const preset = presets.get(session);
  if (!preset) return requested;
  return requested === 'read-only' || preset.background || preset.defaults.permission === 'read-only' ? 'read-only' : 'edit';
}
export function filterAgentSessionTools(session: AgentSession, names: readonly string[]): string[] {
  const permitted = allowed.get(session);
  return permitted ? names.filter((name) => permitted.has(name)) : [...names];
}
