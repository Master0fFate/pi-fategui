import { Bot, FilePenLine, LoaderCircle, Pencil, Play, Plus, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AutomationCreateInput, AutomationDefinition } from '../../../shared/contracts/automations';
import type { RuntimeState } from '../../../shared/contracts/ipc';
import { AppTooltip } from '../../components/AppTooltip';
import { formatRelativeTime } from '../../lib/relativeTime';
import { useAutomationStore } from '../../stores/automationStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { AutomationEditorDialog } from './AutomationEditorDialog';
import { automationPromptPreview, automationSearchPattern } from './automationText';

export function SidebarAutomations() {
  const project = useRuntimeStore((state) => state.runtime.project);
  const sessionOperation = useRuntimeStore((state) => state.runtime.sessionOperation === true);
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const automationProjectPath = useAutomationStore((state) => state.projectPath);
  const items = useAutomationStore((state) => state.items);
  const loading = useAutomationStore((state) => state.loading);
  const mutatingId = useAutomationStore((state) => state.mutatingId);
  const storeError = useAutomationStore((state) => state.error);
  const createAutomation = useAutomationStore((state) => state.create);
  const updateAutomation = useAutomationStore((state) => state.update);
  const removeAutomation = useAutomationStore((state) => state.remove);
  const initializeAutomations = useAutomationStore((state) => state.initialize);
  const requestDraft = useUiStore((state) => state.requestComposerDraft);
  const automationOpenRequest = useUiStore((state) => state.automationOpenRequest);
  const clearAutomationOpenRequest = useUiStore((state) => state.clearAutomationOpenRequest);
  const setSidebarTab = useUiStore((state) => state.setSidebarTab);
  const showToast = useUiStore((state) => state.showToast);
  const [query, setQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AutomationDefinition | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const preparingRef = useRef(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const projectPath = project?.path ?? null;

  useEffect(() => {
    setQuery('');
    setEditorOpen(false);
    setEditing(null);
    setConfirmingDeleteId(null);
    setEditorError(null);
  }, [projectPath]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const pattern = automationSearchPattern(query);
    return items.filter((automation) => pattern.test(automation.name) || pattern.test(automation.prompt));
  }, [items, query]);

  const openEditor = (automation: AutomationDefinition | null) => {
    setEditing(automation);
    setEditorError(null);
    setEditorOpen(true);
  };

  useEffect(() => {
    if (!automationOpenRequest) return;
    if (automationOpenRequest.projectPath !== projectPath) {
      clearAutomationOpenRequest(automationOpenRequest.nonce);
      return;
    }
    if (loading || automationProjectPath !== projectPath) return;
    const automation = items.find((item) => item.id === automationOpenRequest.automationId) ?? null;
    clearAutomationOpenRequest(automationOpenRequest.nonce);
    if (!automation) {
      showToast({ kind: 'warning', title: 'Automation unavailable', message: 'That saved automation may have been deleted. Refresh the list and try again.' });
      return;
    }
    setQuery('');
    setEditing(automation);
    setEditorError(null);
    setEditorOpen(true);
  }, [automationOpenRequest, automationProjectPath, clearAutomationOpenRequest, items, loading, projectPath, showToast]);

  const save = async (input: AutomationCreateInput) => {
    try {
      if (editing) await updateAutomation({ id: editing.id, ...input });
      else await createAutomation(input);
      setEditorOpen(false);
      showToast({
        kind: 'success',
        title: editing ? 'Automation updated' : 'Automation created',
        message: 'It is saved to this project and ready to open in a new session.',
      });
    } catch (error) {
      setEditorError(messageOf(error));
    }
  };

  const remove = async (automation: AutomationDefinition) => {
    try {
      await removeAutomation(automation.id);
      setConfirmingDeleteId(null);
      showToast({ kind: 'success', title: 'Automation deleted', message: `“${automation.name}” was removed from this project.` });
    } catch (error) {
      showToast({ kind: 'error', title: 'Could not delete automation', message: messageOf(error) });
    }
  };

  const prepare = async (automation: AutomationDefinition) => {
    const desktop = 'piDesktop' in window ? window.piDesktop : undefined;
    if (!project?.trusted) {
      showToast({ kind: 'warning', title: 'Trust required', message: 'Trust this project before opening an automation session.' });
      return;
    }
    if (!desktop || preparingRef.current || sessionOperation) return;
    if (typeof desktop.prepareAutomationSession !== 'function') {
      showToast({ kind: 'error', title: 'Automation launch unavailable', message: 'Restart Fate UI to activate permission-scoped automation sessions.' });
      return;
    }
    preparingRef.current = true;
    setPreparingId(automation.id);
    const origin = useRuntimeStore.getState().runtime;
    try {
      const prepared = await desktop.prepareAutomationSession(automation.id);
      if (!applyRuntimeState(origin, prepared.state, setRuntime)) throw new Error('The selected session changed before the automation could open.');
      requestDraft(
        prepared.automation.prompt,
        true,
        `Automation “${prepared.automation.name}” is ready with ${prepared.automation.permissionLevel === 'edit' ? 'Edit project' : 'Read only'} access. Review the selected prompt, then send it.`,
      );
      setSidebarTab('sessions');
      void initializeAutomations(projectPath);
      showToast({ kind: 'success', title: 'Automation ready', message: `“${prepared.automation.name}” opened in a new session for review.` });
    } catch (error) {
      showToast({ kind: 'error', title: 'Could not open automation', message: messageOf(error) });
    } finally {
      preparingRef.current = false;
      setPreparingId(null);
    }
  };

  return (
    <section className="sidebar-automation-panel" aria-label="Automations">
      <div className="sidebar-tab-toolbar">
        <label className="sidebar-tab-search sidebar-search">
          <Search size={15} aria-hidden="true" />
          <input className="icon-label" type="search" aria-label="Search automations" placeholder="Search automations" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <AppTooltip content="New automation" wrapTrigger triggerClassName="sidebar-toolbar-action sidebar-toolbar-action--primary">
          <button type="button" aria-label="New automation" disabled={!project || loading || Boolean(mutatingId) || Boolean(preparingId)} onClick={() => openEditor(null)}><Plus size={15} /></button>
        </AppTooltip>
      </div>

      <div className="sidebar-section-heading">
        <span>Saved automations</span><em>{items.length}</em>
      </div>

      {storeError && !editorOpen && <div className="sidebar-inline-error" role="alert">Could not load automations: {storeError}</div>}
      {loading && <div className="sidebar-tab-loading" role="status"><LoaderCircle className="tool-spinner" size={14} />Loading automations…</div>}
      {filtered.length > 0 && (
        <div className="automation-list" role="list" aria-busy={loading}>
          {filtered.map((automation) => {
            const busy = preparingId === automation.id || mutatingId === automation.id;
            const deleting = confirmingDeleteId === automation.id;
            return (
              <article className="automation-row" key={automation.id} role="listitem" data-busy={busy || undefined}>
                {deleting ? (
                  <div className="automation-delete-confirm">
                    <span><strong>Delete “{automation.name}”?</strong><small>This cannot be undone.</small></span>
                    <button type="button" className="automation-delete-danger" disabled={Boolean(mutatingId)} onClick={() => void remove(automation)}>Delete</button>
                    <button type="button" disabled={Boolean(mutatingId)} aria-label="Cancel automation deletion" onClick={() => setConfirmingDeleteId(null)}><X size={13} /></button>
                  </div>
                ) : (
                  <>
                    <button className="automation-open" type="button" disabled={Boolean(preparingId) || busy || sessionOperation || !project?.trusted} title={!project?.trusted ? 'Trust this project to open automations' : preparingId ? 'Wait for the current automation session to finish opening' : 'Open in a new session'} onClick={() => void prepare(automation)}>
                      <span className="automation-row-icon" data-permission={automation.permissionLevel} aria-hidden="true">
                        {automation.permissionLevel === 'edit' ? <FilePenLine size={13} /> : <ShieldCheck size={13} />}
                      </span>
                      <span className="automation-row-copy">
                        <strong>{automation.name}</strong>
                        <small>{automationPromptPreview(automation.prompt)}</small>
                        <em>{automation.lastLaunchedAt ? `Opened ${formatRelativeTime(automation.lastLaunchedAt)} · ` : ''}{automation.permissionLevel === 'edit' ? 'Edit project' : 'Read only'}</em>
                      </span>
                      <Play size={13} aria-hidden="true" />
                    </button>
                    <div className="automation-row-actions">
                      <AppTooltip content="Edit automation" wrapTrigger><button type="button" aria-label={`Edit ${automation.name}`} disabled={Boolean(mutatingId) || Boolean(preparingId)} onClick={() => openEditor(automation)}><Pencil size={12} /></button></AppTooltip>
                      <AppTooltip content="Delete automation" wrapTrigger><button type="button" aria-label={`Delete ${automation.name}`} disabled={Boolean(mutatingId) || Boolean(preparingId)} onClick={() => setConfirmingDeleteId(automation.id)}><Trash2 size={12} /></button></AppTooltip>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}

      {!loading && !storeError && filtered.length === 0 && (
        <div className="sidebar-tab-empty">
          <Bot size={20} />
          <strong>{query ? 'No matching automations' : project ? 'No automations yet' : 'Open a project first'}</strong>
          <p>{query ? 'Try a different name or prompt.' : project ? 'Save a repeatable prompt and open it in a fresh, permission-scoped session.' : 'Automations are saved separately for each project.'}</p>
          {!query && project && <button type="button" onClick={() => openEditor(null)}>Create automation</button>}
        </div>
      )}

      <AutomationEditorDialog
        open={editorOpen}
        automation={editing}
        saving={mutatingId === 'new' || mutatingId === editing?.id}
        error={editorError}
        onOpenChange={setEditorOpen}
        onSave={save}
      />
    </section>
  );
}

function applyRuntimeState(origin: RuntimeState, next: RuntimeState, setRuntime: (state: RuntimeState) => void): boolean {
  const current = useRuntimeStore.getState().runtime;
  const selectionUnchanged = current.project?.path === origin.project?.path && current.sessionId === origin.sessionId;
  const resultIsCurrent = current.project?.path === next.project?.path && current.sessionId === next.sessionId;
  if (!selectionUnchanged && !resultIsCurrent) return false;
  setRuntime(next);
  return true;
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return 'The automation operation failed.';
  try {
    const parsed = JSON.parse(error.message) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : error.message;
  } catch {
    return error.message;
  }
}
