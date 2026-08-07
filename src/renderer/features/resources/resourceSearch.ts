import { useEffect, useMemo, useState } from 'react';
import type { FileEntry, RuntimeState } from '../../../shared/contracts/ipc';
import { useAutomationStore } from '../../stores/automationStore';
import { automationPromptPreview, automationSearchPattern } from '../automations/automationText';
import { useBrowserStore } from '../../stores/browserStore';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

export type ResourceSurface = 'files' | 'browser' | 'pi-library' | 'terminal' | 'automations';

export type ResourceSearchItem =
  | { id: string; kind: 'surface'; surface: ResourceSurface; title: string; subtitle: string; disabledReason?: string }
  | { id: string; kind: 'file'; path: string; title: string; subtitle: string }
  | { id: string; kind: 'browser-tab'; tabId: string; title: string; subtitle: string }
  | { id: string; kind: 'pi'; commandName: string; source: 'extension' | 'prompt' | 'skill' | 'builtin'; title: string; subtitle: string }
  | { id: string; kind: 'automation'; automationId: string; title: string; subtitle: string }
  | { id: string; kind: 'session'; sessionId: string; title: string; subtitle: string };

interface ResourceSearchState {
  items: ResourceSearchItem[];
  searching: boolean;
  truncated: boolean;
  error: string | null;
}

const EMPTY_COMMANDS: NonNullable<RuntimeState['commands']> = [];
const EMPTY_SKILLS: NonNullable<RuntimeState['skills']> = [];
const EMPTY_SESSIONS: NonNullable<RuntimeState['sessions']> = [];

const surfaces: Array<Extract<ResourceSearchItem, { kind: 'surface' }>> = [
  { id: 'surface:files', kind: 'surface', surface: 'files', title: 'Files', subtitle: 'Browse and preview project files' },
  { id: 'surface:browser', kind: 'surface', surface: 'browser', title: 'Browser', subtitle: 'Open the built-in Chromium workspace' },
  { id: 'surface:pi-library', kind: 'surface', surface: 'pi-library', title: 'Pi Library', subtitle: 'Skills, prompts, and extension commands' },
  { id: 'surface:terminal', kind: 'surface', surface: 'terminal', title: 'Manual terminal', subtitle: 'Open the project terminal' },
  { id: 'surface:automations', kind: 'surface', surface: 'automations', title: 'Automations', subtitle: 'Saved project prompts' },
];

export function useResourceSearch(query: string, enabled = true): ResourceSearchState {
  const project = useRuntimeStore((state) => state.runtime.project);
  const runtimeCommands = useRuntimeStore((state) => state.runtime.commands);
  const runtimeSkills = useRuntimeStore((state) => state.runtime.skills);
  const runtimeSessions = useRuntimeStore((state) => state.runtime.sessions);
  const commands = runtimeCommands ?? EMPTY_COMMANDS;
  const skills = runtimeSkills ?? EMPTY_SKILLS;
  const sessions = runtimeSessions ?? EMPTY_SESSIONS;
  const browserTabs = useBrowserStore((state) => state.state.tabs);
  const automations = useAutomationStore((state) => state.items);
  const [fileState, setFileState] = useState<{ entries: FileEntry[]; searching: boolean; truncated: boolean; error: string | null }>({
    entries: [], searching: false, truncated: false, error: null,
  });
  const needle = query.trim().toLocaleLowerCase();

  useEffect(() => {
    if (!enabled || !needle || !project || !('piDesktop' in window) || typeof window.piDesktop.searchFiles !== 'function') {
      setFileState({ entries: [], searching: false, truncated: false, error: null });
      return undefined;
    }
    let active = true;
    setFileState({ entries: [], searching: true, truncated: false, error: null });
    const timer = window.setTimeout(() => {
      void window.piDesktop.searchFiles(query.trim(), 40).then((result) => {
        const currentProject = useRuntimeStore.getState().runtime.project;
        if (active && currentProject?.path === project.path) setFileState({
          entries: result.entries,
          searching: false,
          truncated: result.truncated,
          error: null,
        });
      }).catch((error: unknown) => {
        if (active) setFileState({ entries: [], searching: false, truncated: false, error: messageOf(error) });
      });
    }, 140);
    return () => { active = false; window.clearTimeout(timer); };
  }, [enabled, needle, project, query]);

  const items = useMemo(() => {
    if (!enabled || !needle) return [];
    const pattern = automationSearchPattern(needle);
    const staticItems: ResourceSearchItem[] = [
      ...surfaces.map((surface) => surface.surface === 'files' && !project
        ? { ...surface, disabledReason: 'Open a project to browse files.' }
        : surface.surface === 'browser' && !project?.trusted
          ? { ...surface, disabledReason: 'Open and trust a project to use Browser.' }
          : surface.surface === 'terminal' && !project?.trusted
            ? { ...surface, disabledReason: 'Open and trust a project to use Terminal.' }
            : surface),
      ...sessions.map((session) => ({
        id: `session:${session.id}`,
        kind: 'session' as const,
        sessionId: session.id,
        title: session.title,
        subtitle: `${session.messageCount} messages${session.active ? ' · Active session' : ''}`,
      })),
      ...browserTabs.map((tab) => ({
        id: `browser-tab:${tab.id}`,
        kind: 'browser-tab' as const,
        tabId: tab.id,
        title: tab.title || (tab.url === 'about:blank' ? 'New tab' : safeUrlLabel(tab.url)),
        subtitle: safeUrlLabel(tab.url),
      })),
      ...piSearchItems(commands, skills),
      ...automations.map((automation) => ({
        id: `automation:${automation.id}`,
        kind: 'automation' as const,
        automationId: automation.id,
        title: automation.name,
        subtitle: `${automation.permissionLevel === 'edit' ? 'Edit project' : 'Read only'} · ${automation.prompt}`,
      })),
    ];
    const ranked = staticItems
      .map((item) => ({ item, score: matchScore(needle, item.title, item.subtitle, pattern) }))
      .filter((entry): entry is { item: ResourceSearchItem; score: number } => entry.score !== null)
      .sort((left, right) => left.score - right.score || left.item.title.localeCompare(right.item.title))
      .slice(0, 40)
      .map(({ item }) => item.kind === 'automation'
        ? { ...item, subtitle: automationPromptPreview(item.subtitle) }
        : item);
    const files: ResourceSearchItem[] = fileState.entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => ({
        id: `file:${entry.path}`,
        kind: 'file',
        path: entry.path,
        title: entry.name,
        subtitle: entry.path,
      }));
    return [...ranked, ...files].slice(0, 60);
  }, [automations, browserTabs, commands, enabled, fileState.entries, needle, project, sessions, skills]);

  return { items, searching: fileState.searching, truncated: fileState.truncated, error: fileState.error };
}

export async function openResource(item: ResourceSearchItem): Promise<void> {
  const ui = useUiStore.getState();
  const runtime = useRuntimeStore.getState().runtime;
  try {
    if (item.kind === 'surface') {
      if (item.disabledReason) {
        ui.showToast({ kind: 'info', title: item.title, message: item.disabledReason });
        return;
      }
      if (item.surface === 'files') {
        if (!runtime.project) throw new Error('Open a project before browsing files.');
        ui.openInspectorTab('files');
        await useWorkspaceStore.getState().initialize(runtime.project.path, 'files');
      } else if (item.surface === 'browser') {
        ui.setBrowserOpen(true);
      } else if (item.surface === 'pi-library') {
        ui.openInspectorTab('resources');
      } else if (item.surface === 'terminal') {
        ui.setTerminalOpen(true);
      } else if (item.surface === 'automations') {
        ui.setSidebarCollapsed(false);
        ui.setSidebarTab('automations');
      }
      return;
    }
    if (item.kind === 'file') {
      if (!runtime.project) throw new Error('Open a project before browsing files.');
      ui.openInspectorTab('files');
      await useWorkspaceStore.getState().initialize(runtime.project.path, 'files');
      await useWorkspaceStore.getState().selectFile(item.path);
      return;
    }
    if (item.kind === 'browser-tab') {
      if (!('piDesktop' in window)) throw new Error('The Browser bridge is unavailable.');
      const state = await window.piDesktop.activateBrowserTab(item.tabId);
      useBrowserStore.getState().hydrate(state, runtime.project?.path ?? null);
      ui.setBrowserOpen(true);
      return;
    }
    if (item.kind === 'pi') {
      ui.requestComposerInsertion(`/${item.commandName} `);
      ui.showToast({ kind: 'success', title: 'Added to composer', message: `${item.title} was inserted without sending it.` });
      return;
    }
    if (item.kind === 'automation') {
      if (!runtime.project) throw new Error('Open a project before opening an automation.');
      ui.openAutomation(runtime.project.path, item.automationId);
      return;
    }
    await switchSession(item.sessionId);
    ui.setSidebarCollapsed(false);
    ui.setSidebarTab('sessions');
  } catch (error) {
    ui.showToast({ kind: 'error', title: `Could not open ${item.title}`, message: messageOf(error) });
  }
}

export function piSearchItems(
  commands: NonNullable<RuntimeState['commands']>,
  skills: NonNullable<RuntimeState['skills']>,
): ResourceSearchItem[] {
  const result = new Map<string, ResourceSearchItem>();
  for (const command of commands) {
    const source = command.source ?? 'prompt';
    const title = source === 'skill' ? command.name.replace(/^skill:/u, '') : `/${command.name}`;
    result.set(command.name, {
      id: `pi:${source}:${command.name}`,
      kind: 'pi',
      commandName: command.name,
      source,
      title,
      subtitle: command.description || piFallback(source),
    });
  }
  for (const skill of skills) {
    const commandName = `skill:${skill.name}`;
    if (result.has(commandName)) continue;
    result.set(commandName, {
      id: `pi:skill:${skill.name}`,
      kind: 'pi',
      commandName,
      source: 'skill',
      title: skill.name,
      subtitle: skill.description || 'Project skill',
    });
  }
  return [...result.values()];
}

async function switchSession(sessionId: string): Promise<void> {
  if (!('piDesktop' in window)) throw new Error('The session bridge is unavailable.');
  const store = useRuntimeStore.getState();
  const origin = store.runtime;
  const generation = store.beginSessionSwitch(sessionId);
  if (generation === null) return;
  try {
    const state = await window.piDesktop.switchSession(sessionId);
    const latest = useRuntimeStore.getState();
    if (!latest.completeSessionSwitch(generation, state)) latest.cancelSessionSwitch(generation, state);
  } catch (error) {
    useRuntimeStore.getState().cancelSessionSwitch(generation, origin);
    throw error;
  }
}

function matchScore(needle: string, title: string, subtitle: string, pattern: RegExp): number | null {
  const normalizedTitle = title.toLocaleLowerCase();
  if (normalizedTitle === needle) return 0;
  if (normalizedTitle.startsWith(needle)) return 1;
  if (normalizedTitle.split(/[^a-z0-9]+/u).some((part) => part.startsWith(needle))) return 2;
  if (normalizedTitle.includes(needle)) return 3;
  if (pattern.test(subtitle)) return 4;
  return null;
}

function safeUrlLabel(value: string): string {
  if (value === 'about:blank') return 'Blank page';
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? 'Local page');
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value.slice(0, 160);
  }
}

function piFallback(source: 'extension' | 'prompt' | 'skill' | 'builtin'): string {
  if (source === 'extension') return 'Pi extension command';
  if (source === 'skill') return 'Project skill';
  if (source === 'builtin') return 'Built-in Pi command';
  return 'Reusable Pi prompt';
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return 'The resource could not be opened.';
  try {
    const parsed = JSON.parse(error.message) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : error.message;
  } catch {
    return error.message;
  }
}
