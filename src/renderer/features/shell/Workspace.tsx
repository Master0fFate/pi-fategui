import {
  ArrowUp, Brain, Code2, FolderOpen, PanelRightOpen, SearchCode, Square, TerminalSquare,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { IconButton } from '../../components/IconButton';
import { useRuntimeStore } from '../../stores/runtimeStore';

interface WorkspaceProps {
  inspectorCollapsed: boolean;
  onToggleInspector: () => void;
}

export function Workspace({ inspectorCollapsed, onToggleInspector }: WorkspaceProps) {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const runtime = useRuntimeStore((state) => state.runtime);
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const messagesById = useRuntimeStore((state) => state.messagesById);
  const messageOrder = useRuntimeStore((state) => state.messageOrder);
  const reasoning = useRuntimeStore((state) => state.reasoningByMessageId);
  const lastError = useRuntimeStore((state) => state.lastError);
  const messages = useMemo(() => messageOrder.map((id) => messagesById[id]).filter(Boolean), [messageOrder, messagesById]);
  const connected = runtime.status === 'ready';

  const openProject = () => {
    if ('piDesktop' in window) void window.piDesktop.selectProject().then(setRuntime);
  };
  const submit = (behavior: 'prompt' | 'steer' | 'followUp' = 'prompt') => {
    const text = draft.trim();
    if (!text || !('piDesktop' in window)) return;
    setSubmitting(true);
    void window.piDesktop.prompt({ text, behavior }).then((acceptance) => {
      if (acceptance.accepted) setDraft('');
    }).finally(() => setSubmitting(false));
  };

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
          <strong>{runtime.project?.name ?? 'Welcome'}</strong>
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
          {inspectorCollapsed && <IconButton label="Open inspector" onClick={onToggleInspector}><PanelRightOpen size={17} /></IconButton>}
        </div>
      </header>

      <section className={`welcome ${messages.length > 0 ? 'welcome--conversation' : ''}`} aria-labelledby="welcome-title">
        {messages.length === 0 ? (
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
              <button className="action-card" type="button" disabled={!connected}><span className="action-icon"><SearchCode size={19} /></span><strong>Inspect codebase</strong><small>Explore structure, symbols, and usage.</small></button>
              <button className="action-card" type="button" disabled={!connected}><span className="action-icon"><Code2 size={19} /></span><strong>Work with Pi</strong><small>Use the authenticated real Pi runtime.</small></button>
            </div>
          </>
        ) : (
          <div className="conversation" aria-live="polite">
            {messages.map((message) => (
              <article className={`chat-message chat-message--${message!.role}`} key={message!.id}>
                <span>{message!.role === 'user' ? 'You' : message!.role === 'assistant' ? 'Pi' : 'Tool'}</span>
                {reasoning[message!.id] && <details><summary><Brain size={13} /> Reasoning</summary><pre>{reasoning[message!.id]}</pre></details>}
                <pre>{message!.text || (runtime.streaming ? '…' : '')}</pre>
              </article>
            ))}
          </div>
        )}

        {lastError && (
          <div className="runtime-notice" role="alert">
            <strong>{lastError.message}</strong>
            {lastError.actionable && <span>{lastError.actionable}</span>}
          </div>
        )}

        <form className="composer" onSubmit={(event) => { event.preventDefault(); submit('prompt'); }}>
          <textarea aria-label="Message Pi" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={connected ? 'Ask Pi about your project…' : 'Open and trust a project to begin…'} rows={2} disabled={!connected} />
          <div className="composer-toolbar">
            <div><button type="button" onClick={openProject}><FolderOpen size={15} /> {runtime.project?.name ?? 'Project'}</button><span className="toolbar-divider" /><button type="button" disabled><TerminalSquare size={15} /> Terminal</button></div>
            <div>
              {runtime.streaming && draft.trim() && <><button type="button" onClick={() => submit('steer')}>Steer</button><button type="button" onClick={() => submit('followUp')}>Queue</button></>}
              <span className="shortcut">Ctrl/⌘ ↵</span>
              {runtime.streaming ? (
                <button className="send-button stop-button" type="button" aria-label="Stop Pi" onClick={() => { if ('piDesktop' in window) void window.piDesktop.abort(); }}><Square size={14} fill="currentColor" /></button>
              ) : (
                <button className="send-button" type="submit" aria-label="Send message" disabled={!connected || !draft.trim() || submitting}><ArrowUp size={18} /></button>
              )}
            </div>
          </div>
        </form>
        <p className="composer-caption">{runtime.project?.trusted ? 'Trusted project · Pi tools run in the selected directory.' : 'Pi can inspect files and run tools only after you trust a project.'}</p>
      </section>
    </main>
  );
}
