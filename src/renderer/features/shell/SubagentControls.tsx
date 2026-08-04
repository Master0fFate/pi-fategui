import { Check, CircleStop, Copy, LoaderCircle, Mailbox, MessageSquarePlus, Pencil, Send, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { RuntimeState, SubagentControlInput, SubagentRun } from '../../../shared/contracts/ipc';
import { subagentDisplayName, subagentHandle } from '../../../shared/subagentIdentity';
import { AppTooltip } from '../../components/AppTooltip';
import { writeClipboardText } from '../../lib/clipboard';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

type EditorMode = 'message' | 'rename' | null;
export type SubagentControlTarget = Pick<SubagentRun, 'id' | 'role' | 'task' | 'handle' | 'displayName' | 'status' | 'mailbox'>;

function applyControlState(origin: RuntimeState, state: RuntimeState): void {
  const current = useRuntimeStore.getState().runtime;
  const selectionIsOrigin = current.sessionId === origin.sessionId && current.project?.path === origin.project?.path;
  const resultIsCurrent = current.sessionId === state.sessionId && current.project?.path === state.project?.path;
  if (selectionIsOrigin || resultIsCurrent) useRuntimeStore.getState().setRuntime(state);
}

export function SubagentControls({ run, compact = false }: { run: SubagentControlTarget; compact?: boolean }) {
  const [mode, setMode] = useState<EditorMode>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<SubagentControlInput['action'] | 'copy' | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const handle = subagentHandle(run);
  const mention = `@${handle}`;
  const active = run.status === 'running' || run.status === 'queued';
  const canSteer = run.status === 'running';
  const canFollowUp = run.mailbox.state === 'available';
  const canMessage = canSteer || canFollowUp;
  const messageAction = canSteer ? 'steer' as const : 'followUp' as const;
  const messageLabel = canSteer ? 'Send instruction' : 'Follow up';

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  const control = async (input: SubagentControlInput) => {
    if (busy || !('piDesktop' in window) || typeof window.piDesktop.controlSubagent !== 'function') return false;
    const origin = useRuntimeStore.getState().runtime;
    setBusy(input.action);
    try {
      const state = await window.piDesktop.controlSubagent(input);
      applyControlState(origin, state);
      return true;
    } catch (error) {
      useUiStore.getState().showToast({
        kind: 'error',
        title: 'Agent control failed',
        message: error instanceof Error ? error.message : 'The child session could not be changed.',
      });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const copyMention = async () => {
    if (busy) return;
    setBusy('copy');
    try {
      await writeClipboardText(mention);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => {
        copiedTimer.current = null;
        setCopied(false);
      }, 1_200);
    } catch {
      useUiStore.getState().showToast({ kind: 'error', title: 'Copy failed', message: 'The system clipboard is unavailable.' });
    } finally {
      setBusy(null);
    }
  };

  const openEditor = (nextMode: Exclude<EditorMode, null>) => {
    setValue(nextMode === 'rename' ? subagentDisplayName(run) : '');
    setMode(nextMode);
  };

  const submitEditor = async () => {
    const clean = value.trim();
    if (!clean || !mode) return;
    const succeeded = mode === 'rename'
      ? await control({ action: 'rename', target: mention, displayName: clean })
      : await control({ action: messageAction, target: mention, message: clean });
    if (succeeded) {
      setMode(null);
      setValue('');
    }
  };

  const editorKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setMode(null);
      setValue('');
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitEditor();
    }
  };

  return (
    <div className={`subagent-controls${compact ? ' subagent-controls--compact' : ''}`}>
      <div className="subagent-control-actions">
        {active ? (
          <AppTooltip content={`Stop ${mention}`}>
            <button
              className="subagent-control-danger"
              type="button"
              aria-label={`Stop ${mention}`}
              disabled={Boolean(busy)}
              onClick={() => void control({ action: 'cancel', target: mention, reason: 'Stopped from the Agents inspector.' })}
            >
              {busy === 'cancel' ? <LoaderCircle className="tool-spinner" size={13} /> : <CircleStop size={13} />}
              {!compact && <span className="icon-label">Stop</span>}
            </button>
          </AppTooltip>
        ) : null}
        {canFollowUp ? (
          <AppTooltip content={`Close ${mention} mailbox`}>
            <button
              type="button"
              aria-label={`Close ${mention} mailbox`}
              disabled={Boolean(busy)}
              onClick={() => void control({ action: 'close', target: mention })}
            >
              {busy === 'close' ? <LoaderCircle className="tool-spinner" size={13} /> : <Mailbox size={13} />}
              {!compact && <span className="icon-label">Close mailbox</span>}
            </button>
          </AppTooltip>
        ) : null}
        {canMessage ? (
          <AppTooltip content={`${messageLabel} ${mention}`}>
            <button type="button" aria-label={`${messageLabel} ${mention}`} disabled={Boolean(busy)} data-active={mode === 'message'} onClick={() => openEditor('message')}>
              <MessageSquarePlus size={13} />{!compact && <span className="icon-label">{messageLabel}</span>}
            </button>
          </AppTooltip>
        ) : null}
        <AppTooltip content={`Copy ${mention}`}>
          <button type="button" aria-label={`Copy ${mention}`} disabled={Boolean(busy)} onClick={() => void copyMention()}>
            {busy === 'copy' || copied ? <Check size={13} /> : <Copy size={13} />}{!compact && <span className="icon-label">Copy mention</span>}
          </button>
        </AppTooltip>
        <AppTooltip content={`Rename ${mention}`}>
          <button type="button" aria-label={`Rename ${mention}`} disabled={Boolean(busy)} data-active={mode === 'rename'} onClick={() => openEditor('rename')}>
            <Pencil size={13} />{!compact && <span className="icon-label">Rename</span>}
          </button>
        </AppTooltip>
      </div>
      {mode ? (
        <div className="subagent-control-editor">
          {mode === 'rename' ? (
            <input
              autoFocus
              aria-label={`Display name for ${mention}`}
              value={value}
              maxLength={80}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={editorKeyDown}
            />
          ) : (
            <textarea
              autoFocus
              aria-label={`${messageLabel} ${mention}`}
              placeholder={canSteer ? 'Adjust the active turn…' : 'Continue this child session…'}
              value={value}
              maxLength={canSteer ? 20_000 : 200_000}
              rows={compact ? 2 : 3}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={editorKeyDown}
            />
          )}
          <button type="button" aria-label={`Cancel ${mode}`} onClick={() => { setMode(null); setValue(''); }}><X size={13} /></button>
          <button type="button" aria-label={mode === 'rename' ? 'Save display name' : messageLabel} disabled={!value.trim() || Boolean(busy)} onClick={() => void submitEditor()}>
            {busy ? <LoaderCircle className="tool-spinner" size={13} /> : mode === 'rename' ? <Check size={13} /> : <Send size={13} />}
          </button>
        </div>
      ) : null}
    </div>
  );
}
