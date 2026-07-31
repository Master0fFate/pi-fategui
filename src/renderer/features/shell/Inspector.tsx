import * as Tabs from '@radix-ui/react-tabs';
import {
  ChevronsRight,
  Files,
  GitCompareArrows,
  Info,
  ListChecks,
  MessagesSquare,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import { IconButton } from '../../components/IconButton';
import { ToolCard } from '../chat/ToolCard';
import { ChangesPanel } from '../diffs/ChangesPanel';
import { FilesPanel } from '../files/FilesPanel';
import { ResourcesPanel } from '../resources/ResourcesPanel';
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
  if (order.length === 0) {
    return <div className="inspector-empty"><ListChecks size={24} /><strong>No tool activity</strong><p>Pi tool executions will be shown chronologically.</p></div>;
  }
  return (
    <Virtuoso
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
        <Tabs.Content value="context" className="tab-content">
          <div className="context-list">
            <div><span>Project</span><strong>{runtime.project?.name ?? 'Not selected'}</strong></div>
            <div><span>Agent</span><strong>{runtime.status}</strong></div>
            <div><span>Model</span><strong>{runtime.model?.name ?? '—'}</strong></div>
            <div><span>Thinking</span><strong>{runtime.thinkingLevel}</strong></div>
            <div><span>Context</span><strong>{runtime.contextUsage?.percent == null ? '—' : `${runtime.contextUsage.estimated ? '~' : ''}${runtime.contextUsage.percent.toFixed(1)}%`}</strong></div>
            <div><span>Objective</span><strong>{runtime.objective || 'No active objective'}</strong></div>
            <div className="trust-row"><ShieldCheck size={16} /><span>{runtime.project?.trusted ? `Trusted · ${runtime.project.path}` : 'Project trust starts after selection'}</span></div>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
