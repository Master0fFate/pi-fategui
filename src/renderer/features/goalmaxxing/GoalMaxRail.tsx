import { getFateApi, getFateApiOptional, getWebApiOptional } from '../../platform/api';
import { canMutateNetwork, useRuntimeStore } from '../../stores/runtimeStore';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, CircleAlert, LoaderCircle, Pause, Pencil, Play, Target, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GoalMaxControlInput, GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import { AppTooltip } from '../../components/AppTooltip';
import { SelectControl } from '../../components/SelectControl';
import { selectGoalView, useGoalMaxStore, type GoalView } from '../../stores/goalMaxStore';
import { useUiStore } from '../../stores/uiStore';
import { goalMaxStatusLabel } from './goalMaxPresentation';
import { useSkinComponents } from '../../skins/SkinProvider';
import { draftScopeKey, useScopedDraft } from './scopedDraft';

const resumable = new Set<GoalMaxState['status']>(['paused', 'blocked', 'budget-limited', 'usage-limited', 'failed']);
const terminal = new Set<GoalMaxState['status']>(['completed', 'cancelled']);
type EditableCriterion = { id?: string; title: string; description: string; required: boolean };
type EditorDraft = { objective: string; criteria: EditableCriterion[]; tokenLimit: string; timeMinutes: string;
  verificationLevel: GoalMaxState['verificationLevel'] | ''; agentStrategy: GoalMaxState['agentStrategy'] | '';
  editingRevision: number; tokenDirty: boolean; timeDirty: boolean };
const editorDrafts = new Map<string, EditorDraft>();

function RailStatusIcon({ goal }: { goal: GoalView }) {
  if (goal.status === 'completed') return <Check size={13} aria-hidden="true" />;
  if (goal.status === 'blocked' || goal.status === 'failed' || goal.status === 'budget-limited' || goal.status === 'usage-limited') return <CircleAlert size={13} aria-hidden="true" />;
  if (goal.executionState !== 'idle' || goal.status === 'verifying') return <LoaderCircle size={13} className="tool-spinner" aria-hidden="true" />;
  return <Target size={13} aria-hidden="true" />;
}

export function GoalMaxRail() {
  const { ActionContent, Symbol } = useSkinComponents();
  const source = useRuntimeStore((state) => state.source);
  useRuntimeStore((state) => state.phase);
  const networkBusy = useRuntimeStore((state) => state.networkBusy);
  const web = getWebApiOptional();
  const goal = useGoalMaxStore((state) => selectGoalView(state, source));
  const setGoal = useGoalMaxStore((state) => state.setGoal);
  const openGoalMax = useUiStore((state) => state.openGoalMax);
  const setEditorOpen = useUiStore((state) => state.setGoalEditorOpen);
  const showToast = useUiStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  if (!goal) return null;

  const control = async (input: GoalMaxControlInput) => {
    if (busy) return;
    if (web) { await useRuntimeStore.getState().runNetworkMutation(web, 'goal.control', (scope) => web.controlGoal(scope, input)); return; }
    if (!getFateApiOptional() || typeof getFateApiOptional()?.controlGoalMax !== 'function') return;
    setBusy(true);
    try { setGoal(await getFateApi().controlGoalMax(input)); }
    catch (error) { showToast({ kind: 'error', title: 'Goal control failed', message: error instanceof Error ? error.message : 'The goal could not be changed.' }); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (busy) return;
    if (web) {
      if (await useRuntimeStore.getState().runNetworkMutation(web, 'goal.control', (scope) => web.clearGoal(scope))) setConfirmClear(false);
      return;
    }
    if (!getFateApiOptional() || typeof getFateApiOptional()?.clearGoalMax !== 'function') return;
    setBusy(true);
    try {
      await getFateApi().clearGoalMax();
      setGoal(null);
      setConfirmClear(false);
    } catch (error) {
      showToast({ kind: 'error', title: 'Goal could not be cleared', message: error instanceof Error ? error.message : 'Try again after the current operation settles.' });
    } finally { setBusy(false); }
  };
  const required = goal.criteria.filter((criterion) => criterion.required && criterion.status !== 'waived');
  const satisfied = required.filter((criterion) => criterion.status === 'satisfied').length;
  const unavailable = busy || networkBusy || Boolean(web && !canMutateNetwork(web, 'goal.control'));
  const canPause = goal.status === 'active' || goal.status === 'verifying';
  const canResume = resumable.has(goal.status);
  const railObjective = goal.objective.length > 500 ? `${goal.objective.slice(0, 499).trimEnd()}…` : goal.objective;
  const objectiveTooltip = goal.objective.length > 800 ? `${goal.objective.slice(0, 799).trimEnd()}…` : goal.objective;

  return (
    <>
      <section className="goalmax-rail" data-status={goal.status} aria-label="Current GoalMax goal" aria-live="polite">
        <span className="goalmax-rail-status composer-rail-mark" aria-label={goalMaxStatusLabel(goal.status)}><Symbol text="[g]"><RailStatusIcon goal={goal} /></Symbol></span>
        <AppTooltip content={`${objectiveTooltip}\n${goalMaxStatusLabel(goal.status)} · ${goal.phase} · ${satisfied}/${required.length} required`}>
          <button className="goalmax-rail-objective" type="button" aria-label="Open Goal Flight Deck" onClick={openGoalMax}>
            <strong>{railObjective}</strong>
            <small>{goalMaxStatusLabel(goal.status)}</small>
          </button>
        </AppTooltip>
        <div className="goalmax-rail-actions">
          <AppTooltip content="Edit goal" wrapTrigger><button type="button" aria-label="Edit goal" disabled={unavailable || terminal.has(goal.status)} onClick={() => setEditorOpen(true)}><ActionContent text="edit"><Pencil size={14} /></ActionContent></button></AppTooltip>
          {canPause ? <AppTooltip content="Pause future goal continuations" wrapTrigger><button type="button" aria-label="Pause goal" disabled={unavailable} onClick={() => void control({ action: 'pause' })}><ActionContent text="pause"><Pause size={14} /></ActionContent></button></AppTooltip> : null}
          {canResume ? <AppTooltip content="Resume goal" wrapTrigger><button type="button" aria-label="Resume goal" disabled={unavailable} onClick={() => void control({ action: 'resume' })}><ActionContent text="run"><Play size={14} /></ActionContent></button></AppTooltip> : null}
          <AppTooltip content={terminal.has(goal.status) ? 'Clear goal' : 'Cancel work and clear goal'} wrapTrigger>
            <button type="button" aria-label="Clear goal" disabled={unavailable} onClick={() => terminal.has(goal.status) ? void clear() : setConfirmClear(true)}><ActionContent text={busy ? '~' : 'x'}>{busy ? <LoaderCircle className="tool-spinner" size={14} /> : <X size={14} />}</ActionContent></button>
          </AppTooltip>
        </div>
      </section>
      <GoalMaxEditor key={`${draftScopeKey(web)}:${goal.id}`} goal={goal} />
      <Dialog.Root open={confirmClear} onOpenChange={(open) => { if (!busy && !networkBusy) setConfirmClear(open); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="goalmax-confirm-dialog" aria-describedby="goalmax-clear-description">
            <Dialog.Title>Clear this goal?</Dialog.Title>
            <Dialog.Description id="goalmax-clear-description">Active root and child work will be cancelled. Audit history stays archived.</Dialog.Description>
            <div className="goalmax-dialog-actions"><Dialog.Close disabled={busy || networkBusy}>Keep goal</Dialog.Close><button className="danger-button" type="button" disabled={unavailable} onClick={() => void clear()}>Cancel & clear</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function GoalMaxEditor({ goal }: { goal: GoalView }) {
  const web = getWebApiOptional();
  const desktopGoal = 'budget' in goal ? goal : null;
  useRuntimeStore((state) => state.networkBusy);
  const draftKey = `${draftScopeKey(web)}:${goal.id}`;
  const initialDraft = (): EditorDraft => ({ objective: goal.objective,
    criteria: goal.criteria.map(({ id, title, description, required }) => ({ id, title, description, required })),
    tokenLimit: desktopGoal?.budget.tokenLimit?.toString() ?? '', timeMinutes: desktopGoal?.budget.timeLimitMs ? String(Math.round(desktopGoal.budget.timeLimitMs / 60_000)) : '',
    verificationLevel: desktopGoal?.verificationLevel ?? '', agentStrategy: desktopGoal?.agentStrategy ?? '', editingRevision: goal.revision, tokenDirty: false, timeDirty: false });
  const [draft, setDraft, dropDraft] = useScopedDraft(editorDrafts, draftKey, initialDraft);
  const { objective, criteria, tokenLimit, timeMinutes, verificationLevel, agentStrategy, editingRevision } = draft;
  const setObjective = (objective: string) => setDraft((current) => ({ ...current, objective }));
  const setCriteria = (update: EditableCriterion[] | ((current: EditableCriterion[]) => EditableCriterion[])) => setDraft((current) => ({ ...current, criteria: typeof update === 'function' ? update(current.criteria) : update }));
  const unavailable = Boolean(web && !canMutateNetwork(web, 'goal.control'));
  const { ActionContent } = useSkinComponents();
  const open = useUiStore((state) => state.goalEditorOpen);
  const setOpen = useUiStore((state) => state.setGoalEditorOpen);
  const showToast = useUiStore((state) => state.showToast);
  const setGoal = useGoalMaxStore((state) => state.setGoal);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) { initialized.current = false; return; }
    if (initialized.current) return;
    initialized.current = true;
    if (!editorDrafts.has(draftKey)) setDraft(initialDraft());
    setError(null);
  }, [goal, open]);
  const parsedBudget = useMemo(() => ({
    tokenLimit: tokenLimit.trim() ? Number.parseInt(tokenLimit, 10) : null,
    timeLimitMs: timeMinutes.trim() ? Number.parseInt(timeMinutes, 10) * 60_000 : null,
  }), [timeMinutes, tokenLimit]);
  const save = async () => {
    if (saving || !objective.trim() || criteria.length === 0 || criteria.some((criterion) => !criterion.title.trim())) return;
    if ((parsedBudget.tokenLimit !== null && (!Number.isSafeInteger(parsedBudget.tokenLimit) || parsedBudget.tokenLimit <= 0)) || (parsedBudget.timeLimitMs !== null && (!Number.isSafeInteger(parsedBudget.timeLimitMs) || parsedBudget.timeLimitMs <= 0))) {
      setError('Budgets must be positive whole numbers. Leave a field empty for no limit.');
      return;
    }
    if (web) {
      if (draftScopeKey(web) + ':' + goal.id !== draftKey || goal.revision !== editingRevision) {
        setError('Host goal changed. Your draft is kept. Use the current host goal before applying a different revision.'); return;
      }
      setSaving(true); setError(null);
      const ok = await useRuntimeStore.getState().runNetworkMutation(web, 'goal.control', (scope) => web.updateGoal(scope, {
        expectedRevision: editingRevision, objective: objective.trim(),
        criteria: criteria.map(({ id, title, description, required }) => ({ ...(id ? { id } : {}), title: title.trim(), description: description.trim(), required })),
        ...(draft.tokenDirty ? { tokenLimit: parsedBudget.tokenLimit } : {}), ...(draft.timeDirty ? { timeLimitMs: parsedBudget.timeLimitMs } : {}),
        ...(verificationLevel ? { verificationLevel } : {}), ...(agentStrategy ? { agentStrategy } : {}),
      }));
      if (ok) { dropDraft();
        if (draftScopeKey(web) + ':' + goal.id === draftKey && selectGoalView(useGoalMaxStore.getState(), 'network')?.id === goal.id) setOpen(false);
      } else setError('Goal change was not confirmed. Draft is kept. Review the original command or refresh.');
      setSaving(false); return;
    }
    if (!getFateApiOptional() || typeof getFateApiOptional()?.updateGoalMax !== 'function' || !verificationLevel || !agentStrategy) return;
    setSaving(true); setError(null);
    try {
      const updated = await getFateApi().updateGoalMax({
        expectedRevision: editingRevision,
        objective: objective.trim(),
        criteria: criteria.map(({ id, title, description, required }) => ({
          ...(id ? { id } : {}), title: title.trim(), description: description.trim(), required,
        })),
        tokenLimit: parsedBudget.tokenLimit,
        timeLimitMs: parsedBudget.timeLimitMs,
        verificationLevel,
        agentStrategy,
      });
      setGoal(updated);
      dropDraft(); setOpen(false);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'The goal could not be saved.';
      setError(message);
      showToast({ kind: 'error', title: 'Goal edit failed', message });
    } finally { setSaving(false); }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="goalmax-editor-dialog" aria-describedby="goalmax-editor-description">
          <header><div><Dialog.Title>Edit goal</Dialog.Title><Dialog.Description id="goalmax-editor-description">Update the objective, completion gate, or explicit limits.</Dialog.Description></div><Dialog.Close aria-label="Close goal editor"><ActionContent text="x"><X size={15} /></ActionContent></Dialog.Close></header>
          <label className="goalmax-field"><span>Objective</span><textarea value={objective} maxLength={200_000} rows={6} onChange={(event) => setObjective(event.target.value)} autoFocus /></label>
          <details className="goalmax-criteria-editor">
            <summary>Criteria <span>{criteria.length}</span></summary>
            <div>{criteria.map((criterion, index) => (
              <div className="goalmax-criterion-edit" key={criterion.id ?? index}>
                <input aria-label={`Criterion ${index + 1}`} value={criterion.title} maxLength={240} onChange={(event) => setCriteria((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item))} />
                <button type="button" aria-label={`Remove criterion ${index + 1}`} disabled={criteria.length === 1} onClick={() => setCriteria((current) => current.filter((_item, itemIndex) => itemIndex !== index))}><X size={13} /></button>
              </div>
            ))}<button className="goalmax-add-criterion" type="button" disabled={criteria.length >= 32} onClick={() => setCriteria((current) => [...current, { title: '', description: '', required: true }])}>Add criterion</button></div>
          </details>
          {web && <p>Budgets are not included in this read. Each untouched field preserves its host value. An empty edited field explicitly removes only that limit.</p>}
          <div className="goalmax-budget-fields">
            <label className="goalmax-field"><span>Token limit</span><input inputMode="numeric" placeholder={web ? 'Unchanged' : 'None'} value={tokenLimit} onChange={(event) => setDraft((current) => ({ ...current, tokenDirty: true, tokenLimit: event.target.value.replace(/[^0-9]/gu, '') }))} /></label>
            <label className="goalmax-field"><span>Time · minutes</span><input inputMode="numeric" placeholder={web ? 'Unchanged' : 'None'} value={timeMinutes} onChange={(event) => setDraft((current) => ({ ...current, timeDirty: true, timeMinutes: event.target.value.replace(/[^0-9]/gu, '') }))} /></label>
            <label className="goalmax-field"><span>Verification</span><SelectControl label="Verification level" value={verificationLevel} className="goalmax-verification-select" options={[...(web ? [{ value: '', label: 'Unchanged (host value omitted)' }] : []), { value: 'normal', label: 'Normal' }, { value: 'strict', label: 'Strict' }]} onValueChange={(value) => { if (value === '' || value === 'normal' || value === 'strict') setDraft((current) => ({ ...current, verificationLevel: value })); }} /></label>
            <label className="goalmax-field"><span>Agents</span><SelectControl label="Goal agent strategy" value={agentStrategy} className="goalmax-verification-select" options={[...(web ? [{ value: '', label: 'Unchanged (host value omitted)' }] : []), { value: 'auto', label: 'Auto' }, { value: 'read-only', label: 'Read only' }, { value: 'off', label: 'Off' }]} onValueChange={(value) => { if (value === '' || value === 'auto' || value === 'read-only' || value === 'off') setDraft((current) => ({ ...current, agentStrategy: value })); }} /></label>
          </div>
          {error ? <p className="goalmax-dialog-error" role="alert">{error}</p> : null}
          {web && goal.revision !== editingRevision && <p role="status">The host revision changed; this local draft is not applied.</p>}
          <button type="button" disabled={saving} onClick={() => { setDraft(initialDraft()); setError(null); }}>Use current host goal</button>
          <div className="goalmax-dialog-actions"><Dialog.Close disabled={saving}>Cancel</Dialog.Close><button type="button" disabled={saving || unavailable || !objective.trim()} onClick={() => void save()}>{saving ? <LoaderCircle className="tool-spinner" size={14} /> : null}Save</button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
