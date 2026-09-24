import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState } from 'react';
import { agentDraftSchema, taskTemplateDraftSchema, routineDraftSchema, type AgentDefinition, type AgentDraft, type AgentLibrary, type RoutineDefinition, type TaskTemplate } from '../../../shared/contracts/agents';
import type { z } from 'zod';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SelectControl } from '../../components/SelectControl';
import { useSkinComponents } from '../../skins/SkinProvider';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { agentError } from '../../stores/agentsStore';

type TaskDraft = z.infer<typeof taskTemplateDraftSchema>;
type RoutineDraft = z.infer<typeof routineDraftSchema>;
export type LibraryDraft = AgentDraft | TaskDraft | RoutineDraft;
export type LibraryKind = 'agent' | 'task' | 'routine';
export type LibraryDefinition = AgentDefinition | TaskTemplate | RoutineDefinition;
export function initialLibraryDraft(kind: LibraryKind, item?: LibraryDefinition): LibraryDraft {
  if (kind === 'agent') {
    const agent = item as AgentDefinition | undefined;
    return { scope: agent?.scope ?? 'project', name: agent?.name ?? '', description: agent?.description ?? '', instructions: agent?.instructions ?? '', skillRefs: agent?.skillRefs ?? [], enabled: agent?.enabled ?? true,
      defaults: agent?.defaults ?? { model: null, thinkingLevel: 'high', permission: 'read-only', workspace: 'shared' } };
  }
  if (kind === 'task') {
    const task = item as TaskTemplate | undefined;
    return { scope: task?.scope ?? 'project', name: task?.name ?? '', prompt: task?.prompt ?? '', permissionCeiling: task?.permissionCeiling ?? 'read-only', enabled: task?.enabled ?? true };
  }
  const routine = item as RoutineDefinition | undefined;
  return { name: routine?.name ?? '', agentId: routine?.agentId ?? '', taskTemplateId: routine?.taskTemplateId ?? '', intervalMinutes: routine?.intervalMinutes ?? 60, timeZone: routine?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    permissionCeiling: routine?.permissionCeiling ?? 'read-only', enabled: routine?.enabled ?? false, notify: routine?.notify ?? true, osNotify: routine?.osNotify ?? false };
}
const titles = { agent: 'Agent', task: 'TaskTemplate', routine: 'Routine' };
export function AgentLibraryEditor({ kind, item, library, busy, onSave, onClose }: {
  kind: LibraryKind; item?: LibraryDefinition | undefined; library: AgentLibrary; busy: boolean;
  onSave: (draft: LibraryDraft) => Promise<void>; onClose: () => void;
}) {
  const { ActionContent } = useSkinComponents();
  const models = useRuntimeStore((state) => state.runtime.models);
  const [initial] = useState(() => initialLibraryDraft(kind, item));
  const [draft, setDraft] = useState<LibraryDraft>(initial);
  const [skillsText, setSkillsText] = useState('skillRefs' in initial ? initial.skillRefs.join(', ') : '');
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const close = () => { if (busy) return; if (dirty) setConfirmClose(true); else onClose(); };
  const patch = (values: Partial<LibraryDraft>) => setDraft((current) => ({ ...current, ...values }));
  const save = async () => {
    try {
      const parsed = kind === 'agent' ? agentDraftSchema.parse(draft) : kind === 'task' ? taskTemplateDraftSchema.parse(draft) : routineDraftSchema.parse(draft);
      setError(null);
      await onSave(parsed);
      onClose();
    } catch (error) { setError(agentError(error)); }
  };
  return <>
    <Dialog.Root open onOpenChange={(open) => { if (!open) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="agent-library-dialog" onInteractOutside={(event) => { event.preventDefault(); close(); }} onEscapeKeyDown={(event) => { event.preventDefault(); close(); }}>
          <header><Dialog.Title>{item ? 'Edit' : 'New'} {titles[kind]}</Dialog.Title><div className="agent-editor-header-actions"><label className="agent-editor-enabled" title={kind === 'routine' ? 'Enabled routines are scheduled; turn this off to pause it.' : `Enabled ${titles[kind]} definitions can be selected and used; turn this off to keep it saved but unavailable.`}><span>{draft.enabled ? 'Enabled' : 'Disabled'}</span><input type="checkbox" role="switch" aria-label={`${titles[kind]} enabled`} checked={draft.enabled} disabled={busy} onChange={(event) => patch({ enabled: event.target.checked })} /></label><button type="button" className="agent-quiet-action agent-editor-close" aria-label="Close Agent editor" title="Close" disabled={busy} onClick={close}><ActionContent text="x"><X size={15} aria-hidden="true" /></ActionContent></button></div></header>
          <Dialog.Description>{kind === 'agent' ? 'A saved specialist for chat and tasks. New chats use the current instructions; existing home chats keep their original instructions.' : kind === 'task' ? 'A reusable request. Select an enabled Agent when you run it. This prompt is sent as user text, not system instructions.' : 'Runs while Fate UI is open. Missed or overlapping runs are skipped; failed runs do not retry automatically.'}</Dialog.Description>
          <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label>Name<input aria-label={`${titles[kind]} name`} maxLength={80} value={draft.name} required disabled={busy} onChange={(event) => patch({ name: event.target.value })} /></label>
            {'scope' in draft && <><label>Available in<SelectControl compact label="Definition scope" disabled={Boolean(item) || busy} value={draft.scope} options={[{ value: 'project', label: 'This project' }, { value: 'user', label: 'All trusted projects' }]} onValueChange={(scope) => patch({ scope: scope as 'user' | 'project' })} /></label><p className="agent-library-note">This choice cannot change after you save the definition.</p></>}
            {'instructions' in draft && <>
              <label>Description<textarea aria-label="Agent description" maxLength={1000} rows={2} value={draft.description} disabled={busy} onChange={(event) => patch({ description: event.target.value })} /></label>
              <label>Agent instructions<textarea aria-label="Agent instructions" maxLength={65_536} rows={8} value={draft.instructions} disabled={busy} onChange={(event) => patch({ instructions: event.target.value })} /></label>
              <label>Model<SelectControl compact label="Agent model" value={draft.defaults.model ? JSON.stringify(draft.defaults.model) : 'current-model'} disabled={busy} options={[{ value: 'current-model', label: 'Use current session model' }, ...models.map((model) => ({ value: JSON.stringify({ provider: model.provider, id: model.id }), label: model.name, detail: model.provider })), ...(draft.defaults.model && !models.some((model) => model.provider === draft.defaults.model?.provider && model.id === draft.defaults.model?.id) ? [{ value: JSON.stringify(draft.defaults.model), label: 'Unavailable model', detail: `${draft.defaults.model.provider}/${draft.defaults.model.id}` }] : [])]} onValueChange={(value) => patch({ defaults: { ...draft.defaults, model: value === 'current-model' ? null : JSON.parse(value) as AgentDraft['defaults']['model'] } })} /></label>
              <label>Thinking<SelectControl compact label="Agent thinking" value={draft.defaults.thinkingLevel} disabled={busy} options={agentDraftSchema.shape.defaults.shape.thinkingLevel.options.map((level) => ({ value: level, label: level }))} onValueChange={(thinkingLevel) => patch({ defaults: { ...draft.defaults, thinkingLevel: thinkingLevel as AgentDraft['defaults']['thinkingLevel'] } })} /></label>
              <label>Permission ceiling<SelectControl compact label="Agent permission" value={draft.defaults.permission} disabled={busy} options={[{ value: 'read-only', label: 'Read only' }, { value: 'edit', label: 'Edit project files' }]} onValueChange={(permission) => patch({ defaults: { ...draft.defaults, permission: permission as 'read-only' | 'edit' } })} /></label>
              <label>Skills (exact names, comma-separated)<input aria-label="Agent skills" value={skillsText} disabled={busy} onChange={(event) => { setSkillsText(event.target.value); patch({ skillRefs: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) }); }} /></label>
              <p className="agent-library-note">Chats use this project's files. Worktrees are available only to Agent Teams.</p>
              {draft.defaults.workspace !== 'shared' && <button type="button" className="agent-primary-action" onClick={() => patch({ defaults: { ...draft.defaults, workspace: 'shared' } })}><ActionContent text="shared">Use shared</ActionContent></button>}
            </>}
            {'prompt' in draft && <label>Task prompt<textarea aria-label="TaskTemplate prompt" maxLength={200_000} rows={12} value={draft.prompt} required disabled={busy} onChange={(event) => patch({ prompt: event.target.value })} /></label>}
            {'agentId' in draft && <>
              <label>Agent<SelectControl compact label="Routine Agent" value={draft.agentId || 'select-agent'} disabled={busy} options={[{ value: 'select-agent', label: 'Select Agent' }, ...library.agents.map((agent) => ({ value: agent.id, label: agent.name, ...(agent.enabled ? {} : { detail: 'disabled' }) }))]} onValueChange={(agentId) => patch({ agentId: agentId === 'select-agent' ? '' : agentId })} /></label>
              <label>Task template<SelectControl compact label="Routine TaskTemplate" value={draft.taskTemplateId || 'select-task'} disabled={busy} options={[{ value: 'select-task', label: 'Select task' }, ...library.tasks.map((task) => ({ value: task.id, label: task.name, ...(task.enabled ? {} : { detail: 'disabled' }) }))]} onValueChange={(taskTemplateId) => patch({ taskTemplateId: taskTemplateId === 'select-task' ? '' : taskTemplateId })} /></label>
              <label>Interval (minutes)<input aria-label="Routine interval" type="number" min={1} max={10_080} value={draft.intervalMinutes} disabled={busy} onChange={(event) => patch({ intervalMinutes: Number(event.target.value) })} /></label>
              <label>Display timezone<input aria-label="Routine timezone" value={draft.timeZone} disabled={busy} onChange={(event) => patch({ timeZone: event.target.value })} /></label>
              <p className="agent-library-note">Use an IANA zone, such as America/New_York. The zone changes displayed times, not the elapsed interval. File changes need approval.</p>
              <label className="agent-library-check"><input type="checkbox" checked={draft.notify} onChange={(event) => patch({ notify: event.target.checked })} />In-app notifications</label>
              <label className="agent-library-check"><input type="checkbox" checked={draft.osNotify} onChange={(event) => patch({ osNotify: event.target.checked })} />OS notifications</label>
            </>}
            {'permissionCeiling' in draft && <label>Permission ceiling<SelectControl compact label={`${titles[kind]} permission`} value={draft.permissionCeiling} disabled={busy} options={[{ value: 'read-only', label: 'Read only' }, { value: 'edit', label: 'Edit project files' }]} onValueChange={(permissionCeiling) => patch({ permissionCeiling: permissionCeiling as 'read-only' | 'edit' })} /></label>}
            <p className="agent-library-note">Permissions cannot exceed your live session or workspace policy. Enabling this definition does not start a chat or run a task.</p>
            {error && <pre className="agent-library-error" role="alert">{error}</pre>}
            <footer><button type="button" className="agent-primary-action" disabled={busy} onClick={close}><ActionContent text="cancel">Cancel</ActionContent></button><button type="submit" className="agent-primary-action agent-save-action" aria-label={`Save ${titles[kind]}`} disabled={busy}><ActionContent text="save">{busy ? 'Saving…' : 'Save'}</ActionContent></button></footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {confirmClose && <ConfirmDialog title="Discard unsaved changes?" message="The saved definition will not change." confirmLabel="Discard changes" onConfirm={onClose} onCancel={() => setConfirmClose(false)} />}
  </>;
}
