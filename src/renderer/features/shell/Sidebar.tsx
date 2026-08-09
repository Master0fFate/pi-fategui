import * as Popover from '@radix-ui/react-popover';
import * as Tabs from '@radix-ui/react-tabs';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  GripVertical,
  GitBranchPlus,
  GitFork,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Shrink,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import type { SessionBranch, SessionSummary } from '../../../shared/contracts/ipc';
import { AppTooltip } from '../../components/AppTooltip';
import { IconButton } from '../../components/IconButton';
import { SelectControl } from '../../components/SelectControl';
import { formatRelativeTime } from '../../lib/relativeTime';
import { useAutomationStore } from '../../stores/automationStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { projectPathKey, useProjectStore, type KnownProject } from '../../stores/projectStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { SidebarAutomations } from '../automations/SidebarAutomations';
import { SidebarResources } from '../resources/SidebarResources';
import { ConversationPaths } from './ConversationPaths';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

const MAX_CACHED_PROJECT_SESSIONS = 250;

const attentionLabels = {
  running: 'Session running',
  completed: 'Session completed — new activity',
  error: 'Session error — needs attention',
} as const;

function sidebarErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return sidebarErrorMessage(error.message, fallback);
  if (typeof error === 'string') {
    const value = error.trim();
    if (!value) return fallback;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        for (const key of ['message', 'error', 'reason', 'detail']) {
          if (typeof record[key] === 'string' && record[key].trim()) return sidebarErrorMessage(record[key], fallback);
        }
      }
    } catch { /* Plain bridge errors are already human-readable. */ }
    return value;
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'error', 'reason', 'detail']) {
      if (typeof record[key] === 'string' && record[key].trim()) return sidebarErrorMessage(record[key], fallback);
    }
  }
  return fallback;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const runtime = useRuntimeStore(useShallow((state) => ({
    project: state.runtime.project,
    sessionId: state.runtime.sessionId,
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
  const sidebarTab = useUiStore((state) => state.sidebarTab);
  const setSidebarTab = useUiStore((state) => state.setSidebarTab);
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed);
  const showToast = useUiStore((state) => state.showToast);
  const requestComposerDraft = useUiStore((state) => state.requestComposerDraft);
  const musicPlaying = useUiStore((state) => state.musicPlaying);
  const initializeAutomations = useAutomationStore((state) => state.initialize);
  const gitBranch = useWorkspaceStore((state) => state.git?.repository && state.git.branch ? state.git.branch : null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'manual' | 'recent' | 'oldest' | 'alphabetical'>('recent');
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dragOverSessionId, setDragOverSessionId] = useState<string | null>(null);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [confirmingDeleteAllPath, setConfirmingDeleteAllPath] = useState<string | null>(null);
  const [navigatingBranchId, setNavigatingBranchId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>(runtime.sessions ?? []);
  const [renderExpanded, setRenderExpanded] = useState(!collapsed);
  const [expandedVisible, setExpandedVisible] = useState(!collapsed);
  const [relativeNow, setRelativeNow] = useState(() => Date.now());
  const expandedSectionsRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const navigationBusyRef = useRef(false);
  const actionBusyRef = useRef(false);
  const sessionsProjectPath = useRef(runtime.project?.path ?? null);
  const projectNavigationGeneration = useRef(0);
  const wasSidebarCollapsed = useRef(collapsed);
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
    void initializeAutomations(runtime.project?.path ?? null);
  }, [initializeAutomations, runtime.project?.path]);
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
      setSort(order.length > 0 ? 'manual' : 'recent');
    } catch { setManualOrder([]); setSort('recent'); }
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
    if (collapsed || sessions.length === 0) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setRelativeNow(Date.now());
      timer = setTimeout(tick, 60_000 - Date.now() % 60_000 + 25);
    };
    timer = setTimeout(tick, 60_000 - Date.now() % 60_000 + 25);
    return () => clearTimeout(timer);
  }, [collapsed, sessions.length]);
  useEffect(() => {
    const projectPath = runtime.project?.path;
    const canSearchRuntime = 'piDesktop' in window && typeof window.piDesktop.listSessions === 'function';
    const canSearchPreview = 'piDesktop' in window && typeof window.piDesktop.listProjectSessions === 'function';
    if (collapsed || !query.trim() || !projectPath || (!canSearchRuntime && !canSearchPreview)) return;
    let active = true;
    const timer = setTimeout(() => {
      const search = (runtime.status === 'disconnected' || !canSearchRuntime) && canSearchPreview
        ? window.piDesktop.listProjectSessions(projectPath, query)
        : window.piDesktop.listSessions(query);
      void search
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
          setSessions(items.map((session) => latestById.get(session.id) ?? session));
        })
        .catch(() => {
          if (active && mounted.current) showToast({ kind: 'error', title: 'Session search failed', message: 'Session search could not be refreshed.' });
        });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [collapsed, query, runtime.project?.path, runtime.sessions, runtime.status, showToast]);

  const invokeState = (
    label: string,
    operation: () => Promise<ReturnType<typeof useRuntimeStore.getState>['runtime'] | null>,
    kind: 'navigation' | 'action' = 'action',
  ): boolean => {
    const busyRef = kind === 'navigation' ? navigationBusyRef : actionBusyRef;
    if (navigationBusyRef.current || actionBusyRef.current) return false;
    const origin = useRuntimeStore.getState().runtime;
    const navigationGeneration = kind === 'navigation' ? projectNavigationGeneration.current : null;
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
        if (navigationGeneration !== null && navigationGeneration !== projectNavigationGeneration.current) return;
        // The successful bridge response is authoritative unless a newer
        // project selection has already landed while this request was pending.
        setRuntime(state);
      })
      .catch((error: unknown) => {
        if (mounted.current) showToast({
          kind: 'error',
          title: `${label} failed`,
          message: sidebarErrorMessage(error, 'The session action could not be completed.'),
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
          message: sidebarErrorMessage(error, 'The session action could not be completed.'),
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
  const createSession = () => {
    if (!('piDesktop' in window)) return;
    invokeState('Creating session', () => window.piDesktop.newSession(), 'navigation');
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
  const deleteAllSessions = (project: KnownProject) => {
    if (!('piDesktop' in window) || typeof window.piDesktop.deleteProjectSessions !== 'function' || replacementBusy || actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    void window.piDesktop.deleteProjectSessions(project.path)
      .then((result) => {
        if (!mounted.current) return;
        setConfirmingDeleteAllPath(null);
        refreshPreviews([project.path]);
        const skippedMessage = result.skipped > 0 ? ` ${result.skipped} active session${result.skipped === 1 ? '' : 's'} stayed open.` : '';
        showToast({ kind: 'success', title: 'Sessions deleted', message: `Deleted ${result.deleted} session${result.deleted === 1 ? '' : 's'} from ${project.name}.${skippedMessage}` });
        if (isActiveProject(project.path)) setRuntime(useRuntimeStore.getState().runtime);
      })
      .catch((error: unknown) => {
        if (mounted.current) showToast({ kind: 'error', title: 'Could not delete sessions', message: sidebarErrorMessage(error, 'The folder sessions could not be deleted.') });
      })
      .finally(() => {
        actionBusyRef.current = false;
        if (mounted.current) setActionBusy(false);
      });
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
        message: sidebarErrorMessage(error, 'The session action could not be completed.'),
      });
    } finally {
      actionBusyRef.current = false;
      if (mounted.current) setActionBusy(false);
    }
  };
  const navigateConversationPath = (branch: SessionBranch) => {
    if (branch.active || replacementBusy || capabilities?.navigate !== true) return;
    if (!('piDesktop' in window) || typeof window.piDesktop.navigateSessionBranch !== 'function') {
      showToast({ kind: 'error', title: 'Path switching unavailable', message: 'The desktop session bridge cannot navigate conversation paths.' });
      return;
    }
    const origin = useRuntimeStore.getState().runtime;
    actionBusyRef.current = true;
    setActionBusy(true);
    setNavigatingBranchId(branch.id);
    void window.piDesktop.navigateSessionBranch(branch.id)
      .then((result) => {
        if (!mounted.current) return;
        const current = useRuntimeStore.getState().runtime;
        const selectionMoved = current.project?.path !== origin.project?.path || current.sessionId !== origin.sessionId;
        const resultIsCurrent = current.project?.path === result.state.project?.path && current.sessionId === result.state.sessionId;
        if (selectionMoved && !resultIsCurrent) return;
        useRuntimeStore.getState().hydrateRuntime(result.state);
        if (result.selectedText) {
          requestComposerDraft(result.selectedText, true, 'This path ends at an editable prompt. Edit it, then send to continue from here.');
        }
        showToast({ kind: 'success', title: 'Conversation path switched', message: 'The previous path remains saved and can be restored here.' });
      })
      .catch((error: unknown) => {
        if (mounted.current) showToast({
          kind: 'error',
          title: 'Could not switch conversation path',
          message: sidebarErrorMessage(error, 'That saved path could not be opened.'),
        });
      })
      .finally(() => {
        actionBusyRef.current = false;
        if (mounted.current) {
          setActionBusy(false);
          setNavigatingBranchId(null);
        }
      });
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

  const compactSessions = useUiStore((state) => state.compactSessions);
  const projects = useProjectStore((state) => state.projects);
  const expandedByPath = useProjectStore((state) => state.expandedByPath);
  const forgetProject = useProjectStore((state) => state.forgetProject);
  const reorderProjects = useProjectStore((state) => state.reorderProjects);
  const toggleFolderExpanded = useProjectStore((state) => state.toggleExpanded);

  const activeProjectPath = runtime.project?.path ?? null;
  const activeProjectKey = projectPathKey(activeProjectPath ?? '');
  useEffect(() => { projectNavigationGeneration.current += 1; }, [activeProjectKey]);
  const isActiveProject = (path: string) => projectPathKey(path) === activeProjectKey;
  const [previewsByPath, setPreviewsByPath] = useState<Record<string, SessionSummary[]>>({});
  const [previewCountByPath, setPreviewCountByPath] = useState<Record<string, number>>({});
  const [previewStateByPath, setPreviewStateByPath] = useState<Record<string, 'idle' | 'loading' | 'error'>>({});
  const [draggingFolderPath, setDraggingFolderPath] = useState<string | null>(null);
  const [dragOverFolderPath, setDragOverFolderPath] = useState<string | null>(null);
  const [previewRefreshTick, setPreviewRefreshTick] = useState(0);
  const [folderScrollParent, setFolderScrollParent] = useState<HTMLDivElement | null>(null);
  const previewInFlight = useRef<Set<string>>(new Set());
  const previewRequestGeneration = useRef<Map<string, number>>(new Map());
  const loadedPaths = useRef<Set<string>>(new Set());
  const refreshPreviews = (paths?: readonly string[]) => {
    const targets = paths ?? projects.map((project) => project.path);
    for (const path of targets) {
      if (!path) continue;
      const key = projectPathKey(path);
      loadedPaths.current.delete(key);
      if (previewInFlight.current.delete(key)) {
        previewRequestGeneration.current.set(key, (previewRequestGeneration.current.get(key) ?? 0) + 1);
      }
    }
    setPreviewRefreshTick((tick) => tick + 1);
  };

  const visibleProjects = query.trim() ? projects.filter((project) => isActiveProject(project.path)) : projects;
  const storedFolderExpansion = (path: string): boolean | undefined => {
    const key = projectPathKey(path);
    return Object.entries(expandedByPath).find(([storedPath]) => projectPathKey(storedPath) === key)?.[1];
  };
  const folderExpanded = (path: string) => storedFolderExpansion(path) ?? isActiveProject(path);
  const folderSessionCount = (path: string): number | undefined => {
    if (isActiveProject(path)) return sessions.length;
    return previewCountByPath[path] ?? previewsByPath[path]?.length;
  };

  useEffect(() => {
    const project = runtime.project;
    if (!project) return;
    const store = useProjectStore.getState();
    store.addProject({ path: project.path, name: project.name });
    const key = projectPathKey(project.path);
    const hasExpansionState = Object.keys(store.expandedByPath).some((path) => projectPathKey(path) === key);
    if (!hasExpansionState) store.setExpanded(project.path, true);
  }, [runtime.project?.path, runtime.project?.name]);

  useEffect(() => {
    if (query.trim()) return;
    if (previewRefreshTick > 0) {
      for (const project of projects) {
        if (!isActiveProject(project.path) && (expandedByPath[project.path] ?? false)) loadedPaths.current.delete(projectPathKey(project.path));
      }
    }
    for (const project of projects) {
      if (isActiveProject(project.path)) continue;
      // Background project summaries are also loaded while their folder is
      // collapsed so an active run or unread result can remain visible.
      // Dedupe via refs only: resolved previews must not live in this effect's
      // dependency array or a project focus change invalidates its own fetch.
      const path = project.path;
      const pathKey = projectPathKey(path);
      if (loadedPaths.current.has(pathKey) || previewInFlight.current.has(pathKey)) continue;
      if (!('piDesktop' in window) || typeof window.piDesktop.listProjectSessions !== 'function') continue;
      previewInFlight.current.add(pathKey);
      const requestGeneration = (previewRequestGeneration.current.get(pathKey) ?? 0) + 1;
      previewRequestGeneration.current.set(pathKey, requestGeneration);
      loadedPaths.current.add(pathKey);
      setPreviewStateByPath((state) => ({ ...state, [path]: 'loading' }));
      void window.piDesktop.listProjectSessions(path)
        .then((items) => {
          if (!mounted.current || previewRequestGeneration.current.get(pathKey) !== requestGeneration || !useProjectStore.getState().projects.some((candidate) => projectPathKey(candidate.path) === pathKey)) return;
          const priority = items.filter((session) => session.active || Boolean(session.attention));
          const cached = items.length <= MAX_CACHED_PROJECT_SESSIONS
            ? items
            : [...priority, ...items.filter((session) => !session.active && !session.attention)]
              .slice(0, Math.max(MAX_CACHED_PROJECT_SESSIONS, priority.length));
          setPreviewsByPath((state) => ({ ...state, [path]: cached }));
          setPreviewCountByPath((state) => ({ ...state, [path]: items.length }));
          setPreviewStateByPath((state) => ({ ...state, [path]: 'idle' }));
        })
        .catch(() => {
          if (!mounted.current || previewRequestGeneration.current.get(pathKey) !== requestGeneration || !useProjectStore.getState().projects.some((candidate) => projectPathKey(candidate.path) === pathKey)) return;
          setPreviewStateByPath((state) => ({ ...state, [path]: 'error' }));
          loadedPaths.current.delete(pathKey);
        })
        .finally(() => {
          if (previewRequestGeneration.current.get(pathKey) === requestGeneration) previewInFlight.current.delete(pathKey);
        });
    }
  }, [projects, activeProjectPath, expandedByPath, previewRefreshTick, query]);

  useEffect(() => {
    const knownKeys = new Set(projects.map((project) => projectPathKey(project.path)));
    const prune = <T,>(state: Record<string, T>): Record<string, T> => {
      const entries = Object.entries(state).filter(([path]) => knownKeys.has(projectPathKey(path)));
      return entries.length === Object.keys(state).length ? state : Object.fromEntries(entries);
    };
    setPreviewsByPath(prune);
    setPreviewCountByPath(prune);
    setPreviewStateByPath(prune);
    for (const key of [...loadedPaths.current]) if (!knownKeys.has(key)) loadedPaths.current.delete(key);
    for (const key of [...previewInFlight.current]) {
      if (!knownKeys.has(key)) {
        previewInFlight.current.delete(key);
        previewRequestGeneration.current.set(key, (previewRequestGeneration.current.get(key) ?? 0) + 1);
      }
    }
  }, [projects]);

  useEffect(() => {
    const reopened = wasSidebarCollapsed.current && !collapsed;
    wasSidebarCollapsed.current = collapsed;
    if (reopened && !query.trim()) refreshPreviews();
  }, [collapsed, query]);

  useEffect(() => {
    if (collapsed || query.trim()) return undefined;
    const timer = window.setInterval(() => refreshPreviews(), 15_000);
    return () => window.clearInterval(timer);
  }, [collapsed, query, projects]);

  const switchToProject = (path: string) => {
    if (isActiveProject(path) || replacementBusy) return;
    if (!('piDesktop' in window)) return;
    const focus = typeof window.piDesktop.focusProject === 'function'
      ? window.piDesktop.focusProject
      : window.piDesktop.openProject;
    if (typeof focus !== 'function') return;
    refreshPreviews([activeProjectPath ?? '', path]);
    invokeState('Switching project', () => focus(path), 'navigation');
  };
  const openFolder = (project: KnownProject) => {
    if (!folderExpanded(project.path)) toggleFolderExpanded(project.path);
    if (!isActiveProject(project.path)) switchToProject(project.path);
  };
  const createSessionInFolder = (project: KnownProject) => {
    if (isActiveProject(project.path) && runtime.status !== 'disconnected') {
      createSession();
      return;
    }
    if (!('piDesktop' in window) || typeof window.piDesktop.openProject !== 'function' || replacementBusy) return;
    if (navigationBusyRef.current || actionBusyRef.current) return;
    navigationBusyRef.current = true;
    setNavigationBusy(true);
    const navigationGeneration = projectNavigationGeneration.current;
    refreshPreviews([activeProjectPath ?? '', project.path]);
    void window.piDesktop.openProject(project.path)
      .then((state) => {
        if (!mounted.current || navigationGeneration !== projectNavigationGeneration.current) return null;
        if (state.status === 'error' || !state.project) return null;
        return window.piDesktop.newSession();
      })
      .then((state) => {
        if (state && mounted.current && navigationGeneration === projectNavigationGeneration.current) {
          setRuntime(state);
          refreshPreviews([project.path]);
        }
      })
      .catch((error) => {
        if (mounted.current && navigationGeneration === projectNavigationGeneration.current) showToast({ kind: 'error', title: 'Creating session failed', message: sidebarErrorMessage(error, 'The session could not be created.') });
      })
      .finally(() => {
        navigationBusyRef.current = false;
        if (mounted.current) setNavigationBusy(false);
      });
  };
  const focusForeignSession = (project: KnownProject, session: SessionSummary) => {
    if (!('piDesktop' in window) || typeof window.piDesktop.openProject !== 'function' || navigationBusyRef.current || actionBusyRef.current) return;
    navigationBusyRef.current = true;
    setNavigationBusy(true);
    const navigationGeneration = projectNavigationGeneration.current;
    refreshPreviews([activeProjectPath ?? '', project.path]);
    void window.piDesktop.openProject(project.path)
      .then(async (state) => {
        if (!mounted.current || navigationGeneration !== projectNavigationGeneration.current) return null;
        // Do not paint the project's default session between the folder focus
        // and the requested session switch. Only the final destination is
        // authoritative for this click.
        if (state.status === 'error' || !state.project) return state;
        if (state.sessionId !== session.id) {
          try { return await window.piDesktop.switchSession(session.id); }
          catch (error) {
            if (mounted.current) showToast({ kind: 'error', title: 'Opening session failed', message: sidebarErrorMessage(error, 'The session could not be opened.') });
            return state;
          }
        }
        return state;
      })
      .then((state) => {
        if (state && mounted.current && navigationGeneration === projectNavigationGeneration.current) {
          setRuntime(state);
          refreshPreviews([project.path]);
        }
      })
      .catch((error) => {
        if (mounted.current && navigationGeneration === projectNavigationGeneration.current) showToast({ kind: 'error', title: 'Switching folder failed', message: sidebarErrorMessage(error, 'The project could not be opened.') });
      })
      .finally(() => {
        navigationBusyRef.current = false;
        if (mounted.current) setNavigationBusy(false);
      });
  };
  const forgetFolder = (project: KnownProject) => {
    if (!('piDesktop' in window) || typeof window.piDesktop.closeProjectRuntime !== 'function' || isActiveProject(project.path) || navigationBusyRef.current || actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    void window.piDesktop.closeProjectRuntime(project.path)
      .then(() => {
        if (mounted.current) forgetProject(project.path);
      })
      .catch((error: unknown) => {
        if (mounted.current) showToast({ kind: 'error', title: 'Could not forget folder', message: sidebarErrorMessage(error, 'The project runtime could not be closed.') });
      })
      .finally(() => {
        actionBusyRef.current = false;
        if (mounted.current) setActionBusy(false);
      });
  };
  const revealFolder = (projectPath: string) => {
    if (!('piDesktop' in window) || typeof window.piDesktop.revealProjectPath !== 'function') return;
    void window.piDesktop.revealProjectPath(projectPath).catch((error: unknown) => {
      showToast({ kind: 'error', title: 'Reveal failed', message: sidebarErrorMessage(error, 'The folder could not be revealed.') });
    });
  };
  const reorderFolder = (targetPath: string) => {
    if (!draggingFolderPath || draggingFolderPath === targetPath) return;
    const order = projects.map((project) => project.path).filter((path) => path !== draggingFolderPath);
    order.splice(order.indexOf(targetPath), 0, draggingFolderPath);
    reorderProjects(order);
    setDraggingFolderPath(null);
  };
  const reorderFolderByKeyboard = (path: string, direction: -1 | 1) => {
    const index = projects.findIndex((project) => project.path === path);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= projects.length) return;
    const order = projects.map((project) => project.path);
    [order[index], order[target]] = [order[target]!, order[index]!];
    reorderProjects(order);
  };

  const renderSessionActions = (session: SessionSummary, inMenu = false) => {
    type SessionAction = { key: string; label: string; ariaLabel: string; icon: typeof GitFork; disabled: boolean; onClick: () => void; danger?: boolean; className?: string };
    const actions: SessionAction[] = [
      capabilities?.fork ? { key: 'fork', label: sessionActionTooltip(session, 'Branch from latest prompt'), ariaLabel: `Create new session from latest prompt in ${session.title}`, icon: GitFork, disabled: sessionActionDisabled(session), onClick: () => void runSessionAction(session, 'fork') } : null,
      capabilities?.fork ? { key: 'worktree', label: worktreeUnavailableReason ?? 'Create isolated Git worktree', ariaLabel: `Create an isolated Git worktree session from ${session.title}`, icon: GitBranchPlus, disabled: replacementBusy || anySessionRunning, onClick: () => void runSessionAction(session, 'worktree'), className: 'session-worktree-button' } : null,
      capabilities?.clone ? { key: 'clone', label: sessionActionTooltip(session, 'Clone session'), ariaLabel: `Clone ${session.title}`, icon: Copy, disabled: sessionActionDisabled(session), onClick: () => void runSessionAction(session, 'clone') } : null,
      capabilities?.compact ? { key: 'compact', label: sessionActionTooltip(session, 'Compact session context'), ariaLabel: `Compact ${session.title}`, icon: Shrink, disabled: sessionActionDisabled(session), onClick: () => void runSessionAction(session, 'compact') } : null,
      { key: 'rename', label: operationUnavailableReason ?? 'Rename session', ariaLabel: `Rename ${session.title}`, icon: Pencil, disabled: replacementBusy, onClick: () => beginRename(session) },
      { key: 'delete', label: sessionActionTooltip(session, session.active ? 'Switch to another session before deleting this one' : 'Delete session'), ariaLabel: `Delete ${session.title}`, icon: Trash2, disabled: session.active || sessionActionDisabled(session), onClick: () => setConfirmingDeleteId(session.id), className: 'session-delete-button', danger: true },
    ].filter((action): action is SessionAction => action !== null);
    return (
      <div className={`session-row-actions${inMenu ? ' session-row-actions--menu' : ''}`} role={inMenu ? 'menu' : undefined}>
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <AppTooltip key={action.key} content={action.label} wrapTrigger>
              <button type="button" role={inMenu ? 'menuitem' : undefined} className={action.className} aria-label={action.ariaLabel} disabled={action.disabled} onClick={action.onClick}><Icon size={12} /></button>
            </AppTooltip>
          );
        })}
      </div>
    );
  };
  const renderSessionRow = (session: SessionSummary) => {
    if (confirmingDeleteId === session.id) {
      return (
        <div className="session-delete-confirm" key={session.id}>
          <span>Delete this session?</span>
          <AppTooltip content="Delete session" wrapTrigger triggerClassName="session-delete-confirm-button session-delete-confirm-button--danger"><button type="button" onClick={() => deleteSession(session.id)}>Delete</button></AppTooltip>
          <AppTooltip content="Cancel deletion" wrapTrigger triggerClassName="session-delete-confirm-button"><button type="button" onClick={() => setConfirmingDeleteId(null)}>Cancel</button></AppTooltip>
        </div>
      );
    }
    if (editingSessionId === session.id) {
      return (
        <form className="session-rename" key={session.id} onSubmit={(event) => { event.preventDefault(); saveRename(); }}>
          <input autoFocus aria-label={`Rename ${session.title}`} value={sessionName} maxLength={120} onChange={(event) => setSessionName(event.target.value)} />
          <AppTooltip content="Save session name" wrapTrigger triggerClassName="session-inline-action"><button type="submit" aria-label="Save session name" disabled={!sessionName.trim()}><Check size={13} /></button></AppTooltip>
          <AppTooltip content="Cancel rename" wrapTrigger triggerClassName="session-inline-action"><button type="button" aria-label="Cancel rename" onClick={() => setEditingSessionId(null)}><X size={13} /></button></AppTooltip>
        </form>
      );
    }
    if (compactSessions) {
      return (
        <div
          key={session.id}
          className={`session-row session-row--compact${session.active ? ' active' : ''}${draggingSessionId === session.id ? ' dragging' : ''}${dragOverSessionId === session.id ? ' drag-over' : ''}`}
          draggable={!query}
          onDragStart={(event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('.session-row-actions, .session-rename, .session-delete-confirm, .session-menu-trigger')) { event.preventDefault(); return; }
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
          <AppTooltip content={`${session.title}${!session.active && operationUnavailableReason ? `\n${operationUnavailableReason}` : ''}`} side="right" sideOffset={8} wrapTrigger triggerClassName="session-open-tooltip">
            <button className="session-open session-open--compact" type="button" disabled={session.active || replacementBusy} onClick={() => switchSession(session)}>
              <span className="session-title-label">{session.parentSessionPath && <GitFork size={11} aria-label="Forked session" />}{session.title}</span>
            </button>
          </AppTooltip>
          {!session.active && session.attention && (
            <AppTooltip content={attentionLabels[session.attention]} side="right" sideOffset={6}>
              <span className="session-attention-dot" data-attention={session.attention} role="img" aria-label={attentionLabels[session.attention]} />
            </AppTooltip>
          )}
          <Popover.Root>
            <AppTooltip content="Session actions">
              <Popover.Trigger asChild>
                <button className="session-menu-trigger" type="button" aria-label={`Actions for ${session.title}`}><MoreHorizontal size={14} /></button>
              </Popover.Trigger>
            </AppTooltip>
            <Popover.Portal>
              <Popover.Content className="session-action-menu" side="top" align="end" sideOffset={6} onOpenAutoFocus={(event) => event.preventDefault()}>
                {renderSessionActions(session, true)}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      );
    }
    return (
      <div
        key={session.id}
        className={`session-row${session.active ? ' active' : ''}${draggingSessionId === session.id ? ' dragging' : ''}${dragOverSessionId === session.id ? ' drag-over' : ''}`}
        draggable={!query}
        onDragStart={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest('.session-row-actions, .session-rename, .session-delete-confirm, .session-menu-trigger')) { event.preventDefault(); return; }
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
        <AppTooltip
          content={`${session.title}${!session.active && operationUnavailableReason ? `\n${operationUnavailableReason}` : ''}`}
          side="right"
          sideOffset={8}
          wrapTrigger
          triggerClassName="session-open-tooltip"
        >
          <button className="session-open" type="button" disabled={session.active || replacementBusy} onClick={() => switchSession(session)}>
            <span>{session.parentSessionPath && <GitFork size={11} aria-label="Forked session" />}{session.parentSessionPath ? <span className="session-title-label icon-label">{session.title}</span> : session.title}</span>
            <small title={`Updated ${new Date(session.modifiedAt).toLocaleString()}`}>{session.parentSessionPath ? `Fork of ${sessionTitleByPath.get(session.parentSessionPath) ?? 'another session'} · ` : ''}{gitBranch ? `${gitBranch} · ` : ''}{session.messageCount} messages · updated <time dateTime={session.modifiedAt}>{formatRelativeTime(session.modifiedAt, relativeNow)}</time></small>
          </button>
        </AppTooltip>
        {!session.active && session.attention && (
          <AppTooltip content={attentionLabels[session.attention]} side="right" sideOffset={6}>
            <span className="session-attention-dot" data-attention={session.attention} role="img" aria-label={attentionLabels[session.attention]} />
          </AppTooltip>
        )}
        {renderSessionActions(session, false)}
      </div>
    );
  };
  const renderSessionListItem = (session: SessionSummary) => {
    const row = renderSessionRow(session);
    const branches = runtime.branches;
    if (session.id !== runtime.sessionId || editingSessionId === session.id || confirmingDeleteId === session.id || capabilities?.navigate !== true || !branches || branches.length <= 1) return row;
    return (
      <div className="session-row-with-paths" key={`session-with-paths-${session.id}`}>
        {row}
        <ConversationPaths
          branches={branches}
          busy={replacementBusy}
          pendingId={navigatingBranchId}
          onSelect={navigateConversationPath}
          compact={compactSessions}
        />
      </div>
    );
  };
  const renderPreviewRows = (project: KnownProject, suppliedItems?: SessionSummary[]) => {
    const state = previewStateByPath[project.path];
    const items = suppliedItems ?? previewsByPath[project.path];
    if (state === 'loading' && !items) return <div key="state" className="folder-preview-state">Scanning sessions…</div>;
    if (state === 'error' && !items) return <div key="state" className="folder-preview-state folder-preview-state--error">Couldn’t read sessions for this folder.</div>;
    if (!items || items.length === 0) return <div key="state" className="folder-preview-state">No sessions yet — open this folder to start.</div>;
    const renderPreview = (session: SessionSummary) => {
      const local = isActiveProject(project.path);
      const localRuntimeReady = local && runtime.status !== 'disconnected' && runtime.status !== 'error';
      const disabled = replacementBusy || (localRuntimeReady && session.active);
      return (
        <button
          key={session.id}
          className={`session-row session-row--preview${session.active ? ' active' : ''}`}
          type="button"
          disabled={disabled}
          onClick={() => localRuntimeReady ? switchSession(session) : focusForeignSession(project, session)}
          title={`${session.active ? 'Active: ' : 'Open '}“${session.title}” in ${project.name}`}
        >
          <span className="session-preview-title">{session.parentSessionPath && <GitFork size={10} aria-label="Forked session" />}{session.title}</span>
          <small>{session.messageCount} {session.messageCount === 1 ? 'message' : 'messages'} · {formatRelativeTime(session.modifiedAt, relativeNow)}</small>
          {session.attention && <span className="session-attention-dot session-attention-dot--preview" data-attention={session.attention} role="img" aria-label={attentionLabels[session.attention]} />}
        </button>
      );
    };
    const total = suppliedItems ? suppliedItems.length : previewCountByPath[project.path] ?? items.length;
    const list = items.length > 100
      ? folderScrollParent
        ? <Virtuoso customScrollParent={folderScrollParent} data={items} defaultItemHeight={27} itemContent={(_index, session) => renderPreview(session)} />
        : <div className="folder-preview-state">Preparing session list…</div>
      : items.map(renderPreview);
    return <>{list}{total > items.length && <div className="folder-preview-state">Showing {items.length} of {total} — open this folder to load all sessions.</div>}</>;
  };
  const renderFolderHeader = (project: KnownProject) => {
    const isActive = isActiveProject(project.path);
    const expanded = folderExpanded(project.path);
    const count = folderSessionCount(project.path);
    return (
      <div
        className={`folder-header${isActive ? ' folder-header--active' : ''}${draggingFolderPath === project.path ? ' dragging' : ''}${dragOverFolderPath === project.path ? ' drag-over' : ''}`}
        draggable
        onDragStart={(event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest('.folder-chevron, .folder-reorder, .folder-header-actions')) { event.preventDefault(); return; }
          setDraggingFolderPath(project.path);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', project.path);
        }}
        onDragEnter={() => { if (draggingFolderPath && draggingFolderPath !== project.path) setDragOverFolderPath(project.path); }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverFolderPath(null); }}
        onDragEnd={() => { setDraggingFolderPath(null); setDragOverFolderPath(null); }}
        onDrop={(event) => { event.preventDefault(); reorderFolder(project.path); setDragOverFolderPath(null); }}
      >
        <button className="folder-chevron" type="button" aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`} onClick={() => toggleFolderExpanded(project.path)}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <AppTooltip content={`Move ${project.name} folder up (ArrowUp/ArrowDown)`} wrapTrigger>
          <button className="folder-reorder" type="button" aria-label={`Move ${project.name} folder up`} onClick={() => reorderFolderByKeyboard(project.path, -1)} onKeyDown={(event) => {
            if (event.key === 'ArrowUp') { event.preventDefault(); reorderFolderByKeyboard(project.path, -1); }
            if (event.key === 'ArrowDown') { event.preventDefault(); reorderFolderByKeyboard(project.path, 1); }
          }}><GripVertical size={12} aria-hidden="true" /></button>
        </AppTooltip>
        <button className="folder-open" type="button" disabled={replacementBusy} onClick={() => openFolder(project)} title={project.path} aria-current={isActive ? 'true' : undefined}>
          <Folder size={14} aria-hidden="true" />
          <span className="folder-name">{project.name}</span>
          {count !== undefined && <span className="folder-count">{count}</span>}
        </button>
        <div className="folder-header-actions">
          <AppTooltip content="New session" wrapTrigger>
            <button className="folder-new-session" type="button" aria-label={`New session in ${project.name}`} disabled={replacementBusy} onClick={() => createSessionInFolder(project)}><Plus size={13} /></button>
          </AppTooltip>
          <Popover.Root>
            <AppTooltip content="Folder actions">
              <Popover.Trigger asChild>
                <button className="folder-menu-trigger" type="button" aria-label={`Actions for ${project.name}`}><MoreHorizontal size={14} /></button>
              </Popover.Trigger>
            </AppTooltip>
            <Popover.Portal>
              <Popover.Content className="folder-action-menu" role="menu" aria-label={`Actions for ${project.name}`} align="start" sideOffset={6}>
                <button type="button" role="menuitem" className="folder-action-item" disabled={replacementBusy} onClick={() => openFolder(project)}>Open this folder</button>
                <button type="button" role="menuitem" className="folder-action-item" disabled={replacementBusy} onClick={() => revealFolder(project.path)}>Reveal in file manager</button>
                {confirmingDeleteAllPath === project.path ? (
                  <div className="folder-action-confirm" role="group" aria-label={`Confirm deleting sessions from ${project.name}`}>
                    <span>Delete all folder sessions?</span>
                    <button type="button" className="folder-action-item folder-action-item--danger" disabled={replacementBusy} onClick={() => deleteAllSessions(project)}>Delete all</button>
                    <button type="button" className="folder-action-item" disabled={replacementBusy} onClick={() => setConfirmingDeleteAllPath(null)}>Cancel</button>
                  </div>
                ) : (
                  <button type="button" role="menuitem" className="folder-action-item folder-action-item--danger" disabled={replacementBusy} onClick={() => setConfirmingDeleteAllPath(project.path)}>Delete all sessions</button>
                )}
                <button type="button" role="menuitem" className="folder-action-item folder-action-item--danger" disabled={isActive || replacementBusy} onClick={() => forgetFolder(project)}>Forget folder</button>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>
    );
  };

  const renderFolderGroup = (project: KnownProject) => {
    const isActive = isActiveProject(project.path);
    const previewOnly = isActive && runtime.status === 'disconnected';
    const expanded = folderExpanded(project.path);
    const sessionList = sortedSessions.length > 100
      ? folderScrollParent
        ? <Virtuoso customScrollParent={folderScrollParent} data={sortedSessions} defaultItemHeight={compactSessions ? 33 : 69} itemContent={(_index, session) => renderSessionListItem(session)} />
        : <div className="folder-preview-state">Preparing session list…</div>
      : sortedSessions.map(renderSessionListItem);
    const collapsedSessions = (isActive ? sessions : previewsByPath[project.path])?.filter((session) => session.active || Boolean(session.attention));
    return (
      <section className={`folder-group${isActive ? ' folder-group--active' : ''}${expanded ? ' folder-group--expanded' : ''}`} key={project.path}>
        {renderFolderHeader(project)}
        {expanded && isActive && !previewOnly && (
          <div className="session-list folder-children" aria-label="Sessions">
            {sessionList}
            {sessions.length === 0 && (
              <div className="empty-sessions empty-sessions--inline">
                <FileText size={19} />
                <p>{query ? 'No matching sessions' : 'No sessions yet'}</p>
                <span>{runtime.status === 'auth-required' ? 'Saved sessions remain available; authenticate to prompt Pi.' : 'Create a session to start working with Pi.'}</span>
              </div>
            )}
          </div>
        )}
        {expanded && (!isActive || previewOnly) && (
          <div className="folder-children folder-preview-list">
            {renderPreviewRows(project, previewOnly ? sessions : undefined)}
          </div>
        )}
        {!expanded && collapsedSessions && collapsedSessions.length > 0 && (
          <div className="folder-children folder-preview-list folder-preview-list--attention" role="group" aria-label={`Active sessions in ${project.name}`}>
            {renderPreviewRows(project, collapsedSessions)}
          </div>
        )}
      </section>
    );
  };

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''} ${expandedVisible ? 'sidebar--expanded-visible' : ''}`} aria-label="Primary navigation">
      <div className="window-drag-region" />
      <div className={`brand-row ${collapsed || !renderExpanded ? 'brand-row--compact' : ''}`}>
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
        {!collapsed && renderExpanded && <AppTooltip content="Settings" wrapTrigger triggerClassName="sidebar-settings-tooltip">
          <button className="sidebar-settings-button icon-button" type="button" aria-label="Settings" onClick={() => openSettings(true)}>
            <Settings size={16} strokeWidth={2} />
          </button>
        </AppTooltip>}
        <IconButton label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={onToggle}>
          {collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
        </IconButton>
      </div>

      {renderExpanded && (
        <div ref={expandedSectionsRef} className="sidebar-expanded-sections sidebar-expanded-only">
          <Tabs.Root value={sidebarTab} onValueChange={(value) => setSidebarTab(value as typeof sidebarTab)} className="sidebar-tabs">
            <Tabs.Content value="sessions" className="sidebar-tab-content sidebar-session-panel">
          <div className="sidebar-tab-toolbar session-toolbar">
            <label className="session-search sidebar-search">
              <Search size={15} aria-hidden="true" />
              <input className="icon-label" type="search" aria-label="Search sessions" placeholder="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} disabled={!runtime.project} />
            </label>
            <AppTooltip content="New session" wrapTrigger triggerClassName="sidebar-toolbar-action sidebar-toolbar-action--primary session-toolbar-action--new">
              <button type="button" aria-label="New session" disabled={!runtime.project || replacementBusy} onClick={createSession}><Plus size={15} /></button>
            </AppTooltip>
            <AppTooltip content="Open project" wrapTrigger triggerClassName="sidebar-toolbar-action session-toolbar-action--open">
              <button type="button" aria-label="Open project" disabled={replacementBusy} onClick={selectProject}><FolderOpen size={15} /></button>
            </AppTooltip>
          </div>
          <div className="session-sort-row">
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

          <div ref={setFolderScrollParent} className="folder-list" aria-label="Projects">
            {visibleProjects.map((project) => renderFolderGroup(project))}
            {projects.length === 0 && (
              <div className="empty-sessions">
                <FileText size={19} />
                <p>No sessions yet</p>
                <span>{runtime.status === 'auth-required' ? 'Saved sessions remain available; authenticate to prompt Pi.' : runtime.project ? 'Create a session to start working with Pi.' : 'Open a project to start working with Pi.'}</span>
              </div>
            )}
          </div>
            </Tabs.Content>
            <Tabs.Content value="automations" className="sidebar-tab-content"><SidebarAutomations /></Tabs.Content>
            <Tabs.Content value="resources" className="sidebar-tab-content"><SidebarResources onOpenProject={selectProject} projectSelectionBusy={replacementBusy} /></Tabs.Content>
            <Tabs.List className="sidebar-primary-nav" aria-label="Sidebar destinations">
              <Tabs.Trigger value="sessions" className="sidebar-primary-trigger">Sessions</Tabs.Trigger>
              <Tabs.Trigger value="automations" className="sidebar-primary-trigger">Automations</Tabs.Trigger>
              <Tabs.Trigger value="resources" className="sidebar-primary-trigger">Resources</Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>
        </div>
      )}

      {collapsed && !renderExpanded && <nav className="nav-list">
        <AppTooltip content="Settings" wrapTrigger triggerClassName="sidebar-settings-tooltip">
          <button className="sidebar-settings-button sidebar-settings-rail-button" type="button" aria-label="Settings" onClick={() => openSettings(true)}><Settings size={18} /></button>
        </AppTooltip>
        <AppTooltip content="New session" wrapTrigger>
          <button className="new-session icon-only" type="button" aria-label="New session" disabled={!runtime.project || replacementBusy} onClick={createSession}><MessageSquarePlus size={17} /></button>
        </AppTooltip>
        <AppTooltip content="Open project" wrapTrigger><button type="button" aria-label="Open project" disabled={replacementBusy} onClick={selectProject}><FolderOpen size={18} /></button></AppTooltip>
      </nav>}

    </aside>
  );
}
