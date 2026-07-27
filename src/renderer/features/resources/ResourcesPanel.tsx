import { Bot, ChevronRight, FileText, Plug, Sparkles } from 'lucide-react';
import { useRuntimeStore } from '../../stores/runtimeStore';

type ResourceKind = 'extension' | 'prompt' | 'skill';

interface ResourceItem {
  name: string;
  description: string;
}

function ResourceGroup({ id, title, kind, items }: { id: string; title: string; kind: ResourceKind; items: ResourceItem[] }) {
  if (items.length === 0) return null;
  const Icon = kind === 'extension' ? Plug : kind === 'skill' ? Bot : FileText;
  const fallback = kind === 'extension' ? 'Pi extension command' : kind === 'skill' ? 'Project skill' : 'Reusable Pi prompt';
  return (
    <details className="resource-group" open aria-label={title}>
      <summary id={`${id}-title`}>
        <ChevronRight className="resource-group-chevron" size={13} aria-hidden="true" />
        <span>{title}</span>
        <em>{items.length}</em>
      </summary>
      <div className="resource-list" aria-labelledby={`${id}-title`}>
        {items.map((item) => (
          <article key={item.name}>
            <Icon size={14} aria-hidden="true" />
            <div><strong>{kind === 'skill' ? item.name : `/${item.name}`}</strong><p>{item.description || fallback}</p></div>
          </article>
        ))}
      </div>
    </details>
  );
}

export function ResourcesPanel() {
  const commands = useRuntimeStore((state) => state.runtime.commands ?? []);
  const discoveredSkills = useRuntimeStore((state) => state.runtime.skills ?? []);
  const extensionCommands = commands.filter((command) => command.source === 'extension');
  const promptTemplates = commands.filter((command) => command.source === 'prompt' || command.source === undefined);
  const skills = new Map(discoveredSkills.map((skill) => [skill.name, skill]));
  for (const command of commands) {
    if (command.source !== 'skill') continue;
    const name = command.name.replace(/^skill:/, '');
    if (!skills.has(name)) skills.set(name, { name, description: command.description });
  }
  const skillItems = [...skills.values()];

  if (extensionCommands.length === 0 && promptTemplates.length === 0 && skillItems.length === 0) {
    return (
      <div className="inspector-empty">
        <Sparkles size={24} />
        <strong>No Pi resources loaded</strong>
        <p>Extension commands, prompt templates, and skills will appear here when Pi discovers them.</p>
      </div>
    );
  }

  return (
    <div className="resources-panel">
      <ResourceGroup id="extensions" title="Extension commands" kind="extension" items={extensionCommands} />
      <ResourceGroup id="prompt-templates" title="Prompt templates" kind="prompt" items={promptTemplates} />
      <ResourceGroup id="skills" title="Skills" kind="skill" items={skillItems} />
    </div>
  );
}
