import * as Dialog from '@radix-ui/react-dialog';
import { Check, CircleAlert, Info, LoaderCircle, Pause, Pencil, Play, Target, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GoalMaxControlInput, GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import { AppTooltip } from '../../components/AppTooltip';
import { SelectControl } from '../../components/SelectControl';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useUiStore } from '../../stores/uiStore';

const resumable = new Set<GoalMaxState['status']>(['paused', 'blocked', 'budget-limited', 'usage-limited', 'failed']);
const terminal = new Set<GoalMaxState['status']>(['completed', 'cancelled']);
type EditableCriterion = { id?: string; title: string; description: string; required: boolean };

function statusLabel(goal: GoalMaxState): string {
  if (goal.status === 'budget-limited') return 'Budget reached';
  if (goal.status === 'usage-limited') return 'Usage limited';
  return goal.status.charAt(0).toUpperCase() + goal.status.slice(1);
}

function RailStatusIcon({ goal }: { goal: GoalMaxState }) {
  if (goal.status === 'completed') return <Check size={13} aria-hidden="true" />;
  if (goal.status === 'blocked' || goal.status === 'failed' || goal.status === 'budget-limited' || goal.status === 'usage-limited') return <CircleAlert size={13} aria-hidden="true" />;
  if (goal.executionState !== 'idle' || goal.status === 'verifying') return <LoaderCircle size={13} className="tool-spinner" aria-hidden="true" />;
  return <Target size={13} aria-hidden="true" />;
}

export function GoalMaxRail() {
  const goal = useGoalMaxStore((state) => state.goal);
  const setGoal = useGoalMaxStore((state) => state.setGoal);
  const openGoalMax = useUiStore((state) => state.openGoalMax);
  const setEditorOpen = useUiStore((state) => state.setGoalEditorOpen);
  const showToast = useUiStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  if (!goal) return null;

  const control = async (input: GoalMaxControlInput) => {
    if (busy || !('piDesktop' in window) || typeof window.piDesktop.controlGoalMax !== 'function') return;
    setBusy(true);
    try { setGoal(await window.piDesktop.controlGoalMax(input)); }
    catch (error) { showToast({ kind: 'error', title: 'Goal control failed', message: error instanceof Error ? error.message : 'The goal could not be changed.' }); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (busy || !('piDesktop' in window) || typeof window.piDesktop.clearGoalMax !== 'function') return;
    setBusy(true);
    try {
      await window.piDesktop.clearGoalMax();
      setGoal(null);
      setConfirmClear(false);
    } catch (error) {
      showToast({ kind: 'error', title: 'Goal could not be cleared', message: error instanceof Error ? error.message : 'Try again after the current operation settles.' });
    } finally { setBusy(false); }
  };
  const required = goal.criteria.filter((criterion) => criterion.required && criterion.status !== 'waived');
  const satisfied = required.filter((criterion) => criterion.status === 'satisfied').length;
  const canPause = goal.status === 'active';
  const canResume = resumable.has(goal.status);
  const railObjective = goal.objective.length > 500 ? `${goal.objective.slice(0, 499).trimEnd()}…` : goal.objective;
  const objectiveTooltip = goal.objective.length > 800 ? `${goal.objective.slice(0, 799).trimEnd()}…` : goal.objective;

  return (
    <>
      <section className="goalmax-rail" data-status={goal.status} aria-label="Current GoalMax goal" aria-live="polite">
        <span className="goalmax-rail-status"><RailStatusIcon goal={goal} /></span>
        <AppTooltip content={objectiveTooltip}>
          <button className="goalmax-rail-objective" type="button" onClick={openGoalMax}>
            <strong>{railObjective}</strong>
            <small>{statusLabel(goal)} · {goal.phase} · {satisfied}/{required.length}</small>
          </button>
        </AppTooltip>
        <div className="goalmax-rail-actions">
          <AppTooltip content="Open Goal Flight Deck" wrapTrigger><button type="button" aria-label="Open Goal Flight Deck" onClick={openGoalMax}><Info size={14} /></button></AppTooltip>
          <AppTooltip content="Edit goal" wrapTrigger><button type="button" aria-label="Edit goal" disabled={busy || terminal.has(goal.status)} onClick={() => setEditorOpen(true)}><Pencil size={14} /></button></AppTooltip>
          {canPause ? <AppTooltip content="Pause future goal continuations" wrapTrigger><button type="button" aria-label="Pause goal" disabled={busy} onClick={() => void control({ action: 'pause' })}><Pause size={14} /></button></AppTooltip> : null}
          {canResume ? <AppTooltip content="Resume goal" wrapTrigger><button type="button" aria-label="Resume goal" disabled={busy} onClick={() => void control({ action: 'resume' })}><Play size={14} /></button></AppTooltip> : null}
          <AppTooltip content={terminal.has(goal.status) ? 'Clear goal' : 'Cancel work and clear goal'} wrapTrigger>
            <button type="button" aria-label="Clear goal" disabled={busy} onClick={() => terminal.has(goal.status) ? void clear() : setConfirmClear(true)}>{busy ? <LoaderCircle className="tool-spinner" size={14} /> : <X size={14} />}</button>
          </AppTooltip>
        </div>
      </section>
      <GoalMaxEditor goal={goal} />
      <Dialog.Root open={confirmClear} onOpenChange={(open) => { if (!busy) setConfirmClear(open); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="goalmax-confirm-dialog" aria-describedby="goalmax-clear-description">
            <Dialog.Title>Clear this goal?</Dialog.Title>
            <Dialog.Description id="goalmax-clear-description">Active root and child work will be cancelled. Audit history stays archived.</Dialog.Description>
            <div className="goalmax-dialog-actions"><Dialog.Close disabled={busy}>Keep goal</Dialog.Close><button className="danger-button" type="button" disabled={busy} onClick={() => void clear()}>Cancel & clear</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function GoalMaxEditor({ goal }: { goal: GoalMaxState }) {
  const open = useUiStore((state) => state.goalEditorOpen);
  const setOpen = useUiStore((state) => state.setGoalEditorOpen);
  const showToast = useUiStore((state) => state.showToast);
  const setGoal = useGoalMaxStore((state) => state.setGoal);
  const [objective, setObjective] = useState(goal.objective);
  const [criteria, setCriteria] = useState<EditableCriterion[]>(() => goal.criteria.map(({ id, title, description, required }) => ({ id, title, description, required })));
  const [tokenLimit, setTokenLimit] = useState(goal.budget.tokenLimit?.toString() ?? '');
  const [timeMinutes, setTimeMinutes] = useState(goal.budget.timeLimitMs ? String(Math.round(goal.budget.timeLimitMs / 60_000)) : '');
  const [verificationLevel, setVerificationLevel] = useState(goal.verificationLevel);
  const [agentStrategy, setAgentStrategy] = useState(goal.agentStrategy);
  const [editingRevision, setEditingRevision] = useState(goal.revision);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) { initialized.current = false; return; }
    if (initialized.current) return;
    initialized.current = true;
    setObjective(goal.objective);
    setCriteria(goal.criteria.map(({ id, title, description, required }) => ({ id, title, description, required })));
    setTokenLimit(goal.budget.tokenLimit?.toString() ?? '');
    setTimeMinutes(goal.budget.timeLimitMs ? String(Math.round(goal.budget.timeLimitMs / 60_000)) : '');
    setVerificationLevel(goal.verificationLevel);
    setAgentStrategy(goal.agentStrategy);
    setEditingRevision(goal.revision);
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
    if (!('piDesktop' in window) || typeof window.piDesktop.updateGoalMax !== 'function') return;
    setSaving(true); setError(null);
    try {
      const updated = await window.piDesktop.updateGoalMax({
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
      setOpen(false);
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
          <header><div><Dialog.Title>Edit goal</Dialog.Title><Dialog.Description id="goalmax-editor-description">Update the objective, completion gate, or explicit limits.</Dialog.Description></div><Dialog.Close aria-label="Close goal editor"><X size={15} /></Dialog.Close></header>
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
          <div className="goalmax-budget-fields">
            <label className="goalmax-field"><span>Token limit</span><input inputMode="numeric" placeholder="None" value={tokenLimit} onChange={(event) => setTokenLimit(event.target.value.replace(/[^0-9]/gu, ''))} /></label>
            <label className="goalmax-field"><span>Time · minutes</span><input inputMode="numeric" placeholder="None" value={timeMinutes} onChange={(event) => setTimeMinutes(event.target.value.replace(/[^0-9]/gu, ''))} /></label>
            <label className="goalmax-field"><span>Verification</span><SelectControl label="Verification level" value={verificationLevel} className="goalmax-verification-select" options={[{ value: 'normal', label: 'Normal' }, { value: 'strict', label: 'Strict' }]} onValueChange={(value) => setVerificationLevel(value as GoalMaxState['verificationLevel'])} /></label>
            <label className="goalmax-field"><span>Agents</span><SelectControl label="Goal agent strategy" value={agentStrategy} className="goalmax-verification-select" options={[{ value: 'auto', label: 'Auto' }, { value: 'read-only', label: 'Read only' }, { value: 'off', label: 'Off' }]} onValueChange={(value) => setAgentStrategy(value as GoalMaxState['agentStrategy'])} /></label>
          </div>
          {error ? <p className="goalmax-dialog-error" role="alert">{error}</p> : null}
          <div className="goalmax-dialog-actions"><Dialog.Close disabled={saving}>Cancel</Dialog.Close><button type="button" disabled={saving || !objective.trim()} onClick={() => void save()}>{saving ? <LoaderCircle className="tool-spinner" size={14} /> : null}Save</button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
