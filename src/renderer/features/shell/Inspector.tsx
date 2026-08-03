import * as Tabs from '@radix-ui/react-tabs';
import {
  ChevronsRight,
  Files,
  GitCompareArrows,
  Info,
  ListChecks,
  MessagesSquare,
  Sparkles,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { IconButton } from '../../components/IconButton';
import { ToolCard } from '../chat/ToolCard';
import { ChangesPanel } from '../diffs/ChangesPanel';
import { FilesPanel } from '../files/FilesPanel';
import { ResourcesPanel } from '../resources/ResourcesPanel';
import { ContextPanel } from './ContextPanel';
import { SubagentSessionsPanel } from './SubagentSessionsPanel';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

interface InspectorProps {
  onCollapse: () => void;
}

const tabs = [
  { value: 'changes', label: 'Changes', icon: GitCompareArrows },
  { value: 'files', label: 'Files', icon: Files },
  { value: 'sessions', label: 'Agents', icon: MessagesSquare },
  { value: 'tools', label: 'Tools', icon: ListChecks },
  { value: 'resources', label: 'Resources', icon: Sparkles },
  { value: 'context', label: 'Context', icon: Info },
];

function ToolsPanel() {
  const order = useRuntimeStore((state) => state.toolOrder);
  const projectPath = useRuntimeStore((state) => state.runtime.project?.path);
  const sessionId = useRuntimeStore((state) => state.runtime.sessionId);
  const jump = useUiStore((state) => state.flightDeckJump);
  const clearFlightDeckJump = useUiStore((state) => state.clearFlightDeckJump);
  const showToast = useUiStore((state) => state.showToast);
  const listRef = useRef<VirtuosoHandle>(null);
  useEffect(() => {
    if (!jump || jump.projectPath !== projectPath || jump.sessionId !== sessionId || jump.target.kind !== 'tool') return;
    const index = order.indexOf(jump.target.toolCallId);
    if (index < 0 || !useRuntimeStore.getState().toolsById[jump.target.toolCallId]) {
      showToast({ kind: 'info', title: 'Activity not retained', message: 'That tool execution is no longer available in the bounded timeline.' });
      clearFlightDeckJump(jump.nonce);
      return;
    }
    listRef.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' });
  }, [clearFlightDeckJump, jump, order, projectPath, sessionId, showToast]);
  if (order.length === 0) {
    return <div className="inspector-empty"><ListChecks size={24} /><strong>No tool activity</strong><p>Pi tool executions will be shown chronologically.</p></div>;
  }
  return (
    <Virtuoso
      ref={listRef}
      className="tool-history"
      data={order}
      computeItemKey={(_index, id) => id}
      itemContent={(_index, id) => <div className="tool-history-row"><ToolCard toolCallId={id} compact /></div>}
      followOutput="auto"
    />
  );
}

export function Inspector({ onCollapse }: InspectorProps) {
  const runtime = useRuntimeStore((state) => state.runtime);
  const activeChildren = useRuntimeStore((state) => state.subagentOrder.reduce((count, id) => {
    const status = state.subagentsById[id]?.status;
    return count + (status === 'queued' || status === 'running' ? 1 : 0);
  }, 0)
    + (state.runtime.subagentWorkflows ?? []).filter((workflow) => workflow.status === 'running').length
    + (state.runtime.agentTeams ?? []).reduce((count, team) => count + team.activeTurns, 0));
  const activeTab = useUiStore((state) => state.inspectorTab);
  const setActiveTab = useUiStore((state) => state.setInspectorTab);
  return (
    <aside className="inspector" aria-label="Project inspector">
      <div className="inspector-heading">
        <strong>Inspector</strong>
        <IconButton label="Collapse inspector" onClick={onCollapse}>
          <ChevronsRight size={17} />
        </IconButton>
      </div>
      <Tabs.Root value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)} className="inspector-tabs">
        <Tabs.List aria-label="Inspector views" className="tab-list">
          {tabs.map(({ value, label, icon: Icon }) => (
            <Tabs.Trigger
              value={value}
              key={value}
              className="tab-trigger"
              aria-label={value === 'sessions' ? `Subagent sessions${activeChildren ? `, ${activeChildren} active` : ''}` : label}
            >
              <Icon size={15} /><span className="icon-label" aria-hidden="true">{label}</span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="changes" className="tab-content"><ChangesPanel /></Tabs.Content>
        <Tabs.Content value="files" className="tab-content"><FilesPanel /></Tabs.Content>
        <Tabs.Content value="sessions" className="tab-content"><SubagentSessionsPanel /></Tabs.Content>
        <Tabs.Content value="tools" className="tab-content"><ToolsPanel /></Tabs.Content>
        <Tabs.Content value="resources" className="tab-content"><ResourcesPanel /></Tabs.Content>
        <Tabs.Content value="context" className="tab-content"><ContextPanel runtime={runtime} /></Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
