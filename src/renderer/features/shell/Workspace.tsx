import { FolderOpen, FolderSearch, GitPullRequest, PanelRightOpen, SearchCode, TerminalSquare } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { IconButton } from '../../components/IconButton';
import { Composer } from '../chat/Composer';
import { ConversationTimeline } from '../chat/ConversationTimeline';
import { ExtensionStatusRail } from '../chat/ExtensionStatusRail';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

const TerminalPanel = lazy(() => import('../terminal/TerminalPanel').then((module) => ({ default: module.TerminalPanel })));

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
  const [revealError, setRevealError] = useState<string | null>(null);
  const [projectPending, setProjectPending] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);

  const openProject = () => {
    if (!('piDesktop' in window) || projectPending) return;
    setProjectPending(true); setProjectError(null);
    void window.piDesktop.selectProject().then((state) => {
      setRuntime(state);
      if (state.project) setSidebarCollapsed(false);
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
  const showWelcome = !runtime.project && entryCount === 0;
  const conversationMode = runtime.project !== null || entryCount > 0;

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div>
          <span className="eyebrow">SESSION</span>
          <strong>{activeSession?.title ?? runtime.project?.name ?? 'Welcome'}</strong>
        </div>
        <div className="session-controls">
          <IconButton label="Show project in file browser" onClick={() => void revealProject()} disabled={!runtime.project}><FolderSearch size={17} /></IconButton>
          <IconButton label={terminalOpen ? 'Close terminal' : 'Open terminal'} onClick={toggleTerminal} disabled={!runtime.project?.trusted}><TerminalSquare size={17} /></IconButton>
          {inspectorCollapsed && <IconButton label="Open inspector" onClick={onToggleInspector}><PanelRightOpen size={17} /></IconButton>}
        </div>
      </header>
      <ExtensionStatusRail />
      {revealError && <div className="project-reveal-error" role="alert">{revealError}</div>}
      {projectError && <div className="project-reveal-error" role="alert">{projectError}</div>}

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
              <h1 id="welcome-title">What would you like Pi to do?</h1>
              <p>Open a repository, then inspect, edit, and verify with Pi.</p>
            </div>
            <div className="action-grid">
              <button className="action-card action-card--primary" type="button" disabled={projectPending} onClick={openProject}>
                <span className="action-icon"><FolderOpen size={19} /></span><strong>{projectPending ? 'Opening project…' : 'Open project'}</strong><small>Choose a local repository and establish its trust boundary.</small>
              </button>
              <button className="action-card" type="button" disabled={projectPending} onClick={openProject}><span className="action-icon"><SearchCode size={19} /></span><strong>Inspect codebase</strong><small>Trace structure, symbols, dependencies, and behavior with Pi.</small></button>
              <button className="action-card" type="button" disabled={projectPending} onClick={openProject}><span className="action-icon"><GitPullRequest size={19} /></span><strong>Ship a change</strong><small>Plan, edit, test, and review in one focused session.</small></button>
            </div>
          </>
        ) : entryCount > 0 ? <ConversationTimeline /> : <div className="conversation conversation--empty" aria-hidden="true" />}

        <Composer onOpenProject={openProject} />
      </section>
      {terminalOpen && <Suspense fallback={<div className="terminal-panel terminal-loading">Starting terminal…</div>}><TerminalPanel /></Suspense>}
    </main>
  );
}
