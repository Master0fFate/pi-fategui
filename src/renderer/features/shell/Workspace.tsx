import { FolderOpen, FolderSearch, GitPullRequest, Globe2, KeyRound, PanelRightClose, PanelRightOpen, Search, SearchCode, TerminalSquare } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { ResizeHandle } from '../../components/ResizeHandle';
import { IconButton } from '../../components/IconButton';
import { Composer } from '../chat/Composer';
import { ConversationTimeline } from '../chat/ConversationTimeline';
import { ExtensionStatusRail } from '../chat/ExtensionStatusRail';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useBrowserStore } from '../../stores/browserStore';
import { BROWSER_PANE_MAX, BROWSER_PANE_MIN, useUiStore } from '../../stores/uiStore';
import { BrowserWorkspace } from '../browser/BrowserWorkspace';
import { WorkspaceActivityPulse } from './WorkspaceActivityPulse';

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

export function Workspace({ inspectorCollapsed, onToggleInspector }: WorkspaceProps) {
  const runtime = useRuntimeStore((state) => state.runtime);
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const entryCount = useRuntimeStore((state) => state.timelineOrder.length);
  const lastError = useRuntimeStore((state) => state.lastError);
  const activeSession = runtime.sessions?.find((session) => session.active);
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

  const openProject = (intent?: WelcomeIntent) => {
    if (!('piDesktop' in window) || projectPending) return;
    setProjectPending(true); setProjectError(null);
    void window.piDesktop.selectProject().then((state) => {
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
    if (!('piDesktop' in window) || typeof window.piDesktop.revealProject !== 'function') return;
    setRevealError(null);
    try {
      await window.piDesktop.revealProject();
    } catch (error) {
      setRevealError(error instanceof Error && error.message
        ? error.message
        : 'The project could not be shown in the file browser. Open it again and retry.');
    }
  };
  const toggleBrowser = () => {
    if (!runtime.project?.trusted || !('piDesktop' in window)) return;
    const opening = !browserOpen;
    setBrowserOpen(opening);
    if (opening) {
      void window.piDesktop.setBrowserMode('agent').then((state) => useBrowserStore.getState().hydrate(state)).catch((error: unknown) => {
        useBrowserStore.getState().setError(error instanceof Error ? error.message : 'The browser could not change state.');
      });
    }
  };
  const showWelcome = !runtime.project && entryCount === 0;
  const conversationMode = runtime.project !== null || entryCount > 0;
  const browserAvailable = runtime.project?.trusted === true;
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
      ) : entryCount > 0 ? <ConversationTimeline /> : <div className="conversation conversation--empty" aria-hidden="true" />}
      <Composer onOpenProject={() => openProject()} connectRequest={connectRequest} />
    </section>
  );

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div className="workspace-header-identity">
          <span className="eyebrow">SESSION</span>
          <strong>{activeSession?.title ?? runtime.project?.name ?? 'Welcome'}</strong>
          <WorkspaceActivityPulse />
        </div>
        <div className="session-controls">
          <IconButton
            label="Open command palette"
            className="workspace-command-palette"
            onClick={() => setPaletteOpen(true)}
          ><Search size={17} /></IconButton>
          <IconButton
            label={showBrowser ? 'Close browser' : 'Open browser'}
            className="workspace-browser-toggle"
            aria-pressed={showBrowser}
            disabled={!browserAvailable}
            onClick={toggleBrowser}
          ><Globe2 size={17} /></IconButton>
          <IconButton label="Show project in file browser" onClick={() => void revealProject()} disabled={!runtime.project}><FolderSearch size={17} /></IconButton>
          <IconButton
            label={terminalOpen ? 'Close terminal' : 'Open terminal'}
            className="workspace-terminal-toggle"
            aria-pressed={terminalOpen}
            onClick={toggleTerminal}
            disabled={!runtime.project?.trusted}
          ><TerminalSquare size={17} /></IconButton>
          <IconButton
            label={inspectorCollapsed ? 'Open inspector' : 'Collapse inspector'}
            className="workspace-inspector-toggle"
            aria-pressed={!inspectorCollapsed}
            onClick={onToggleInspector}
          >{inspectorCollapsed ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}</IconButton>
        </div>
      </header>
      {!showBrowser && <ExtensionStatusRail />}
      {revealError && <div className="project-reveal-error" role="alert">{revealError}</div>}
      {projectError && <div className="project-reveal-error" role="alert">{projectError}</div>}

      {showBrowser ? (
        <div className="browser-thread-layout" data-testid="browser-thread-layout">
          <div className="browser-thread-conversation">{conversationSurface}</div>
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
        </div>
      ) : conversationSurface}
      {terminalOpen && <Suspense fallback={<div className="terminal-panel terminal-loading">Starting terminal…</div>}><TerminalPanel /></Suspense>}
    </main>
  );
}
