import { useEffect, useState } from 'react';
import './learning.css';
import { Brain } from 'lucide-react';
import type { LearningSelection, LearningState } from '../../../shared/contracts/learning';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { learningDraftKey, useLearningStore } from './learningStore';

export function LearningIndicator({ text }: { text: string }) {
  const project = useRuntimeStore((state) => state.runtime.project?.path);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const key = learningDraftKey(project, sessionId);
  const turn = useLearningStore((state) => state.turns[key]);
  const [state, setState] = useState<LearningState | null>(null);
  const [preview, setPreview] = useState<LearningSelection | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const refresh = () => {
      if (!window.piDesktop?.getLearningState) return;
      void window.piDesktop.getLearningState().then((next) => { if (current) setState(next); }).catch(() => { if (current) setState(null); });
    };
    refresh();
    const unsubscribe = window.piDesktop?.onLearningChanged?.(refresh);
    return () => { current = false; unsubscribe?.(); };
  }, [project, sessionId]);
  useEffect(() => {
    let current = true;
    setPreview(null); setError(null);
    if (!state?.enabled || !state.binding || !window.piDesktop?.previewLearningSelection) return;
    const timer = setTimeout(() => {
      void window.piDesktop.previewLearningSelection({ binding: state.binding!, text, pins: turn?.pins.map((pin) => ({ ...pin, scope: pin.scope ?? turn.binding.scope })) ?? [], excluded: turn?.excluded ?? [] }).then((selection) => { if (current) setPreview(selection); }).catch(() => { if (current) setError('Selection changed. Review the selected scope and revisions.'); });
    }, 350);
    return () => { current = false; clearTimeout(timer); };
  }, [state, text, turn]);
  const latest = (state?.recentUse ?? state?.snapshot?.manifests ?? []).filter((item) => item.sessionId === sessionId).at(-1);
  return <div className="learning-indicator">
    <button type="button" aria-label="Learning selection" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Brain size={14} /><span>Learning {state?.enabled ? preview?.selected.length ?? turn?.pins.length ?? 0 : 'off'}</span></button>
    {expanded && <div className="learning-popover" role="region" aria-label="Learning for this turn"><strong>User profile + project memory · next turn preview</strong>{error && <p role="alert">{error}</p>}{!state?.enabled && <p>Memory Learning is off by default. Enable it in Settings.</p>}{state?.enabled && !preview?.selected.length && <p>No lesson matches this task.</p>}
      {preview?.selected.map((item) => <p key={item.revisionId}>{item.scope?.toUpperCase()} · {item.title} — {item.reasons.join('; ')} <button type="button" aria-label={`Remove ${item.title} for this turn`} onClick={() => { if (state?.binding) useLearningStore.getState().setTurn(key, { binding: state.binding, pins: (turn?.pins ?? []).filter((pin) => pin.lessonId !== item.lessonId).map((pin) => ({ ...pin, scope: pin.scope ?? turn!.binding.scope })), excluded: [...new Set([...(turn?.excluded ?? []), item.lessonId])] }); }}>Remove</button></p>)}
      {preview?.skipped.map((item) => <p key={item.lessonId}>{item.reason}</p>)}
      {Boolean(turn?.pins.length) && <button type="button" onClick={() => useLearningStore.getState().clearTurn(key)}>Clear explicit selection</button>}
      {latest && <p>Last actual dispatch: {latest.state} · {latest.items.length} items · {latest.bytes} bytes. Provider receipt is not proven.</p>}
      <button type="button" onClick={() => { setExpanded(false); useLearningStore.getState().show(); }}>Manage lessons, drafts & recent use</button>
    </div>}
  </div>;
}
