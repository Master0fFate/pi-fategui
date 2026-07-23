import {
  ArrowUp,
  ChevronDown,
  Code2,
  FolderOpen,
  PanelRightOpen,
  SearchCode,
  TerminalSquare,
} from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '../../components/IconButton';

interface WorkspaceProps {
  inspectorCollapsed: boolean;
  onToggleInspector: () => void;
}

const actions = [
  {
    title: 'Open project',
    description: 'Choose a local repository to begin.',
    icon: FolderOpen,
    primary: true,
  },
  {
    title: 'Inspect codebase',
    description: 'Explore structure, symbols, and usage.',
    icon: SearchCode,
  },
  {
    title: 'Work with Pi',
    description: 'Connect the real agent to your project.',
    icon: Code2,
  },
];

export function Workspace({ inspectorCollapsed, onToggleInspector }: WorkspaceProps) {
  const [draft, setDraft] = useState('');

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div>
          <span className="eyebrow">SESSION</span>
          <strong>Welcome</strong>
        </div>
        <div className="session-controls">
          <button type="button" className="model-button" disabled>
            Model <span>Not connected</span> <ChevronDown size={14} />
          </button>
          <div className="connection-state">
            <i /> Ready to connect
          </div>
          {inspectorCollapsed && (
            <IconButton label="Open inspector" onClick={onToggleInspector}>
              <PanelRightOpen size={17} />
            </IconButton>
          )}
        </div>
      </header>

      <section className="welcome" aria-labelledby="welcome-title">
        <div className="welcome-copy">
          <div className="welcome-symbol">π</div>
          <h1 id="welcome-title">What would you like Pi to do?</h1>
          <p>Open a project to start a focused coding session with the real Pi agent.</p>
        </div>

        <div className="action-grid">
          {actions.map(({ title, description, icon: Icon, primary }) => (
            <button className={`action-card ${primary ? 'action-card--primary' : ''}`} type="button" key={title}>
              <span className="action-icon"><Icon size={19} /></span>
              <strong>{title}</strong>
              <small>{description}</small>
            </button>
          ))}
        </div>

        <form className="composer" onSubmit={(event) => event.preventDefault()}>
          <textarea
            aria-label="Message Pi"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask Pi about your project…"
            rows={2}
          />
          <div className="composer-toolbar">
            <div>
              <button type="button"><FolderOpen size={15} /> Project <ChevronDown size={13} /></button>
              <span className="toolbar-divider" />
              <button type="button"><TerminalSquare size={15} /> Terminal <ChevronDown size={13} /></button>
            </div>
            <div>
              <span className="shortcut">Ctrl/⌘ ↵</span>
              <button className="send-button" type="submit" aria-label="Send message" disabled={!draft.trim()}>
                <ArrowUp size={18} />
              </button>
            </div>
          </div>
        </form>
        <p className="composer-caption">Pi can inspect files and run tools after you open and trust a project.</p>
      </section>
    </main>
  );
}
