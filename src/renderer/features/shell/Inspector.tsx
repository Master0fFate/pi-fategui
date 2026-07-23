import * as Tabs from '@radix-ui/react-tabs';
import {
  ChevronsRight,
  FileCode2,
  Files,
  GitCompareArrows,
  Info,
  ListChecks,
  ShieldCheck,
} from 'lucide-react';
import { IconButton } from '../../components/IconButton';
import { useRuntimeStore } from '../../stores/runtimeStore';

interface InspectorProps {
  onCollapse: () => void;
}

const tabs = [
  { value: 'changes', label: 'Changes', icon: GitCompareArrows },
  { value: 'files', label: 'Files', icon: Files },
  { value: 'tools', label: 'Tools', icon: ListChecks },
  { value: 'context', label: 'Context', icon: Info },
];

const emptyStates = {
  changes: { icon: GitCompareArrows, title: 'No changes', copy: 'Repository changes will appear here.' },
  files: { icon: FileCode2, title: 'No project files', copy: 'Open a project to browse its file tree.' },
  tools: { icon: ListChecks, title: 'No tool activity', copy: 'Pi tool executions will be shown chronologically.' },
};

export function Inspector({ onCollapse }: InspectorProps) {
  const runtime = useRuntimeStore((state) => state.runtime);
  return (
    <aside className="inspector" aria-label="Project inspector">
      <div className="inspector-heading">
        <strong>Inspector</strong>
        <IconButton label="Collapse inspector" onClick={onCollapse}>
          <ChevronsRight size={17} />
        </IconButton>
      </div>
      <Tabs.Root defaultValue="changes" className="inspector-tabs">
        <Tabs.List aria-label="Inspector views" className="tab-list">
          {tabs.map(({ value, label, icon: Icon }) => (
            <Tabs.Trigger value={value} key={value} className="tab-trigger">
              <Icon size={15} /><span>{label}</span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {Object.entries(emptyStates).map(([value, state]) => {
          const Icon = state.icon;
          return (
            <Tabs.Content value={value} className="tab-content" key={value}>
              <div className="inspector-empty">
                <Icon size={24} />
                <strong>{state.title}</strong>
                <p>{state.copy}</p>
              </div>
            </Tabs.Content>
          );
        })}
        <Tabs.Content value="context" className="tab-content">
          <div className="context-list">
            <div><span>Project</span><strong>{runtime.project?.name ?? 'Not selected'}</strong></div>
            <div><span>Agent</span><strong>{runtime.status}</strong></div>
            <div><span>Model</span><strong>{runtime.model?.name ?? '—'}</strong></div>
            <div><span>Thinking</span><strong>{runtime.thinkingLevel}</strong></div>
            <div className="trust-row"><ShieldCheck size={16} /><span>{runtime.project?.trusted ? `Trusted · ${runtime.project.path}` : 'Project trust starts after selection'}</span></div>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
