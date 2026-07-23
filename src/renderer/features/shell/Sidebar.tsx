import {
  Archive,
  Bot,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  GitFork,
  MessageSquarePlus,
  Search,
  Settings,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SessionSummary } from '../../../shared/contracts/ipc';
import { IconButton } from '../../components/IconButton';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

const navigation = [
  { label: 'Sessions', icon: Bot, active: true },
  { label: 'Project', icon: FolderOpen },
  { label: 'Templates', icon: Sparkles },
];

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const runtime = useRuntimeStore((state) => state.runtime);
  const setRuntime = useRuntimeStore((state) => state.setRuntime);
  const openSettings = useUiStore((state) => state.setSettingsOpen);
  const [query, setQuery] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>(runtime.sessions ?? []);
  const capabilities = runtime.sessionCapabilities;
  const forkPoint = runtime.forkPoints?.at(-1);
  const sessionBusy = runtime.streaming || runtime.sessionOperation === true || actionBusy;

  useEffect(() => setSessions(runtime.sessions ?? []), [runtime.sessions]);
  useEffect(() => {
    if (!runtime.project || !('piDesktop' in window)) return;
    let active = true;
    const timer = setTimeout(() => {
      void window.piDesktop.listSessions(query).then((items) => { if (active) setSessions(items); });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [query, runtime.project]);

  const selectProject = () => {
    if ('piDesktop' in window) void window.piDesktop.selectProject().then(setRuntime);
  };
  const invokeState = (operation: Promise<ReturnType<typeof useRuntimeStore.getState>['runtime'] | null>) => {
    setActionBusy(true);
    void operation
      .then((state) => { if (state) setRuntime(state); })
      .catch(() => undefined) // The main process also emits the normalized error into the timeline.
      .finally(() => setActionBusy(false));
  };

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`} aria-label="Primary navigation">
      <div className="window-drag-region" />
      <div className="brand-row">
        {!collapsed && <div className="brand-mark" aria-hidden="true">π</div>}
        {!collapsed && (
          <div className="brand-copy">
            <strong>Pi Desktop</strong>
            <span>{runtime.project?.name ?? 'No project open'}</span>
          </div>
        )}
        <IconButton label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={onToggle}>
          {collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
        </IconButton>
      </div>

      {!collapsed && (
        <button className="primary-button" type="button" onClick={selectProject}>
          <FolderOpen size={16} /> Open project
        </button>
      )}
      <button
        className={`new-session ${collapsed ? 'icon-only' : ''}`}
        type="button"
        disabled={!runtime.project || sessionBusy}
        onClick={() => 'piDesktop' in window && invokeState(window.piDesktop.newSession())}
      >
        <MessageSquarePlus size={17} />
        {!collapsed && 'New session'}
      </button>

      {!collapsed && (
        <>
          <label className="session-search">
            <Search size={15} />
            <input aria-label="Search sessions" placeholder="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} disabled={!runtime.project} />
          </label>

          <div className="session-list" aria-label="Sessions">
            {sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                className={session.active ? 'active' : ''}
                disabled={session.active || sessionBusy}
                onClick={() => 'piDesktop' in window && invokeState(window.piDesktop.switchSession(session.id))}
              >
                <span>{session.title}</span>
                <small>{session.messageCount} messages · {new Date(session.modifiedAt).toLocaleDateString()}</small>
              </button>
            ))}
          </div>

          {runtime.sessionId && (
            <div className="session-actions" aria-label="Session actions">
              {capabilities?.fork && forkPoint && (
                <button type="button" disabled={sessionBusy} onClick={() => 'piDesktop' in window && invokeState(window.piDesktop.forkSession(forkPoint.entryId))}><GitFork size={13} /> Fork</button>
              )}
              {capabilities?.clone && (
                <button type="button" disabled={sessionBusy} onClick={() => 'piDesktop' in window && invokeState(window.piDesktop.cloneSession())}><Copy size={13} /> Clone</button>
              )}
              {capabilities?.import && (
                <button type="button" disabled={sessionBusy} onClick={() => 'piDesktop' in window && invokeState(window.piDesktop.importSession())}><Upload size={13} /> Import</button>
              )}
              {capabilities?.compact && (
                <button type="button" disabled={sessionBusy} onClick={() => 'piDesktop' in window && invokeState(window.piDesktop.compact())}><Archive size={13} /> Compact</button>
              )}
            </div>
          )}

          {((runtime.commands?.length ?? 0) > 0 || (runtime.skills?.length ?? 0) > 0) && (
            <section className="resource-list" aria-label="Skills and prompt templates">
              <strong>Resources</strong>
              {runtime.commands?.slice(0, 4).map((command) => <div key={`prompt:${command.name}`} title={command.description}><Sparkles size={11} /><span>/{command.name}</span></div>)}
              {runtime.skills?.slice(0, 4).map((skill) => <div key={`skill:${skill.name}`} title={skill.description}><Bot size={11} /><span>{skill.name}</span></div>)}
            </section>
          )}

          {(runtime.branches?.length ?? 0) > 1 && (
            <section className="branch-list" aria-label="Conversation branches">
              <strong>Branches</strong>
              {runtime.branches!.slice(-20).map((branch) => (
                <div key={branch.id} className={branch.active ? 'active' : ''} style={{ paddingLeft: Math.min(branch.depth, 5) * 8 }} title={branch.preview || branch.kind}>
                  <GitFork size={11} /> <span>{branch.label || branch.preview || branch.kind}</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {!collapsed && sessions.length === 0 && (
        <div className="empty-sessions">
          <FileText size={19} />
          <p>{query ? 'No matching sessions' : 'No sessions yet'}</p>
          <span>{runtime.status === 'auth-required' ? 'Saved sessions remain available; authenticate to prompt Pi.' : runtime.project ? 'Create a session to start working with Pi.' : 'Open a project to start working with Pi.'}</span>
        </div>
      )}

      {collapsed && <nav className="nav-list">{navigation.map(({ label, icon: Icon, active }) => <button key={label} type="button" className={active ? 'active' : ''} title={label}><Icon size={18} /></button>)}</nav>}

      <div className="sidebar-footer">
        <button type="button" title={collapsed ? 'Settings' : undefined} onClick={() => openSettings(true)}>
          <Settings size={18} />
          {!collapsed && <span>Settings</span>}
        </button>
      </div>
    </aside>
  );
}
