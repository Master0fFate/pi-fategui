import { CircleStop, LoaderCircle, MessageSquarePlus, Send, Trash2, X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import type { AgentTeamNode } from '../../../shared/contracts/multiAgent';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

type Mode = 'message' | 'followUp' | null;

export function AgentTeamControls({ node }: { node: AgentTeamNode }) {
  const [mode, setMode] = useState<Mode>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const active = node.status === 'active' || node.status === 'creating';
  const reusable = node.status === 'ready' || node.status === 'interrupted';

  const control = async (input: Parameters<typeof window.piDesktop.controlAgentTeam>[0]) => {
    if (busy || typeof window.piDesktop.controlAgentTeam !== 'function') return;
    const origin = useRuntimeStore.getState().runtime;
    setBusy(true);
    try {
      const state = await window.piDesktop.controlAgentTeam(input);
      const current = useRuntimeStore.getState().runtime;
      if (current.sessionId === origin.sessionId && current.project?.path === origin.project?.path) useRuntimeStore.getState().setRuntime(state);
      setMode(null);
      setValue('');
    } catch (error) {
      useUiStore.getState().showToast({ kind: 'error', title: 'Agent Team control failed', message: error instanceof Error ? error.message : 'The Agent Team node could not be changed.' });
    } finally { setBusy(false); }
  };
  const submit = () => {
    const message = value.trim();
    if (!message || !mode) return;
    void control({ action: mode, target: node.id, message });
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setMode(null); setValue(''); }
    else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
  };

  return (
    <div className="subagent-controls subagent-controls--compact">
      <div className="subagent-control-actions">
        {active ? <button type="button" className="subagent-control-danger" disabled={busy} aria-label={`Interrupt ${node.path}`} onClick={() => void control({ action: 'interrupt', target: node.id, reason: 'Interrupted from the Agents inspector.' })}>{busy ? <LoaderCircle className="tool-spinner" size={13} /> : <CircleStop size={13} />}</button> : null}
        <button type="button" disabled={busy} aria-label={`Message ${node.path}`} data-active={mode === 'message'} onClick={() => setMode(mode === 'message' ? null : 'message')}><MessageSquarePlus size={13} /></button>
        {reusable ? <button type="button" disabled={busy} aria-label={`Follow up ${node.path}`} data-active={mode === 'followUp'} onClick={() => setMode(mode === 'followUp' ? null : 'followUp')}><Send size={13} /></button> : null}
        {!active ? <button type="button" disabled={busy} aria-label={`Close ${node.path}`} onClick={() => void control({ action: 'close', target: node.id })}><Trash2 size={13} /></button> : null}
      </div>
      {mode ? <div className="subagent-control-editor"><textarea autoFocus rows={2} maxLength={32 * 1024} value={value} placeholder={mode === 'message' ? 'Queue information without waking the agent…' : 'Assign a new task using the retained context…'} onChange={(event) => setValue(event.target.value)} onKeyDown={keyDown} /><button type="button" aria-label="Cancel" onClick={() => { setMode(null); setValue(''); }}><X size={13} /></button><button type="button" aria-label="Send" disabled={busy || !value.trim()} onClick={submit}>{busy ? <LoaderCircle className="tool-spinner" size={13} /> : <Send size={13} />}</button></div> : null}
    </div>
  );
}
