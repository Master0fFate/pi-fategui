import { getDesktopApi, getDesktopApiOptional, getWebApiOptional, hasCapability } from '../../platform/api';
import { useRuntimeStore as useWebWorkspaceStore, selectSessionView, canMutateNetwork, currentNetworkScope, type BoundedSnapshot } from '../../stores/runtimeStore';
import { thinkingLevelSchema } from '../../../shared/contracts/ipc';
import { GoalMaxRail } from '../goalmaxxing/GoalMaxRail';
import { NetworkConnectionControls } from '../connections/NetworkConnectionControls';
import { GoalMaxTaskStrip } from '../goalmaxxing/GoalMaxTaskStrip';
import { unavailableExplanation } from '../../platform/capabilityPolicy';
import { FolderOpen, FolderSearch, GitPullRequest, Globe2, KeyRound, PanelRightClose, PanelRightOpen, Search, SearchCode, TerminalSquare } from 'lucide-react';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ResizeHandle } from '../../components/ResizeHandle';
import { IconButton } from '../../components/IconButton';
import { Composer } from '../chat/Composer';
import { ConversationTimeline } from '../chat/ConversationTimeline';
import { ExtensionStatusRail } from '../chat/ExtensionStatusRail';
import { DetailExpansionToggle, detailSessionKey, type DetailExpansionCommand } from '../chat/detailExpansion';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useBrowserStore } from '../../stores/browserStore';
import { BROWSER_PANE_MAX, BROWSER_PANE_MIN, useUiStore } from '../../stores/uiStore';
import { BrowserWorkspace } from '../browser/BrowserWorkspace';
import { WorkspaceActivityPulse } from './WorkspaceActivityPulse';
import { WorkspaceBackground } from '../../background/BackgroundProvider';

const TerminalPanel = lazy(() => import('../terminal/TerminalPanel').then((module) => ({ default: module.TerminalPanel })));

const welcomeIntents = {
  inspect: {
    prompt: 'Inspect this codebase. Map its architecture, key entry points, dependencies, and verification workflow, then summarize the most important findings.',
    notice: 'Codebase inspection prompt ready. Review or refine it before sending.',
  },
  ship: {
    prompt: 'Help me ship a focused change in this project. Start by asking what behavior I want to change, then plan, implement, test, and review it.',
    notice: 'Change workflow prompt ready. Add the behavior you want, then send it to Pi.',
  },
} as const;

type WelcomeIntent = keyof typeof welcomeIntents;

interface WorkspaceProps {
  inspectorCollapsed: boolean;
  onToggleInspector: () => void;
}

export function Workspace(props: WorkspaceProps) {
  return getWebApiOptional() ? <BoundedWorkspace {...props} /> : <DesktopWorkspace {...props} />;
}

export const MAX_SESSION_EXPORT_BYTES = 1024 * 1024;
/** Export only already authorized snapshot excerpts. Never serialize the header or host configuration. */
export function boundedSessionExport(snapshot: BoundedSnapshot): string {
  const encoder = new TextEncoder();
  const header = 'Partial retained transcript — not a full session export.\nOnly current authorized text excerpts are included; media and omitted history are excluded.\nMaximum download: 1 MiB.\n\n';
  const clippedNotice = '\n[Export limit reached. Further retained excerpts are omitted.]\n';
  const chunks = [header];
  let bytes = encoder.encode(header).byteLength;
  const budget = MAX_SESSION_EXPORT_BYTES - encoder.encode(clippedNotice).byteLength;
  for (const item of snapshot.items) {
    const text = `${item.kind === 'tool' ? 'Tool' : item.role ?? 'Message'}${item.name ? `: ${item.name}` : ''}${item.clipped ? ' (clipped)' : ''}\n${item.text}\n\n`;
    const size = encoder.encode(text).byteLength;
    if (bytes + size > budget) { chunks.push(clippedNotice); break; }
    chunks.push(text); bytes += size;
  }
  return chunks.join('');
}

function BoundedWorkspace({ inspectorCollapsed, onToggleInspector }: WorkspaceProps) {
  const web = getWebApiOptional()!;
  const selected = useWebWorkspaceStore((state) => state.selected);
  const snapshot = useWebWorkspaceStore((state) => state.snapshot);
  const phase = useWebWorkspaceStore((state) => state.phase);
  const error = useWebWorkspaceStore((state) => state.error);
  const sessionView = useRuntimeStore(useShallow(selectSessionView));
  const views = useRuntimeStore((state) => state.networkViews);
  const busy = useRuntimeStore((state) => state.networkBusy);
  const pending = useRuntimeStore((state) => state.pendingReview);
  const mutationError = useRuntimeStore((state) => state.networkError);
  const selectionNotice = useRuntimeStore((state) => state.networkSelectionNotice);
  const [exportError, setExportError] = useState<string | null>(null);
  const terminalOpen = useUiStore((state) => state.terminalOpen);
  const toggleTerminal = useUiStore((state) => state.toggleTerminal);
  const mutate = useRuntimeStore((state) => state.runNetworkMutation);
  const omissions = snapshot?.header.omissions;
  const exportText = () => {
    const captured = currentNetworkScope();
    const current = useRuntimeStore.getState().snapshot;
    if (!captured || !current || getWebApiOptional() !== web || !web.isConnected
      || captured.header.serverEpoch !== web.serverEpoch || typeof URL.createObjectURL !== 'function') return;
    try {
      const url = URL.createObjectURL(new Blob([boundedSessionExport(current)], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'fate-session-retained.txt';
      document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setExportError(null);
    } catch { setExportError('Local text export is unavailable. No host files or configuration were requested.'); }
  };
  return <main className="workspace" aria-label="Fate web workspace">
    <header className="workspace-header"><div className="workspace-header-identity"><span className="eyebrow">SESSION · BOUNDED NETWORK</span>
      <strong>{sessionView.label ?? 'Select a registered workspace'}</strong></div>
      <IconButton label={terminalOpen ? 'Close terminal' : 'Open terminal'} terminalLabel="term" aria-pressed={terminalOpen}
        disabled={!selected || !hasCapability('manualTerminal')} title={!hasCapability('manualTerminal') ? unavailableExplanation.manualTerminal : undefined}
        onClick={toggleTerminal}><TerminalSquare size={17} /></IconButton>
      <IconButton label={inspectorCollapsed ? 'Open inspector' : 'Collapse inspector'} terminalLabel="panel" onClick={onToggleInspector}>
        {inspectorCollapsed ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}
      </IconButton>
    </header>
    <NetworkConnectionControls api={web} />
    {error ? <div className="runtime-notice" role="alert">{error} No current snapshot is confirmed.</div> : null}
    <div className="session-controls" aria-label="Host session and model controls">
      <label>Session<select aria-label="Selected session" value={sessionView.sessionId ?? ''} disabled={!canMutateNetwork(web, 'session.select') || views.sessions.status !== 'ready'}
        onChange={(event) => void mutate(web, 'session.select', (scope) => web.selectSession(scope, event.target.value))}>
        {views.sessions.status === 'ready' ? views.sessions.value.sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>) : <option value={sessionView.sessionId ?? ''}>Sessions {views.sessions.status}</option>}
      </select></label>
      <button type="button" disabled={!canMutateNetwork(web, 'session.select')} onClick={() => void mutate(web, 'session.select', (scope) => web.createSession(scope))}>New session</button>
      <label>Model<select aria-label="Selected model" value={views.models.status === 'ready' ? String(views.models.value.models.findIndex((model) => model.provider === sessionView.model?.provider && model.id === sessionView.model?.id)) : '-1'}
        disabled={!canMutateNetwork(web, 'runtime.configure') || views.models.status !== 'ready'} onChange={(event) => {
          if (views.models.status !== 'ready') return;
          const model = views.models.value.models[Number(event.target.value)];
          if (model) void mutate(web, 'runtime.configure', (scope) => web.setModel(scope, model.provider, model.id));
        }}><option value="-1">{views.models.status === 'ready' ? sessionView.model ? 'Current model not in host catalog' : 'No host model selected' : `Models ${views.models.status}`}</option>
        {views.models.status === 'ready' && views.models.value.models.map((model, index) => <option key={`${model.provider}:${model.id}`} value={index}>{model.name} · {model.provider}</option>)}
      </select></label>
      <label>Thinking<select aria-label="Thinking level" value={sessionView.thinkingLevel ?? ''} disabled={!canMutateNetwork(web, 'runtime.configure')} onChange={(event) => {
        const level = thinkingLevelSchema.safeParse(event.target.value); if (level.success) void mutate(web, 'runtime.configure', (scope) => web.setThinking(scope, level.data));
      }}>{sessionView.thinkingLevel === null && <option value="">Thinking level unknown</option>}{thinkingLevelSchema.options.map((level) => <option key={level}>{level}</option>)}</select></label>
      <button type="button" disabled={!sessionView.activeSessionRunning || !canMutateNetwork(web, 'runtime.abort')} onClick={() => void mutate(web, 'runtime.abort', (scope) => web.abort(scope))}>Stop host run</button>
      <button type="button" disabled={!currentNetworkScope() || !web.isConnected || snapshot?.header.serverEpoch !== web.serverEpoch || typeof URL.createObjectURL !== 'function'} onClick={exportText}>Export bounded session text</button>
    </div>
    {selectionNotice && <p role="status">{selectionNotice}</p>}
    <p className="bounded-note">Export is a partial retained transcript, at most 1 MiB. It includes only authorized snapshot text, not host configuration or private host-path metadata.</p>
    {exportError && <p role="alert">{exportError}</p>}
    <p className="bounded-note">The selected session is shared with other clients. Host work and provider cost may continue after client loss. A stop request is not proof of settlement.</p>
    {mutationError && <div role="alert"><p>{mutationError}</p>{pending && <><code>{pending.requestId}</code><p>Original target: {pending.scope.label} · {pending.sessionId}</p>
      <button type="button" disabled={busy || !web.isConnected} onClick={() => void useRuntimeStore.getState().reviewNetworkCommand(web)}>Review original command</button></>}</div>}
    {phase === 'synchronizing' && snapshot ? <p role="status">Refreshing. The view below is last confirmed and may be stale.</p> : null}
    {snapshot && <div className="bounded-note" role="note">Snapshot omissions:
      {omissions?.history && ' Older history omitted.'}{omissions?.media && ' Media omitted.'}
      {omissions?.clippedItems ? ` ${omissions.clippedItems} clipped items.` : ''}
      {omissions?.queueContents && ' Queue contents omitted.'}
      {omissions?.goalText && ' Goal text omitted.'}{omissions?.taskText && ' Task text omitted.'}
      {omissions?.agentText && ' Agent text omitted.'}{omissions?.taskRows && ' Task rows omitted.'}
      {omissions?.agentRows && ' Agent rows omitted.'}
      {snapshot.header.warnings.map((warning, index) => <span key={index}> {warning}</span>)}
    </div>}
    <div className="browser-thread-layout browser-thread-layout--idle"><div className="browser-thread-conversation">
      <section className="welcome welcome--conversation"><GoalMaxRail /><GoalMaxTaskStrip /><ConversationTimeline />
        <QueueControls />
        <Composer onOpenProject={() => undefined} connectionControlsMounted />
      </section>
    </div></div>
    {!snapshot && !error && <p role="status">{selected ? 'Loading a bounded workspace snapshot…' : 'Select a workspace to inspect it.'}</p>}
    {terminalOpen && <Suspense fallback={<div className="terminal-panel terminal-loading">Loading manual terminal…</div>}><TerminalPanel /></Suspense>}
  </main>;
}

function QueueControls() {
  const web = getWebApiOptional();
  const source = useRuntimeStore((state) => state.source);
  const phase = useRuntimeStore((state) => state.phase);
  const views = useRuntimeStore((state) => state.networkViews);
  const desktopQueue = useRuntimeStore((state) => state.queue);
  useRuntimeStore((state) => state.networkBusy);
  const rows = source === 'network' ? views.queue.status === 'ready'
    ? [...views.queue.value.items.map((row) => ({ ...row, group: 'pending' })), ...views.queue.value.held.map((row) => ({ ...row, group: 'held' })),
      ...views.queue.value.recovered.map((row) => ({ ...row, group: 'recovered — requires explicit review' }))] : null
    : (desktopQueue.items ?? []).map((row) => ({ ...row, group: 'pending', mediaOmitted: Boolean(row.images?.length), contextOmitted: false }));
  if (!web) return null; // Desktop Composer retains its existing rich queue controls.
  const act = async (row: NonNullable<typeof rows>[number], action: 'cancel' | 'edit' | 'steer' | 'followUp') => {
    const captured = currentNetworkScope();
    if (!captured || action === 'edit' && (row.mediaOmitted || row.contextOmitted)) return;
    const ok = await useRuntimeStore.getState().runNetworkMutation(web, 'queue.control', (scope) => web.mutateQueue(scope, { id: row.id, action }));
    const current = currentNetworkScope();
    if (ok && action === 'edit' && current?.scope.workspaceId === captured.scope.workspaceId
      && current.scope.workspaceGeneration === captured.scope.workspaceGeneration && current.sessionId === captured.sessionId) {
      useUiStore.getState().requestComposerDraft(row.text, true, 'Queue item removed for editing. Review the draft before sending; it was not replayed.');
    }
  };
  return <section aria-label="Host queue"><h2>Queue</h2>{phase !== 'observing' ? <p>Queue is stale; host work may continue.</p>
    : rows ? rows.length ? <ol>{rows.map((row) => <li key={`${row.group}:${row.id}`}><strong>{row.group} · {row.behavior}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{row.text}</p>
      {(row.mediaOmitted || row.contextOmitted) && <p>Attachment/context details omitted; text-only restoration is unavailable.</p>}
      {(['cancel', 'edit', 'steer', 'followUp'] as const).map((action) => <button type="button" key={action}
        disabled={!canMutateNetwork(web, 'queue.control') || action === 'edit' && (row.mediaOmitted || row.contextOmitted)} onClick={() => void act(row, action)}>
        {action === 'cancel' ? 'Remove queued item' : action === 'edit' ? 'Edit queued text' : action === 'steer' ? 'Send as steering' : 'Send as follow-up'}</button>)}
    </li>)}</ol> : <p>No canonical queue items returned.</p> : <p role="status">Queue read {views.queue.status}. Unknown is not empty.</p>}
  </section>;
}

function DesktopWorkspace({ inspectorCollapsed, onToggleInspector }: WorkspaceProps) {
  const { projectPath, projectName, projectTrusted, sessions } = useRuntimeStore(useShallow((state) => ({
    projectPath: state.runtime.project?.path ?? null,
    projectName: selectSessionView(state).label,
    projectTrusted: state.runtime.project?.trusted === true,
    sessions: state.runtime.sessions,
  })));
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const entryCount = useRuntimeStore((state) => state.timelineOrder.length);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const hasConversationDetails = useRuntimeStore((state) => state.visibleTimelineOrder.some((id) => {
    const kind = state.timelineById[id]?.kind;
    return kind === 'reasoning' || kind === 'tool';
  }));
  const currentDetailSession = detailSessionKey(projectPath, sessionId);
  const [detailCommand, setDetailCommand] = useState<DetailExpansionCommand>(() => ({ sessionKey: currentDetailSession, revision: 0, expanded: false }));
  useLayoutEffect(() => {
    setDetailCommand((current) => current.sessionKey === currentDetailSession
      ? current
      : { sessionKey: currentDetailSession, revision: 0, expanded: false });
  }, [currentDetailSession]);
  const expansionCommand = detailCommand.sessionKey === currentDetailSession
    ? detailCommand
    : { sessionKey: currentDetailSession, revision: 0, expanded: false };
  const toggleDetails = () => setDetailCommand((current) => {
    const inSession = current.sessionKey === currentDetailSession
      ? current
      : { sessionKey: currentDetailSession, revision: 0, expanded: false };
    return { sessionKey: currentDetailSession, revision: inSession.revision + 1, expanded: !inSession.expanded };
  });
  const lastError = useRuntimeStore((state) => state.lastError);
  const activeSessionTitle = useMemo(() => sessions?.find((session) => session.active)?.title, [sessions]);
  const terminalOpen = useUiStore((state) => state.terminalOpen);
  const toggleTerminal = useUiStore((state) => state.toggleTerminal);
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed);
  const requestComposerDraft = useUiStore((state) => state.requestComposerDraft);
  const browserOpen = useUiStore((state) => state.browserOpen);
  const setBrowserOpen = useUiStore((state) => state.setBrowserOpen);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);
  const browserPaneWidth = useUiStore((state) => state.browserPaneWidth);
  const setBrowserPaneWidth = useUiStore((state) => state.setBrowserPaneWidth);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [projectPending, setProjectPending] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [connectRequest, setConnectRequest] = useState(0);

  useEffect(() => {
    setRevealError(null);
    setProjectError(null);
  }, [projectPath]);

  const openProject = (intent?: WelcomeIntent) => {
    if (!getDesktopApiOptional() || projectPending) { setProjectError('The native project picker is unavailable. Select a registered workspace on the host.'); return; }
    setProjectPending(true); setProjectError(null);
    void getDesktopApi().selectProject().then((state) => {
      setRuntime(state);
      if (state.project) {
        setSidebarCollapsed(false);
        const starter = intent ? welcomeIntents[intent] : null;
        if (starter) requestComposerDraft(starter.prompt, true, starter.notice);
      }
    }).catch((error: unknown) => {
      setProjectError(error instanceof Error ? error.message : 'The project could not be opened.');
    }).finally(() => setProjectPending(false));
  };

  const revealProject = async () => {
    if (!hasCapability('localFileOpen') || typeof getDesktopApiOptional()?.revealProject !== 'function') { setRevealError(unavailableExplanation.localFileOpen); return; }
    const revealProjectPath = projectPath;
    setRevealError(null);
    try {
      await getDesktopApi().revealProject();
    } catch (error) {
      if (useRuntimeStore.getState().runtime.project?.path !== revealProjectPath) return;
      setRevealError(error instanceof Error && error.message
        ? error.message
        : 'The project could not be shown in the file browser. Open it again and retry.');
    }
  };
  const toggleBrowser = () => {
    if (!projectTrusted || !hasCapability('nativeBrowser') || !getDesktopApiOptional()) return;
    const opening = !browserOpen;
    setBrowserOpen(opening);
    if (opening) {
      void getDesktopApi().setBrowserMode('agent').then((state) => useBrowserStore.getState().hydrate(state)).catch((error: unknown) => {
        useBrowserStore.getState().setError(error instanceof Error ? error.message : 'The browser could not change state.');
      });
    }
  };
  const projectPresent = projectPath !== null;
  const showWelcome = !projectPresent && entryCount === 0;
  const conversationMode = projectPresent || entryCount > 0;
  const browserAvailable = projectTrusted && hasCapability('nativeBrowser');
  const showBrowser = browserAvailable && browserOpen;
  const conversationSurface = (
    <section className={`welcome ${conversationMode ? 'welcome--conversation' : ''}`} aria-labelledby={showWelcome ? 'welcome-title' : undefined}>
      {lastError && (
        <div className="runtime-notice" role="alert">
          <strong>{lastError.message}</strong>
          {lastError.actionable && <span>{lastError.actionable}</span>}
        </div>
      )}
      {showWelcome ? (
        <>
          <div className="welcome-copy">
            <div className="welcome-symbol" aria-hidden="true">ƒ</div>
            <h1 id="welcome-title">Start with your AI connection</h1>
            <p>Connect a provider, then open a repository to inspect, edit, and verify with Pi.</p>
          </div>
          <div className="action-grid">
            <button className="action-card action-card--primary" type="button" onClick={() => setConnectRequest((request) => request + 1)}>
              <span className="action-icon"><KeyRound size={19} /></span><strong>Connect your AI</strong><small>Sign in with OAuth or add an API key. No Pi terminal is needed.</small>
            </button>
            <button className="action-card" type="button" disabled={projectPending} onClick={() => openProject()}>
              <span className="action-icon"><FolderOpen size={19} /></span><strong>{projectPending ? 'Opening project…' : 'Open project'}</strong><small>Choose a local repository and establish its trust boundary.</small>
            </button>
            <button className="action-card" type="button" disabled={projectPending} onClick={() => openProject('inspect')}><span className="action-icon"><SearchCode size={19} /></span><strong>Inspect codebase</strong><small>Trace structure, symbols, dependencies, and behavior with Pi.</small></button>
            <button className="action-card" type="button" disabled={projectPending} onClick={() => openProject('ship')}><span className="action-icon"><GitPullRequest size={19} /></span><strong>Ship a change</strong><small>Plan, edit, test, and review in one focused session.</small></button>
          </div>
        </>
      ) : entryCount > 0 ? <ConversationTimeline expansionCommand={expansionCommand} /> : <div className="conversation conversation--empty" aria-hidden="true" />}
      <Composer onOpenProject={() => openProject()} connectRequest={connectRequest} />
    </section>
  );

  return (
    <main className="workspace">
      <WorkspaceBackground />
      <header className="workspace-header">
        <div className="workspace-header-drag">
          <div className="workspace-header-identity">
            <span className="eyebrow">SESSION</span>
            <strong>{activeSessionTitle ?? projectName ?? 'Welcome'}</strong>
            <WorkspaceActivityPulse />
          </div>
          <div className="session-controls">
            <IconButton
              label="Open command palette"
              terminalLabel="cmd"
              className="workspace-command-palette"
              onClick={() => setPaletteOpen(true)}
            ><Search size={17} /></IconButton>
            <IconButton
              label={showBrowser ? 'Close browser' : 'Open browser'}
              terminalLabel="web"
              className="workspace-browser-toggle"
              aria-pressed={showBrowser}
              disabled={!browserAvailable}
              title={!hasCapability('nativeBrowser') ? unavailableExplanation.nativeBrowser : undefined}
              onClick={toggleBrowser}
            ><Globe2 size={17} /></IconButton>
            <IconButton label="Show project in file browser" terminalLabel="dir" onClick={() => void revealProject()} disabled={!projectPresent || !hasCapability('localFileOpen')} title={!hasCapability('localFileOpen') ? unavailableExplanation.localFileOpen : undefined}><FolderSearch size={17} /></IconButton>
            <IconButton
              label={terminalOpen ? 'Close terminal' : 'Open terminal'}
              terminalLabel="term"
              className="workspace-terminal-toggle"
              aria-pressed={terminalOpen}
              onClick={toggleTerminal}
              disabled={!projectTrusted || !hasCapability('manualTerminal')}
              title={!hasCapability('manualTerminal') ? unavailableExplanation.manualTerminal : undefined}
            ><TerminalSquare size={17} /></IconButton>
            <IconButton
              label={inspectorCollapsed ? 'Open inspector' : 'Collapse inspector'}
              terminalLabel="panel"
              className="workspace-inspector-toggle"
              aria-pressed={!inspectorCollapsed}
              onClick={onToggleInspector}
            >{inspectorCollapsed ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}</IconButton>
          </div>
        </div>
        <div className="workspace-header-drag-tail" aria-hidden="true" />
      </header>
      {!showBrowser && <div className="workspace-status-row">
        {hasConversationDetails && <DetailExpansionToggle command={expansionCommand} onToggle={toggleDetails} />}
        <ExtensionStatusRail />
      </div>}
      {!hasCapability('nativeBrowser') || !hasCapability('manualTerminal') || !hasCapability('localFileOpen')
        ? <div className="project-reveal-error" role="status">Native features unavailable: {[
          !hasCapability('nativeBrowser') && 'browser', !hasCapability('manualTerminal') && 'terminal',
          !hasCapability('localFileOpen') && 'local file opening',
        ].filter(Boolean).join(', ')}. This host does not support them.</div> : null}
      {revealError && <div className="project-reveal-error" role="alert">{revealError}</div>}
      {projectError && <div className="project-reveal-error" role="alert">{projectError}</div>}

      {/* The thread column keeps a stable mount here: the browser pane is
          added and removed as siblings. Swapping the wrapper instead would
          remount the conversation and reset its scroll position. */}
      <div
        className={`browser-thread-layout${showBrowser ? '' : ' browser-thread-layout--idle'}`}
        data-testid={showBrowser ? 'browser-thread-layout' : undefined}
      >
        <div className="browser-thread-conversation">{conversationSurface}</div>
        {showBrowser && (
          <>
            <ResizeHandle
              label="Resize chat and browser"
              value={browserPaneWidth}
              minimum={BROWSER_PANE_MIN}
              maximum={BROWSER_PANE_MAX}
              direction={-1}
              onChange={setBrowserPaneWidth}
              onReset={() => setBrowserPaneWidth(520)}
            />
            <div className="browser-thread-preview" style={{ flexBasis: `${browserPaneWidth}px` }}><BrowserWorkspace /></div>
          </>
        )}
      </div>
      {terminalOpen && hasCapability('manualTerminal') && <Suspense fallback={<div className="terminal-panel terminal-loading">Starting terminal…</div>}><TerminalPanel /></Suspense>}
    </main>
  );
}
