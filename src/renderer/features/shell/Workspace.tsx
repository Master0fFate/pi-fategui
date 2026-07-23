import { Code2, FolderOpen, PanelRightOpen, SearchCode, TerminalSquare } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { IconButton } from '../../components/IconButton';
import { Composer } from '../chat/Composer';
import { ConversationTimeline } from '../chat/ConversationTimeline';
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
  const connected = runtime.status === 'ready';
  const activeSession = runtime.sessions?.find((session) => session.active);
  const terminalOpen = useUiStore((state) => state.terminalOpen);
  const toggleTerminal = useUiStore((state) => state.toggleTerminal);
  const setInspectorTab = useUiStore((state) => state.setInspectorTab);
  const setInspectorCollapsed = useUiStore((state) => state.toggleInspector);

  const openProject = () => {
    if ('piDesktop' in window) void window.piDesktop.selectProject().then(setRuntime);
  };

  const inspectCodebase = () => {
    setInspectorTab('files');
    if (inspectorCollapsed) setInspectorCollapsed();
  };
  const focusComposer = () => document.querySelector<HTMLTextAreaElement>('#pi-composer')?.focus();

  const statusLabel = runtime.status === 'disconnected' ? 'Ready to connect'
    : runtime.status === 'initializing' ? 'Initializing Pi…'
    : runtime.status === 'auth-required' ? 'Authentication required'
    : runtime.status === 'error' ? 'Connection error'
    : runtime.streaming ? 'Pi is working' : 'Connected';

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div>
          <span className="eyebrow">SESSION</span>
          <strong>{activeSession?.title ?? runtime.project?.name ?? 'Welcome'}</strong>
        </div>
        <div className="session-controls">
          <select
            className="model-select"
            aria-label="Model"
            disabled={!connected || runtime.streaming}
            value={runtime.model ? `${runtime.model.provider}/${runtime.model.id}` : ''}
            onChange={(event) => {
              const model = runtime.models.find((item) => `${item.provider}/${item.id}` === event.target.value);
              if (model && 'piDesktop' in window) void window.piDesktop.setModel(model.provider, model.id).then(setRuntime);
            }}
          >
            {!runtime.model && <option value="">Not connected</option>}
            {runtime.models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}
          </select>
          <select
            className="model-select thinking-select"
            aria-label="Thinking level"
            disabled={!connected || runtime.streaming}
            value={runtime.thinkingLevel}
            onChange={(event) => {
              if ('piDesktop' in window) void window.piDesktop.setThinkingLevel(event.target.value as typeof runtime.thinkingLevel).then(setRuntime);
            }}
          >
            {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
          <div className={`connection-state connection-state--${runtime.status}`}><i /> {statusLabel}</div>
          <IconButton label={terminalOpen ? 'Close terminal' : 'Open terminal'} onClick={toggleTerminal} disabled={!runtime.project?.trusted}><TerminalSquare size={17} /></IconButton>
          {inspectorCollapsed && <IconButton label="Open inspector" onClick={onToggleInspector}><PanelRightOpen size={17} /></IconButton>}
        </div>
      </header>

      <section className={`welcome ${entryCount > 0 ? 'welcome--conversation' : ''}`} aria-labelledby="welcome-title">
        {entryCount === 0 ? (
          <>
            <div className="welcome-copy">
              <div className="welcome-symbol">π</div>
              <h1 id="welcome-title">What would you like Pi to do?</h1>
              <p>{runtime.project ? 'Start a focused coding task in this project.' : 'Open a project to start a focused coding session with the real Pi agent.'}</p>
            </div>
            <div className="action-grid">
              <button className="action-card action-card--primary" type="button" onClick={openProject}>
                <span className="action-icon"><FolderOpen size={19} /></span><strong>Open project</strong><small>Choose and explicitly trust a local repository.</small>
              </button>
              <button className="action-card" type="button" disabled={!connected} onClick={inspectCodebase}><span className="action-icon"><SearchCode size={19} /></span><strong>Inspect codebase</strong><small>Explore structure, symbols, and usage.</small></button>
              <button className="action-card" type="button" disabled={!connected} onClick={focusComposer}><span className="action-icon"><Code2 size={19} /></span><strong>Work with Pi</strong><small>Use the authenticated real Pi runtime.</small></button>
            </div>
          </>
        ) : <ConversationTimeline />}

        {lastError && entryCount === 0 && (
          <div className="runtime-notice" role="alert">
            <strong>{lastError.message}</strong>
            {lastError.actionable && <span>{lastError.actionable}</span>}
          </div>
        )}
        <Composer onOpenProject={openProject} />
      </section>
      {terminalOpen && <Suspense fallback={<div className="terminal-panel terminal-loading">Starting terminal…</div>}><TerminalPanel /></Suspense>}
    </main>
  );
}
