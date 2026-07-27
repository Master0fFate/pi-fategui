import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  GitBranchPlus,
  GitFork,
  GripVertical,
  MessageSquarePlus,
  Pencil,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../../shared/contracts/ipc';
import { AppTooltip } from '../../components/AppTooltip';
import { IconButton } from '../../components/IconButton';
import { SelectControl } from '../../components/SelectControl';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const runtime = useRuntimeStore((state) => state.runtime);
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const openSettings = useUiStore((state) => state.setSettingsOpen);
  const showToast = useUiStore((state) => state.showToast);
  const requestComposerDraft = useUiStore((state) => state.requestComposerDraft);
  const musicPlaying = useUiStore((state) => state.musicPlaying);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'manual' | 'recent' | 'oldest' | 'alphabetical'>('recent');
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dragOverSessionId, setDragOverSessionId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>(runtime.sessions ?? []);
  const [renderExpanded, setRenderExpanded] = useState(!collapsed);
  const [expandedVisible, setExpandedVisible] = useState(!collapsed);
  const capabilities = runtime.sessionCapabilities;
  const sessionBusy = runtime.streaming || runtime.sessionOperation === true || actionBusy;
  const orderStorageKey = runtime.project ? `fate-ui:session-order:${runtime.project.path}` : null;
  const manualRanks = useMemo(() => new Map(manualOrder.map((id, index) => [id, index])), [manualOrder]);
  const sessionTitleByPath = useMemo(() => new Map(sessions.map((session) => [session.path, session.title])), [sessions]);
  const sortedSessions = useMemo(() => [...sessions].sort((left, right) => {
    if (sort === 'manual') {
      return (manualRanks.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (manualRanks.get(right.id) ?? Number.MAX_SAFE_INTEGER);
    }
    if (sort === 'alphabetical') return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }) || left.id.localeCompare(right.id);
    const difference = new Date(left.modifiedAt).getTime() - new Date(right.modifiedAt).getTime();
    return (sort === 'oldest' ? difference : -difference) || left.id.localeCompare(right.id);
  }), [manualRanks, sessions, sort]);

  useEffect(() => { if (!query.trim()) setSessions(runtime.sessions ?? []); }, [query, runtime.sessions]);
  useEffect(() => {
    if (!orderStorageKey) { setManualOrder([]); return; }
    try {
      const stored = JSON.parse(localStorage.getItem(orderStorageKey) ?? '[]');
      const order = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
      setManualOrder(order);
      if (order.length > 0) setSort('manual');
    } catch { setManualOrder([]); }
  }, [orderStorageKey]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const root = document.documentElement;
    const skipMotion = root.dataset.reduceMotion === 'true'
      || root.dataset.performanceMode === 'true'
      || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (skipMotion) {
      setRenderExpanded(!collapsed);
      setExpandedVisible(!collapsed);
      return;
    }
    if (collapsed) {
      setExpandedVisible(false);
      timer = setTimeout(() => setRenderExpanded(false), 100);
    } else {
      timer = setTimeout(() => {
        setRenderExpanded(true);
        requestAnimationFrame(() => setExpandedVisible(true));
      }, 150);
    }
    return () => { if (timer) clearTimeout(timer); };
  }, [collapsed]);
  useEffect(() => {
    if (collapsed || !query.trim() || !runtime.project || !('piDesktop' in window) || typeof window.piDesktop.listSessions !== 'function') return;
    let active = true;
    const timer = setTimeout(() => {
      void window.piDesktop.listSessions(query)
        .then((items) => { if (active) setSessions(items); })
        .catch(() => {
          if (active) showToast({ kind: 'error', title: 'Session search failed', message: 'Session search could not be refreshed.' });
        });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [collapsed, query, runtime.project, showToast]);

  const selectProject = () => {
    if (!('piDesktop' in window) || typeof window.piDesktop.selectProject !== 'function') return;
    void window.piDesktop.selectProject().then(setRuntime).catch((error: unknown) => {
      showToast({ kind: 'error', title: 'Project selection failed', message: error instanceof Error ? error.message : 'The project could not be selected.' });
    });
  };
  const invokeState = (label: string, operation: Promise<ReturnType<typeof useRuntimeStore.getState>['runtime'] | null>) => {
    setActionBusy(true);
    void operation
      .then((state) => { if (state) setRuntime(state); })
      .catch((error: unknown) => showToast({
        kind: 'error',
        title: `${label} failed`,
        message: error instanceof Error ? error.message : 'The session action could not be completed.',
      }))
      .finally(() => setActionBusy(false));
  };
  const beginRename = (session: SessionSummary) => {
    setEditingSessionId(session.id);
    // Pi-generated titles can exceed the user-facing rename contract. Native
    // maxLength does not truncate a value assigned programmatically.
    setSessionName(session.title.slice(0, 120));
  };
  const saveRename = () => {
    const name = sessionName.trim().slice(0, 120);
    if (!editingSessionId || !name || !('piDesktop' in window)) return;
    const id = editingSessionId;
    setEditingSessionId(null);
    invokeState('Renaming session', window.piDesktop.renameSession(id, name));
  };
  const deleteSession = (sessionId: string) => {
    if (!('piDesktop' in window)) return;
    setConfirmingDeleteId(null);
    invokeState('Deleting session', window.piDesktop.deleteSession(sessionId));
  };
  const runSessionAction = async (session: SessionSummary, action: 'fork' | 'worktree' | 'clone' | 'compact') => {
    if (!('piDesktop' in window) || sessionBusy) return;
    setActionBusy(true);
    try {
      let state = runtime;
      if (!session.active) {
        state = await window.piDesktop.switchSession(session.id);
        setRuntime(state);
      }
      if (action === 'clone') {
        setRuntime(await window.piDesktop.cloneSession());
      } else if (action === 'compact') {
        setRuntime(await window.piDesktop.compact());
      } else {
        const forkPoint = state.forkPoints?.at(-1);
        if (!forkPoint) throw new Error('This session has no user message to fork from.');
        if (action === 'worktree') {
          const result = await window.piDesktop.createWorktreeSession(forkPoint.entryId);
          setRuntime(result.state);
          requestComposerDraft(
            result.selectedText,
            true,
            `Isolated worktree ready on ${result.worktree.branch}. Uncommitted source-worktree changes stay behind. Edit the selected prompt, then send it to begin.`,
          );
          showToast({
            kind: 'success',
            title: 'Isolated session ready',
            message: `${result.worktree.branch} is isolated at committed HEAD; uncommitted source changes stay behind. Its first push publishes this exact branch.`,
          });
        } else {
          const result = await window.piDesktop.forkSession(forkPoint.entryId);
          setRuntime(result.state);
          requestComposerDraft(
            result.selectedText ?? forkPoint.text,
            true,
            `This new session branches from “${session.title}”. Edit the selected prompt, then send it to continue.`,
          );
          showToast({ kind: 'success', title: 'Fork ready', message: `A new session from “${session.title}” is active. Edit the selected prompt and send when ready.` });
        }
      }
    } catch (error) {
      showToast({
        kind: 'error',
        title: `${action === 'fork' ? 'Forking' : action === 'worktree' ? 'Creating isolated' : action === 'clone' ? 'Cloning' : 'Compacting'} session failed`,
        message: error instanceof Error ? error.message : 'The session action could not be completed.',
      });
    } finally {
      setActionBusy(false);
    }
  };
  const reorderSession = (targetId: string) => {
    if (!draggingSessionId || draggingSessionId === targetId || query) return;
    const order = sortedSessions.map((session) => session.id).filter((id) => id !== draggingSessionId);
    order.splice(order.indexOf(targetId), 0, draggingSessionId);
    setManualOrder(order);
    setSort('manual');
    if (orderStorageKey) localStorage.setItem(orderStorageKey, JSON.stringify(order));
    setDraggingSessionId(null);
  };

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''} ${expandedVisible ? 'sidebar--expanded-visible' : ''}`} aria-label="Primary navigation">
      <div className="window-drag-region" />
      <div className="brand-row">
        {renderExpanded && <div className="brand-mark sidebar-expanded-only" aria-hidden="true">ƒ</div>}
        {renderExpanded && (
          <div className="brand-copy sidebar-expanded-only">
            <div className="brand-title-line">
              <strong>Fate UI</strong>
              {musicPlaying && (
                <div className="music-equalizer" aria-hidden="true">
                  <i /><i /><i /><i />
                </div>
              )}
            </div>
            <span>{runtime.project?.name ?? 'No project open'}</span>
          </div>
        )}
        <IconButton label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={onToggle}>
          {collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
        </IconButton>
      </div>

      {renderExpanded && (
        <button className="primary-button sidebar-expanded-only" type="button" onClick={selectProject}>
          <FolderOpen size={16} /> Open project
        </button>
      )}
      <button
        className={`new-session ${collapsed ? 'icon-only' : ''}`}
        type="button"
        disabled={!runtime.project || sessionBusy}
        onClick={() => 'piDesktop' in window && invokeState('Creating session', window.piDesktop.newSession())}
      >
        <MessageSquarePlus size={17} />
        {renderExpanded && <span className="sidebar-expanded-only">New session</span>}
      </button>

      {renderExpanded && (
        <div className="sidebar-expanded-sections sidebar-expanded-only">
          <label className="session-search">
            <Search size={15} />
            <input aria-label="Search sessions" placeholder="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} disabled={!runtime.project} />
          </label>
          <div className="session-sort-row">
            <span>Sessions</span>
            <SelectControl
              label="Sort sessions"
              value={sort}
              className="session-sort-select"
              contentClassName="session-sort-content"
              options={[
                { value: 'manual', label: 'Manual order' },
                { value: 'recent', label: 'Recently modified' },
                { value: 'oldest', label: 'Oldest modified' },
                { value: 'alphabetical', label: 'Alphabetical' },
              ]}
              onValueChange={(value) => setSort(value as typeof sort)}
            />
          </div>

          <div className="session-list" aria-label="Sessions">
            {sortedSessions.map((session) => (
              <div
                className={`session-row${session.active ? ' active' : ''}${draggingSessionId === session.id ? ' dragging' : ''}${dragOverSessionId === session.id ? ' drag-over' : ''}`}
                key={session.id}
                draggable={!query && editingSessionId !== session.id && confirmingDeleteId !== session.id}
                onDragStart={(event) => {
                  setDraggingSessionId(session.id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', session.id);
                }}
                onDragEnter={() => { if (draggingSessionId !== session.id) setDragOverSessionId(session.id); }}
                onDragOver={(event) => { if (!query) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverSessionId(null); }}
                onDragEnd={() => { setDraggingSessionId(null); setDragOverSessionId(null); }}
                onDrop={(event) => { event.preventDefault(); reorderSession(session.id); setDragOverSessionId(null); }}
              >
                {confirmingDeleteId === session.id ? (
                  <div className="session-delete-confirm">
                    <span>Delete this session?</span>
                    <button type="button" onClick={() => deleteSession(session.id)}>Delete</button>
                    <button type="button" onClick={() => setConfirmingDeleteId(null)}>Cancel</button>
                  </div>
                ) : editingSessionId === session.id ? (
                  <form className="session-rename" onSubmit={(event) => { event.preventDefault(); saveRename(); }}>
                    <input autoFocus aria-label={`Rename ${session.title}`} value={sessionName} maxLength={120} onChange={(event) => setSessionName(event.target.value)} />
                    <button type="submit" aria-label="Save session name" disabled={!sessionName.trim()}><Check size={13} /></button>
                    <button type="button" aria-label="Cancel rename" onClick={() => setEditingSessionId(null)}><X size={13} /></button>
                  </form>
                ) : (
                  <>
                    <button className="session-open" type="button" disabled={session.active || sessionBusy} onClick={() => 'piDesktop' in window && invokeState('Switching session', window.piDesktop.switchSession(session.id))}>
                      <AppTooltip content={session.firstMessage || session.title}><span>{session.parentSessionPath && <GitFork size={11} aria-label="Forked session" />}{session.title}</span></AppTooltip>
                      <small>{session.parentSessionPath ? `Fork of ${sessionTitleByPath.get(session.parentSessionPath) ?? 'another session'} · ` : ''}{session.messageCount} messages · {new Date(session.modifiedAt).toLocaleDateString()}</small>
                    </button>
                    <div className="session-row-actions">
                      {!query && <AppTooltip content="Drag session to reorder"><span className="session-drag-handle" aria-hidden="true"><GripVertical size={12} /></span></AppTooltip>}
                      {capabilities?.fork && <AppTooltip content="Open a conversation fork with the latest prompt selected for editing" wrapTrigger><button type="button" aria-label={`Create new session from latest prompt in ${session.title}`} disabled={sessionBusy} onClick={() => void runSessionAction(session, 'fork')}><GitFork size={12} /></button></AppTooltip>}
                      {capabilities?.fork && <IconButton className="session-worktree-button" label={`Create an isolated Git worktree session from ${session.title}`} disabled={sessionBusy} onClick={() => void runSessionAction(session, 'worktree')}><GitBranchPlus size={12} /></IconButton>}
                      {capabilities?.clone && <button type="button" aria-label={`Clone ${session.title}`} disabled={sessionBusy} onClick={() => void runSessionAction(session, 'clone')}><Copy size={12} /></button>}
                      {capabilities?.compact && <button type="button" aria-label={`Compact ${session.title}`} disabled={sessionBusy} onClick={() => void runSessionAction(session, 'compact')}><Archive size={12} /></button>}
                      <button type="button" aria-label={`Rename ${session.title}`} disabled={sessionBusy} onClick={() => beginRename(session)}><Pencil size={12} /></button>
                      {!session.active && <button className="session-delete-button" type="button" aria-label={`Delete ${session.title}`} disabled={sessionBusy} onClick={() => setConfirmingDeleteId(session.id)}><Trash2 size={12} /></button>}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

          {(runtime.branches?.length ?? 0) > 1 && (
            <section className="branch-list" aria-label="Conversation branches">
              <strong>Branches</strong>
              {runtime.branches!.slice(-20).map((branch) => (
                <AppTooltip key={branch.id} content={branch.preview || branch.kind}>
                  <div className={branch.active ? 'active' : ''} style={{ paddingLeft: Math.min(branch.depth, 5) * 8 }}>
                    <GitFork size={11} /> <span>{branch.label || branch.preview || branch.kind}</span>
                  </div>
                </AppTooltip>
              ))}
            </section>
          )}
          {sessions.length === 0 && (
            <div className="empty-sessions">
          <FileText size={19} />
          <p>{query ? 'No matching sessions' : 'No sessions yet'}</p>
          <span>{runtime.status === 'auth-required' ? 'Saved sessions remain available; authenticate to prompt Pi.' : runtime.project ? 'Create a session to start working with Pi.' : 'Open a project to start working with Pi.'}</span>
            </div>
          )}
        </div>
      )}

      {collapsed && !renderExpanded && <nav className="nav-list"><AppTooltip content="Open project" wrapTrigger><button type="button" aria-label="Open project" onClick={selectProject}><FolderOpen size={18} /></button></AppTooltip></nav>}

      <div className="sidebar-footer">
        <AppTooltip content={collapsed ? 'Settings' : undefined} wrapTrigger={collapsed}>
          <button type="button" aria-label="Settings" onClick={() => openSettings(true)}>
            <Settings size={18} />
            {renderExpanded && <span className="sidebar-expanded-only">Settings</span>}
          </button>
        </AppTooltip>
      </div>
    </aside>
  );
}
