import * as Tabs from '@radix-ui/react-tabs';
import {
  Activity,
  Files,
  GitCompareArrows,
  Info,
  ListChecks,
  MessagesSquare,
  Sparkles,
  Target,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import { AppTooltip } from '../../components/AppTooltip';
import { ToolCard } from '../chat/ToolCard';
import { ChangesPanel } from '../diffs/ChangesPanel';
import { FilesPanel } from '../files/FilesPanel';
import { ResourcesPanel } from '../resources/ResourcesPanel';
import { ContextPanel } from './ContextPanel';
import { ActivityPanel } from './ActivityPanel';
import { SubagentSessionsPanel } from './SubagentSessionsPanel';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { inspectorDestinationForTab, useUiStore } from '../../stores/uiStore';
import { GoalMaxInspector } from '../goalmaxxing/GoalMaxInspector';

interface InspectorProps {
  /** Kept optional for compatibility with embedded inspector tests. */
  onCollapse?: () => void;
}

const destinations = [
  {
    value: 'work',
    label: 'Work',
    tabs: [
      { value: 'changes', label: 'Changes', icon: GitCompareArrows },
      { value: 'files', label: 'Files', icon: Files },
    ],
  },
  {
    value: 'run',
    label: 'Run',
    tabs: [
      { value: 'goal', label: 'Goal', icon: Target },
      { value: 'sessions', label: 'Agents', icon: MessagesSquare },
      { value: 'tools', label: 'Tools', icon: ListChecks },
      { value: 'activity', label: 'Activity', icon: Activity },
    ],
  },
  {
    value: 'system',
    label: 'System',
    tabs: [
      { value: 'context', label: 'Context', icon: Info },
      { value: 'resources', label: 'Resources', icon: Sparkles },
    ],
  },
] as const;

function RuntimeContextPanel() {
  const runtime = useRuntimeStore(useShallow((state) => ({
    contextUsage: state.runtime.contextUsage,
    tokenTelemetry: state.runtime.tokenTelemetry,
    streaming: state.runtime.streaming,
    model: state.runtime.model,
    thinkingLevel: state.runtime.thinkingLevel,
    project: state.runtime.project,
    objective: state.runtime.objective,
  })));
  return <ContextPanel runtime={runtime} />;
}

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

export function Inspector(_props: InspectorProps = {}) {
  const activeChildren = useRuntimeStore((state) => state.subagentOrder.reduce((count, id) => {
    const status = state.subagentsById[id]?.status;
    return count + (status === 'queued' || status === 'running' ? 1 : 0);
  }, 0)
    + (state.runtime.subagentWorkflows ?? []).filter((workflow) => workflow.status === 'running').length
    + (state.runtime.agentTeams ?? []).reduce((count, team) => count + team.activeTurns, 0));
  const activeTab = useUiStore((state) => state.inspectorTab);
  const setActiveTab = useUiStore((state) => state.setInspectorTab);
  const openDestination = useUiStore((state) => state.openInspectorDestination);
  const activeDestinationValue = inspectorDestinationForTab(activeTab);
  const activeDestination = destinations.find(({ value }) => value === activeDestinationValue) ?? destinations[0];

  return (
    <aside className="inspector" aria-label="Project inspector">
      <nav className="inspector-primary-nav" aria-label="Inspector destinations">
        {destinations.map(({ value, label }) => {
          const isActive = value === activeDestinationValue;
          const accessibleLabel = value === 'run' && activeChildren > 0 ? `${label}, ${activeChildren} active` : label;
          return (
            <button
              type="button"
              key={value}
              className="inspector-primary-trigger"
              aria-current={isActive ? 'page' : undefined}
              aria-label={accessibleLabel}
              onClick={() => {
                if (!isActive) openDestination(value);
              }}
            >
              <span className="inspector-primary-label">{label}</span>
              {value === 'run' && activeChildren > 0 ? (
                <span className="inspector-run-count" aria-hidden="true">{activeChildren}</span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <Tabs.Root value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)} className="inspector-tabs">
        <Tabs.List aria-label={`${activeDestination.label} views`} className="inspector-secondary-tabs">
          {activeDestination.tabs.map(({ value, label, icon: Icon }) => (
            <AppTooltip content={label} side="bottom" sideOffset={6} wrapTrigger triggerClassName="inspector-secondary-tooltip" key={value}>
              <Tabs.Trigger
                value={value}
                className="inspector-secondary-trigger"
                aria-label={value === 'sessions' ? `Subagent sessions${activeChildren > 0 ? `, ${activeChildren} active` : ''}` : label}
              >
                <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
                <span className="inspector-secondary-label">{label}</span>
              </Tabs.Trigger>
            </AppTooltip>
          ))}
        </Tabs.List>
        <Tabs.Content value="changes" className="tab-content"><ChangesPanel /></Tabs.Content>
        <Tabs.Content value="files" className="tab-content"><FilesPanel /></Tabs.Content>
        <Tabs.Content value="sessions" className="tab-content"><SubagentSessionsPanel /></Tabs.Content>
        <Tabs.Content value="goal" className="tab-content"><GoalMaxInspector /></Tabs.Content>
        <Tabs.Content value="tools" className="tab-content"><ToolsPanel /></Tabs.Content>
        <Tabs.Content value="activity" className="tab-content"><ActivityPanel /></Tabs.Content>
        <Tabs.Content value="resources" className="tab-content"><ResourcesPanel /></Tabs.Content>
        <Tabs.Content value="context" className="tab-content"><RuntimeContextPanel /></Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
