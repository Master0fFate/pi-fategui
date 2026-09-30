import { getFateApi, getFateApiOptional, getWebApiOptional } from '../../platform/api';
import type { InputOf } from '../../../shared/protocol/methods';
import { CircleStop, LoaderCircle, MessageSquarePlus, Send, Trash2, Unplug, X } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { AgentTeamNode } from '../../../shared/contracts/multiAgent';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useSkinComponents } from '../../skins/SkinProvider';
import { draftScopeKey, useScopedDraft } from '../goalmaxxing/scopedDraft';
const nodeDrafts = new Map<string, string>();
import { canMutateNetwork, useRuntimeStore, type NetworkTeamNode } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

type Mode = 'message' | 'followUp' | null;

type NodeControlInput = Extract<InputOf<'team.control'>, { action: 'message' | 'followUp' | 'interrupt' | 'close' | 'release' | 'resume' }>;
export function AgentTeamControls({ teamId, node }: { teamId: string; node: AgentTeamNode | NetworkTeamNode }) {
  const web = getWebApiOptional();
  const networkBusy = useRuntimeStore((state) => state.networkBusy);
  const label = 'displayName' in node ? node.displayName : node.handle || node.path;
  const originScope = draftScopeKey(web);
  const { ActionContent } = useSkinComponents();
  const [mode, setMode] = useState<Mode>(null);
  const [value, setValue] = useScopedDraft(nodeDrafts, `${draftScopeKey(web)}:team:${teamId}:node:${node.id}:${mode ?? 'message'}`, () => '');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  const active = node.status === 'active' || node.status === 'creating';
  const reusable = node.status === 'ready' || node.status === 'interrupted';

  const unavailable = busy || networkBusy || Boolean(web && !canMutateNetwork(web, 'agent.control'));
  const control = async (input: NodeControlInput) => {
    if (busyRef.current) return false;
    if (web) {
      if (originScope !== draftScopeKey(web)) return false;
      const { operationId, ...named } = input; void operationId; // Wire operation identity is host-owned.
      const ok = await useRuntimeStore.getState().runNetworkMutation(web, 'agent.control', (scope) => web.controlTeam(scope, named));
      if (ok) { setMode(null); setValue(''); }
      return ok;
    }
    if (typeof getFateApiOptional()?.controlAgentTeam !== 'function') return false;
    const origin = useRuntimeStore.getState().runtime;
    busyRef.current = true;
    setBusy(true);
    setControlError(null);
    try {
      const state = await getFateApi().controlAgentTeam(input);
      const current = useRuntimeStore.getState().runtime;
      if (current.sessionId === origin.sessionId && current.project?.path === origin.project?.path) useRuntimeStore.getState().setRuntime(state);
      setMode(null);
      setValue('');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The Agent Team node could not be changed.';
      setControlError(message);
      useUiStore.getState().showToast({ kind: 'error', title: 'Agent Team control failed', message });
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  };
  const submit = () => {
    const message = value.trim();
    if (!message || !mode) return;
    void control({ action: mode, teamId, target: node.id, message, operationId: crypto.randomUUID() });
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setMode(null); setValue(''); }
    else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
  };

  return (
    <div className="subagent-controls subagent-controls--compact">
      <div className="subagent-control-actions">
        {active ? <button type="button" title="Interrupt work and keep the session" className="subagent-control-danger" disabled={unavailable} aria-label={`Interrupt ${node.path} and preserve its session`} onClick={() => void control({ action: 'interrupt', teamId, target: node.id, reason: 'Interrupted from the Agents inspector.', operationId: crypto.randomUUID() })}><ActionContent text={busy ? '~' : 'stop'}>{busy ? <LoaderCircle className="tool-spinner" size={13} /> : <CircleStop size={13} />}</ActionContent></button> : null}
        <button type="button" title="Queue a message. This does not start a task." disabled={unavailable || node.status === 'released'} aria-label={`Queue message to ${node.path}`} data-active={mode === 'message'} onClick={() => setMode(mode === 'message' ? null : 'message')}><ActionContent text="msg"><MessageSquarePlus size={13} /></ActionContent></button>
        {reusable ? <button type="button" title="Create an executable follow-up task" disabled={unavailable} aria-label={`Create follow-up task for ${node.path}`} data-active={mode === 'followUp'} onClick={() => setMode(mode === 'followUp' ? null : 'followUp')}><ActionContent text="task"><Send size={13} /></ActionContent></button> : null}
        {!active && node.status !== 'closed' && node.status !== 'released' ? <button type="button" title="Close future work and keep history" disabled={unavailable} aria-label={`Close ${node.path} and preserve history`} onClick={() => void control({ action: 'close', teamId, target: node.id, operationId: crypto.randomUUID() })}><ActionContent text="close"><Trash2 size={13} /></ActionContent></button> : null}
        {node.status !== 'released' ? <button type="button" title="Release runtime resources and free node capacity" className="subagent-control-danger" disabled={unavailable} aria-label={`Release ${node.path} and free capacity`} onClick={() => {
          if (active) {
            setControlError(null);
            setConfirmingRelease(true);
            return;
          }
          void control({ action: 'release', teamId, target: node.id, force: false, operationId: crypto.randomUUID() });
        }}><ActionContent text="free"><Unplug size={13} /></ActionContent></button> : null}
      </div>
      {confirmingRelease ? <ConfirmDialog
        title={`Release ${label}?`}
        message="Its active task will be cancelled and runtime capacity will be freed."
        confirmLabel="Release node"
        busy={busy}
        error={controlError}
        onCancel={() => setConfirmingRelease(false)}
        onConfirm={() => {
          void control({ action: 'release', teamId, target: node.id, force: true, operationId: crypto.randomUUID() })
            .then((success) => { if (success) setConfirmingRelease(false); });
        }}
      /> : null}
      {mode ? <div className="subagent-control-editor"><textarea autoFocus rows={2} maxLength={32 * 1024} value={value} placeholder={mode === 'message' ? 'Queue information without waking the agent…' : 'Assign a new task using the retained context…'} onChange={(event) => setValue(event.target.value)} onKeyDown={keyDown} /><button type="button" aria-label="Cancel" onClick={() => { setMode(null); setValue(''); }}><ActionContent text="x"><X size={13} /></ActionContent></button><button type="button" aria-label="Send" disabled={unavailable || !value.trim()} onClick={submit}><ActionContent text={busy ? '~' : 'send'}>{busy ? <LoaderCircle className="tool-spinner" size={13} /> : <Send size={13} />}</ActionContent></button></div> : null}
    </div>
  );
}
