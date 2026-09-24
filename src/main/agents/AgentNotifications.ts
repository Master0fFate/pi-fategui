import { BrowserWindow, Notification } from 'electron';
import { agentChannels, agentChangedSchema } from '../../shared/contracts/agents';
import type { AgentChange } from './AgentsService';

export function notifyAgentRun(change: AgentChange, enabled: boolean): boolean {
  if (!enabled || !Notification.isSupported()) return false;
  const event = agentChangedSchema.parse(change);
  try {
    const notification = new Notification({ title: 'Fate UI · Agents', body: event.message ?? 'An Agent run needs attention.' });
    notification.on('click', () => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (!window) return;
      window.show();
      window.focus();
      window.webContents.send(agentChannels.agentsChanged, { ...event, focus: true });
    });
    notification.show();
    return true;
  } catch {
    // OS notification availability never changes the durable execution outcome.
    return false;
  }
}
