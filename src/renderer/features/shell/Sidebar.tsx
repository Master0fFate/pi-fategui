import {
  Bot,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  MessageSquarePlus,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react';
import { IconButton } from '../../components/IconButton';

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
  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`} aria-label="Primary navigation">
      <div className="window-drag-region" />
      <div className="brand-row">
        {!collapsed && <div className="brand-mark" aria-hidden="true">π</div>}
        {!collapsed && (
          <div className="brand-copy">
            <strong>Pi Desktop</strong>
            <span>No project open</span>
          </div>
        )}
        <IconButton label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={onToggle}>
          {collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
        </IconButton>
      </div>

      {!collapsed && (
        <button className="primary-button" type="button">
          <FolderOpen size={16} /> Open project
        </button>
      )}
      <button className={`new-session ${collapsed ? 'icon-only' : ''}`} type="button" disabled>
        <MessageSquarePlus size={17} />
        {!collapsed && 'New session'}
      </button>

      {!collapsed && (
        <label className="session-search">
          <Search size={15} />
          <input aria-label="Search sessions" placeholder="Search sessions" disabled />
        </label>
      )}

      <nav className="nav-list">
        {navigation.map(({ label, icon: Icon, active }) => (
          <button key={label} type="button" className={active ? 'active' : ''} title={collapsed ? label : undefined}>
            <Icon size={18} />
            {!collapsed && <span>{label}</span>}
          </button>
        ))}
      </nav>

      {!collapsed && (
        <div className="empty-sessions">
          <FileText size={19} />
          <p>No sessions yet</p>
          <span>Open a project to start working with Pi.</span>
        </div>
      )}

      <div className="sidebar-footer">
        <button type="button" title={collapsed ? 'Settings' : undefined}>
          <Settings size={18} />
          {!collapsed && <span>Settings</span>}
        </button>
      </div>
    </aside>
  );
}
