import { ResizeHandle } from '../components/ResizeHandle';
import { Inspector } from '../features/shell/Inspector';
import { Sidebar } from '../features/shell/Sidebar';
import { Workspace } from '../features/shell/Workspace';
import {
  LEFT_MAX,
  LEFT_MIN,
  RIGHT_MAX,
  RIGHT_MIN,
  useUiStore,
} from '../stores/uiStore';

export function AppShell() {
  const state = useUiStore();
  const leftTrack = state.sidebarCollapsed ? '64px' : `min(${state.leftWidth}px, 27vw)`;
  const rightTrack = state.inspectorCollapsed ? '0px' : `min(${state.rightWidth}px, 31vw)`;

  return (
    <div
      className="app-shell"
      style={{
        gridTemplateColumns: `${leftTrack} ${state.sidebarCollapsed ? 0 : 6}px minmax(340px, 1fr) ${state.inspectorCollapsed ? 0 : 6}px ${rightTrack}`,
      }}
    >
      <Sidebar collapsed={state.sidebarCollapsed} onToggle={state.toggleSidebar} />
      {!state.sidebarCollapsed && (
        <ResizeHandle
          label="Resize sidebar"
          value={state.leftWidth}
          minimum={LEFT_MIN}
          maximum={LEFT_MAX}
          direction={1}
          onChange={state.setLeftWidth}
          onReset={() => state.setLeftWidth(264)}
        />
      )}
      <Workspace inspectorCollapsed={state.inspectorCollapsed} onToggleInspector={state.toggleInspector} />
      {!state.inspectorCollapsed && (
        <ResizeHandle
          label="Resize inspector"
          value={state.rightWidth}
          minimum={RIGHT_MIN}
          maximum={RIGHT_MAX}
          direction={-1}
          onChange={state.setRightWidth}
          onReset={() => state.setRightWidth(332)}
        />
      )}
      {!state.inspectorCollapsed && <Inspector onCollapse={state.toggleInspector} />}
    </div>
  );
}
