import {
  Bot,
  ChevronRight,
  FileCode2,
  Files,
  FolderTree,
  Globe2,
  Library,
  LoaderCircle,
  Plus,
  Search,
  Sparkles,
  TerminalSquare,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { AppTooltip } from '../../components/AppTooltip';
import { useAutomationStore } from '../../stores/automationStore';
import { useBrowserStore } from '../../stores/browserStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { openResource, piSearchItems, useResourceSearch, type ResourceSearchItem, type ResourceSurface } from './resourceSearch';

interface ResourceTypeItem {
  surface: ResourceSurface;
  label: string;
  detail: string;
  status: string;
  tone?: 'success' | 'warning' | 'muted';
  icon: LucideIcon;
  disabledReason?: string;
}

interface SidebarResourcesProps {
  onOpenProject: () => void;
  projectSelectionBusy: boolean;
}

export function SidebarResources({ onOpenProject, projectSelectionBusy }: SidebarResourcesProps) {
  const project = useRuntimeStore((state) => state.runtime.project);
  const commands = useRuntimeStore((state) => state.runtime.commands);
  const skills = useRuntimeStore((state) => state.runtime.skills);
  const browser = useBrowserStore((state) => state.state);
  const automationCount = useAutomationStore((state) => state.items.length);
  const gitChanges = useWorkspaceStore((state) => state.git?.changes.length ?? 0);
  const [query, setQuery] = useState('');
  const search = useResourceSearch(query, true);
  const piItems = useMemo(() => piSearchItems(commands ?? [], skills ?? []), [commands, skills]);

  const resourceTypes: ResourceTypeItem[] = [
    {
      surface: 'files', label: 'Files', detail: 'Browse and preview project files',
      status: project ? gitChanges > 0 ? `${gitChanges} changed` : 'Ready' : 'Open project', tone: project ? 'success' : 'muted', icon: FolderTree,
      ...(project ? {} : { disabledReason: 'Open a project to browse files.' }),
    },
    {
      surface: 'browser', label: 'Browser', detail: 'Built-in Chromium workspace',
      status: project?.trusted ? browser.tabs.length > 0 ? 'Connected' : 'Ready' : 'Trust required', tone: project?.trusted ? 'success' : 'warning', icon: Globe2,
      ...(project?.trusted ? {} : { disabledReason: 'Open and trust a project to use Browser.' }),
    },
    {
      surface: 'pi-library', label: 'Pi Library', detail: 'Skills, prompts, and extensions',
      status: `${piItems.length}`, tone: piItems.length > 0 ? 'success' : 'muted', icon: Library,
    },
    {
      surface: 'terminal', label: 'Manual terminal', detail: 'Project shell under your control',
      status: project?.trusted ? 'Ready' : 'Trust required', tone: project?.trusted ? 'success' : 'warning', icon: TerminalSquare,
      ...(project?.trusted ? {} : { disabledReason: 'Open and trust a project to use Terminal.' }),
    },
    {
      surface: 'automations', label: 'Automations', detail: 'Saved project prompts',
      status: `${automationCount}`, tone: automationCount > 0 ? 'success' : 'muted', icon: Workflow,
    },
  ];

  return (
    <section className="sidebar-resource-panel" aria-label="Resources">
      <div className="sidebar-tab-toolbar">
        <label className="sidebar-resource-search sidebar-search">
          <Search size={15} aria-hidden="true" />
          <input className="icon-label" type="search" aria-label="Search resources" placeholder="Search resources" value={query} onChange={(event) => setQuery(event.target.value)} />
          {search.searching && <LoaderCircle className="tool-spinner" size={13} aria-label="Searching resources" />}
        </label>
        <AppTooltip content="Open project" wrapTrigger triggerClassName="sidebar-toolbar-action sidebar-toolbar-action--primary">
          <button type="button" aria-label="Open project" disabled={projectSelectionBusy} onClick={onOpenProject}><Plus size={15} /></button>
        </AppTooltip>
      </div>

      {query.trim() ? (
        <ResourceSearchResults query={query} search={search} />
      ) : (
        <>
          <div className="sidebar-section-heading"><span>Resource types</span><em>{resourceTypes.length}</em></div>
          <div className="resource-type-list">
            {resourceTypes.map((resource) => {
              const Icon = resource.icon;
              const item: ResourceSearchItem = {
                id: `surface:${resource.surface}`,
                kind: 'surface',
                surface: resource.surface,
                title: resource.label,
                subtitle: resource.detail,
                ...(resource.disabledReason ? { disabledReason: resource.disabledReason } : {}),
              };
              return (
                <button
                  type="button"
                  key={resource.surface}
                  className="resource-type-row"
                  aria-disabled={Boolean(resource.disabledReason)}
                  title={resource.disabledReason}
                  onClick={() => void openResource(item)}
                >
                  <span className="resource-type-icon"><Icon size={15} aria-hidden="true" /></span>
                  <span className="resource-type-copy"><strong>{resource.label}</strong><small>{resource.detail}</small></span>
                  <em data-tone={resource.tone ?? 'muted'}>{resource.status}</em>
                  <ChevronRight size={13} aria-hidden="true" />
                </button>
              );
            })}
          </div>

          {browser.tabs.length > 0 && (
            <ResourcePreviewGroup title="Browser tabs" count={browser.tabs.length}>
              {browser.tabs.slice(0, 5).map((tab) => (
                <ResourceResultButton
                  key={tab.id}
                  item={{ id: `browser-tab:${tab.id}`, kind: 'browser-tab', tabId: tab.id, title: tab.title || 'New tab', subtitle: browserLabel(tab.url) }}
                />
              ))}
            </ResourcePreviewGroup>
          )}


          {!project && (
            <div className="resource-onboarding-note"><Sparkles size={14} /><span><strong>Open a project to connect resources.</strong><small>Pi Library remains searchable when runtime resources are available.</small></span></div>
          )}
        </>
      )}
    </section>
  );
}

function ResourceSearchResults({ query, search }: { query: string; search: ReturnType<typeof useResourceSearch> }) {
  return (
    <div className="resource-search-results" aria-live="polite">
      <div className="sidebar-section-heading"><span>Matches</span><em>{search.items.length}{search.truncated ? '+' : ''}</em></div>
      {search.error && <div className="sidebar-inline-error" role="alert">File search unavailable: {search.error}</div>}
      {search.items.map((item) => <ResourceResultButton key={item.id} item={item} />)}
      {!search.searching && !search.error && search.items.length === 0 && (
        <div className="sidebar-tab-empty compact"><Search size={19} /><strong>No resources found</strong><p>Nothing matches “{query.trim()}”.</p></div>
      )}
    </div>
  );
}

function ResourcePreviewGroup({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="resource-preview-group">
      <div className="sidebar-section-heading"><span>{title}</span><em>{count}</em></div>
      <div className="resource-result-list">{children}</div>
    </section>
  );
}

export function ResourceResultButton({ item }: { item: ResourceSearchItem }) {
  const Icon = iconFor(item);
  return (
    <button
      type="button"
      className="resource-result-row"
      aria-disabled={item.kind === 'surface' && Boolean(item.disabledReason)}
      title={item.kind === 'surface' ? item.disabledReason : undefined}
      onClick={() => void openResource(item)}
    >
      <Icon size={14} aria-hidden="true" />
      <span><strong>{item.title}</strong><small>{item.subtitle}</small></span>
      <em>{kindLabel(item)}</em>
    </button>
  );
}

function iconFor(item: ResourceSearchItem): LucideIcon {
  if (item.kind === 'file') return FileCode2;
  if (item.kind === 'browser-tab') return Globe2;
  if (item.kind === 'pi') return item.source === 'skill' ? Bot : Library;
  if (item.kind === 'automation') return Workflow;
  if (item.kind === 'session') return Bot;
  if (item.surface === 'files') return Files;
  if (item.surface === 'browser') return Globe2;
  if (item.surface === 'pi-library') return Library;
  if (item.surface === 'terminal') return TerminalSquare;
  return Workflow;
}

function kindLabel(item: ResourceSearchItem): string {
  if (item.kind === 'browser-tab') return 'tab';
  if (item.kind === 'pi') return item.source === 'skill' ? 'skill' : item.source === 'extension' ? 'extension' : 'prompt';
  if (item.kind === 'automation') return 'automation';
  if (item.kind === 'session') return 'session';
  if (item.kind === 'file') return 'file';
  return 'resource';
}

function browserLabel(value: string): string {
  if (value === 'about:blank') return 'Blank page';
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? 'Local page');
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}
