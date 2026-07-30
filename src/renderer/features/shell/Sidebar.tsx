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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
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

const attentionLabels = {
  running: 'Session running',
  completed: 'Session completed — new activity',
  error: 'Session error — needs attention',
} as const;

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const runtime = useRuntimeStore(useShallow((state) => ({
    project: state.runtime.project,
    status: state.runtime.status,
    streaming: state.runtime.streaming,
    activeSessionRunning: state.runtime.activeSessionRunning,
    runningSessionCount: state.runtime.runningSessionCount,
    sessionOperation: state.runtime.sessionOperation,
    sessionCapabilities: state.runtime.sessionCapabilities,
    sessions: state.runtime.sessions,
    branches: state.runtime.branches,
  })));
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const openSettings = useUiStore((state) => state.setSettingsOpen);
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed);
  const showToast = useUiStore((state) => state.showToast);
  const requestComposerDraft = useUiStore((state) => state.requestComposerDraft);
  const musicPlaying = useUiStore((state) => state.musicPlaying);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'manual' | 'recent' | 'oldest' | 'alphabetical'>('recent');
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dragOverSessionId, setDragOverSessionId] = useState<string | null>(null);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>(runtime.sessions ?? []);
  const [renderExpanded, setRenderExpanded] = useState(!collapsed);
  const [expandedVisible, setExpandedVisible] = useState(!collapsed);
  const mounted = useRef(true);
  const navigationBusyRef = useRef(false);
  const actionBusyRef = useRef(false);
  const sessionsProjectPath = useRef(runtime.project?.path ?? null);
  const capabilities = runtime.sessionCapabilities;
  const activeSessionRunning = runtime.activeSessionRunning ?? runtime.streaming;
  const anySessionRunning = activeSessionRunning || (runtime.runningSessionCount ?? 0) > 0;
  const replacementBusy = runtime.sessionOperation === true || navigationBusy || actionBusy;
  const operationUnavailableReason = replacementBusy ? 'Wait for the current session operation to finish' : null;
  const worktreeUnavailableReason = operationUnavailableReason
    ?? (anySessionRunning ? 'Stop all active Pi sessions before creating an isolated worktree' : null);
  const sessionIsRunning = (session: SessionSummary) => session.active ? activeSessionRunning : session.attention === 'running';
  const sessionActionDisabled = (session: SessionSummary) => replacementBusy || sessionIsRunning(session);
  const sessionActionTooltip = (session: SessionSummary, action: string) => operationUnavailableReason
    ?? (sessionIsRunning(session) ? `Wait for “${session.title}” to finish` : action);
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

  useEffect(() => {
    const projectPath = runtime.project?.path ?? null;
    const latest = runtime.sessions ?? [];
    if (sessionsProjectPath.current !== projectPath) {
      sessionsProjectPath.current = projectPath;
      setSessions(query.trim() ? [] : latest);
      return;
    }
    if (!query.trim()) {
      setSessions(latest);
      return;
    }
    const latestById = new Map(latest.map((session) => [session.id, session]));
    setSessions((current) => current.flatMap((session) => {
      const refreshed = latestById.get(session.id);
      return refreshed ? [refreshed] : [];
    }));
  }, [query, runtime.project?.path, runtime.sessions]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      navigationBusyRef.current = false;
      actionBusyRef.current = false;
    };
  }, []);
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
    const projectPath = runtime.project?.path;
    if (collapsed || !query.trim() || !projectPath || !('piDesktop' in window) || typeof window.piDesktop.listSessions !== 'function') return;
    let active = true;
    const timer = setTimeout(() => {
      void window.piDesktop.listSessions(query)
        .then((items) => {
          if (!active || !mounted.current) return;
          const latestRuntime = useRuntimeStore.getState().runtime;
          if (latestRuntime.project?.path !== projectPath) return;
          const latest = latestRuntime.sessions;
          if (!latest) {
            setSessions(items);
            return;
          }
          const latestById = new Map(latest.map((session) => [session.id, session]));
          setSessions(items.flatMap((session) => {
            const refreshed = latestById.get(session.id);
            return refreshed ? [refreshed] : [];
          }));
        })
        .catch(() => {
          if (active && mounted.current) showToast({ kind: 'error', title: 'Session search failed', message: 'Session search could not be refreshed.' });
        });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [collapsed, query, runtime.project?.path, runtime.sessions, showToast]);

  const invokeState = (
    label: string,
    operation: () => Promise<ReturnType<typeof useRuntimeStore.getState>['runtime'] | null>,
    kind: 'navigation' | 'action' = 'action',
  ): boolean => {
    const busyRef = kind === 'navigation' ? navigationBusyRef : actionBusyRef;
    if (navigationBusyRef.current || actionBusyRef.current) return false;
    const origin = useRuntimeStore.getState().runtime;
    if (kind === 'action' && origin.sessionOperation) return false;
    busyRef.current = true;
    const setBusy = kind === 'navigation' ? setNavigationBusy : setActionBusy;
    setBusy(true);
    let pending: ReturnType<typeof operation>;
    try {
      pending = operation();
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then((state) => {
        if (!state || !mounted.current) return;
        const current = useRuntimeStore.getState().runtime;
        const selectionMoved = current.sessionId !== origin.sessionId || current.project?.path !== origin.project?.path;
        const resultIsCurrent = current.sessionId === state.sessionId && current.project?.path === state.project?.path;
        if (!selectionMoved || resultIsCurrent) setRuntime(state);
      })
      .catch((error: unknown) => {
        if (mounted.current) showToast({
          kind: 'error',
          title: `${label} failed`,
          message: error instanceof Error ? error.message : 'The session action could not be completed.',
        });
      })
      .finally(() => {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      });
    return true;
  };
  const switchSession = (session: SessionSummary) => {
    if (!('piDesktop' in window) || navigationBusyRef.current || actionBusyRef.current) return;
    const store = useRuntimeStore.getState();
    const origin = store.runtime;
    const generation = store.beginSessionSwitch(session.id);
    if (generation === null) return;
    navigationBusyRef.current = true;
    setNavigationBusy(true);
    let pending: Promise<typeof origin>;
    try {
      pending = window.piDesktop.switchSession(session.id);
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then((state) => {
        const latest = useRuntimeStore.getState();
        if (!latest.completeSessionSwitch(generation, state)) latest.cancelSessionSwitch(generation, state);
      })
      .catch(async (error: unknown) => {
        if (!mounted.current) return;
        let rollback = origin;
        if (typeof window.piDesktop.getRuntimeState === 'function') {
          try { rollback = await window.piDesktop.getRuntimeState(); } catch { /* The click-time state is still a safe rollback. */ }
        }
        useRuntimeStore.getState().cancelSessionSwitch(generation, rollback);
        showToast({
          kind: 'error',
          title: 'Switching session failed',
          message: error instanceof Error ? error.message : 'The session action could not be completed.',
        });
      })
      .finally(() => {
        navigationBusyRef.current = false;
        if (mounted.current) setNavigationBusy(false);
      });
  };
  const selectProject = () => {
    if (!('piDesktop' in window) || typeof window.piDesktop.selectProject !== 'function') return;
    invokeState('Project selection', async () => {
      const state = await window.piDesktop.selectProject();
      if (state.project) setSidebarCollapsed(false);
      return state;
    }, 'navigation');
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
    if (invokeState('Renaming session', () => window.piDesktop.renameSession(id, name))) setEditingSessionId(null);
  };
  const deleteSession = (sessionId: string) => {
    if (!('piDesktop' in window)) return;
    if (invokeState('Deleting session', () => window.piDesktop.deleteSession(sessionId))) setConfirmingDeleteId(null);
  };
  const runSessionAction = async (session: SessionSummary, action: 'fork' | 'worktree' | 'clone' | 'compact') => {
    if (!('piDesktop' in window) || actionBusyRef.current || navigationBusyRef.current) return;
    const live = useRuntimeStore.getState().runtime;
    const selectedRunning = live.activeSessionRunning ?? live.streaming;
    const targetRunning = session.id === live.sessionId
      ? selectedRunning
      : live.sessions?.find((candidate) => candidate.id === session.id)?.attention === 'running';
    const anyRunning = selectedRunning || (live.runningSessionCount ?? 0) > 0;
    if (targetRunning || live.sessionOperation || (action === 'worktree' && anyRunning)) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    let expectedProjectPath = live.project?.path;
    let expectedSessionId = live.sessionId;
    const applyState = (state: typeof live) => {
      if (!mounted.current) return false;
      const current = useRuntimeStore.getState().runtime;
      const selectionIsExpected = current.project?.path === expectedProjectPath && current.sessionId === expectedSessionId;
      const resultIsCurrent = current.project?.path === state.project?.path && current.sessionId === state.sessionId;
      if (!selectionIsExpected && !resultIsCurrent) return false;
      setRuntime(state);
      expectedProjectPath = state.project?.path;
      expectedSessionId = state.sessionId;
      return true;
    };
    try {
      let state = live;
      if (state.sessionId !== session.id) {
        state = await window.piDesktop.switchSession(session.id);
        if (!applyState(state)) return;
      }
      if (action === 'clone') {
        applyState(await window.piDesktop.cloneSession());
      } else if (action === 'compact') {
        applyState(await window.piDesktop.compact());
      } else {
        const forkPoint = state.forkPoints?.at(-1);
        if (!forkPoint) throw new Error('This session has no user message to fork from.');
        if (action === 'worktree') {
          const result = await window.piDesktop.createWorktreeSession(forkPoint.entryId);
          if (!applyState(result.state)) return;
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
          if (!applyState(result.state)) return;
          requestComposerDraft(
            result.selectedText ?? forkPoint.text,
            true,
            `This new session branches from “${session.title}”. Edit the selected prompt, then send it to continue.`,
          );
          showToast({ kind: 'success', title: 'Fork ready', message: `A new session from “${session.title}” is active. Edit the selected prompt and send when ready.` });
        }
      }
    } catch (error) {
      if (!mounted.current) return;
      showToast({
        kind: 'error',
        title: `${action === 'fork' ? 'Forking' : action === 'worktree' ? 'Creating isolated' : action === 'clone' ? 'Cloning' : 'Compacting'} session failed`,
        message: error instanceof Error ? error.message : 'The session action could not be completed.',
      });
    } finally {
      actionBusyRef.current = false;
      if (mounted.current) setActionBusy(false);
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
        <button className="primary-button sidebar-expanded-only" type="button" disabled={replacementBusy} onClick={selectProject}>
          <FolderOpen size={16} /><span className="icon-label">Open project</span>
        </button>
      )}
      <button
        className={`new-session ${collapsed ? 'icon-only' : ''}`}
        type="button"
        disabled={!runtime.project || replacementBusy}
        onClick={() => 'piDesktop' in window && invokeState('Creating session', () => window.piDesktop.newSession(), 'navigation')}
      >
        <MessageSquarePlus size={17} />
        {renderExpanded && <span className="sidebar-expanded-only icon-label">New session</span>}
      </button>

      {renderExpanded && (
        <div className="sidebar-expanded-sections sidebar-expanded-only">
          <label className="session-search">
            <Search size={15} />
            <input className="icon-label" aria-label="Search sessions" placeholder="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} disabled={!runtime.project} />
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
                    <AppTooltip content="Delete session" wrapTrigger triggerClassName="session-delete-confirm-button session-delete-confirm-button--danger"><button type="button" onClick={() => deleteSession(session.id)}>Delete</button></AppTooltip>
                    <AppTooltip content="Cancel deletion" wrapTrigger triggerClassName="session-delete-confirm-button"><button type="button" onClick={() => setConfirmingDeleteId(null)}>Cancel</button></AppTooltip>
                  </div>
                ) : editingSessionId === session.id ? (
                  <form className="session-rename" onSubmit={(event) => { event.preventDefault(); saveRename(); }}>
                    <input autoFocus aria-label={`Rename ${session.title}`} value={sessionName} maxLength={120} onChange={(event) => setSessionName(event.target.value)} />
                    <AppTooltip content="Save session name" wrapTrigger triggerClassName="session-inline-action"><button type="submit" aria-label="Save session name" disabled={!sessionName.trim()}><Check size={13} /></button></AppTooltip>
                    <AppTooltip content="Cancel rename" wrapTrigger triggerClassName="session-inline-action"><button type="button" aria-label="Cancel rename" onClick={() => setEditingSessionId(null)}><X size={13} /></button></AppTooltip>
                  </form>
                ) : (
                  <>
                    <AppTooltip content={session.active ? `Current session: ${session.title}` : operationUnavailableReason ?? `Open ${session.title}${session.firstMessage ? `\n${session.firstMessage}` : ''}`} wrapTrigger triggerClassName="session-open-tooltip">
                      <button className="session-open" type="button" disabled={session.active || replacementBusy} onClick={() => switchSession(session)}>
                        <span>{session.parentSessionPath && <GitFork size={11} aria-label="Forked session" />}{session.parentSessionPath ? <span className="session-title-label icon-label">{session.title}</span> : session.title}</span>
                        <small>{session.parentSessionPath ? `Fork of ${sessionTitleByPath.get(session.parentSessionPath) ?? 'another session'} · ` : ''}{session.messageCount} messages · {new Date(session.modifiedAt).toLocaleDateString()}</small>
                      </button>
                    </AppTooltip>
                    {!session.active && session.attention && (
                      <AppTooltip content={attentionLabels[session.attention]} side="right" sideOffset={6}>
                        <span className="session-attention-dot" data-attention={session.attention} role="img" aria-label={attentionLabels[session.attention]} />
                      </AppTooltip>
                    )}
                    <div className="session-row-actions">
                      {!query && <AppTooltip content="Drag session to reorder"><span className="session-drag-handle" aria-hidden="true"><GripVertical size={12} /></span></AppTooltip>}
                      {capabilities?.fork && <AppTooltip content={sessionActionTooltip(session, `Branch from ${session.title}’s latest prompt`)} wrapTrigger><button type="button" aria-label={`Create new session from latest prompt in ${session.title}`} disabled={sessionActionDisabled(session)} onClick={() => void runSessionAction(session, 'fork')}><GitFork size={12} /></button></AppTooltip>}
                      {capabilities?.fork && <AppTooltip content={worktreeUnavailableReason ?? `Create an isolated Git worktree session from ${session.title}`} wrapTrigger><button className="session-worktree-button" type="button" aria-label={`Create an isolated Git worktree session from ${session.title}`} disabled={replacementBusy || anySessionRunning} onClick={() => void runSessionAction(session, 'worktree')}><GitBranchPlus size={12} /></button></AppTooltip>}
                      {capabilities?.clone && <AppTooltip content={sessionActionTooltip(session, `Clone ${session.title}`)} wrapTrigger><button type="button" aria-label={`Clone ${session.title}`} disabled={sessionActionDisabled(session)} onClick={() => void runSessionAction(session, 'clone')}><Copy size={12} /></button></AppTooltip>}
                      {capabilities?.compact && <AppTooltip content={sessionActionTooltip(session, `Compact ${session.title}’s context`)} wrapTrigger><button type="button" aria-label={`Compact ${session.title}`} disabled={sessionActionDisabled(session)} onClick={() => void runSessionAction(session, 'compact')}><Archive size={12} /></button></AppTooltip>}
                      <AppTooltip content={operationUnavailableReason ?? `Rename ${session.title}`} wrapTrigger><button type="button" aria-label={`Rename ${session.title}`} disabled={replacementBusy} onClick={() => beginRename(session)}><Pencil size={12} /></button></AppTooltip>
                      {!session.active && <AppTooltip content={sessionActionTooltip(session, `Delete ${session.title}`)} wrapTrigger><button className="session-delete-button" type="button" aria-label={`Delete ${session.title}`} disabled={sessionActionDisabled(session)} onClick={() => setConfirmingDeleteId(session.id)}><Trash2 size={12} /></button></AppTooltip>}
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
                    <GitFork size={11} /> <span className="icon-label">{branch.label || branch.preview || branch.kind}</span>
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

      {collapsed && !renderExpanded && <nav className="nav-list"><AppTooltip content="Open project" wrapTrigger><button type="button" aria-label="Open project" disabled={replacementBusy} onClick={selectProject}><FolderOpen size={18} /></button></AppTooltip></nav>}

      <div className="sidebar-footer">
        <AppTooltip content={collapsed ? 'Settings' : undefined} wrapTrigger={collapsed}>
          <button type="button" aria-label="Settings" onClick={() => openSettings(true)}>
            <Settings size={18} />
            {renderExpanded && <span className="sidebar-expanded-only icon-label">Settings</span>}
          </button>
        </AppTooltip>
      </div>
    </aside>
  );
}
