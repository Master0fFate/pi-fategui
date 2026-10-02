import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesPanel } from './files/FilesPanel';
import { ChangesPanel } from './diffs/ChangesPanel';
import { SubagentSessionsPanel } from './shell/SubagentSessionsPanel';

// Presentation fixtures only: no actual stores, platform bridge, editor or runtime.
const fixture = vi.hoisted(() => ({
  workspace: {} as Record<string, unknown>,
  runtime: {} as Record<string, unknown>,
  ui: {} as Record<string, unknown>,
}));
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: Object.assign((selector: (state: unknown) => unknown) => selector(fixture.workspace), { getState: () => fixture.workspace }),
  selectFileRows: () => [],
}));
vi.mock('../stores/runtimeStore', () => ({
  useRuntimeStore: Object.assign((selector: (state: unknown) => unknown) => selector(fixture.runtime), { getState: () => fixture.runtime }),
}));
vi.mock('../stores/goalMaxStore', () => ({ useGoalMaxStore: (selector: (state: unknown) => unknown) => selector({ goal: null }) }));
vi.mock('../../client/HttpCommandTransport', () => ({ UnconfirmedCommand: class extends Error {} }));
vi.mock('./chat/RichMessageContent', () => ({ AssistantMarkdown: () => null, MessageImages: () => null }));
vi.mock('../components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('./goalmaxxing/GoalMaxTaskStrip', () => ({ TaskControlsPanel: () => null }));
vi.mock('./goalmaxxing/GoalMaxAgentMarker', () => ({ GoalMaxAgentMarker: () => null, GoalMaxAssignmentScope: () => null }));
vi.mock('./shell/SubagentControls', () => ({ SubagentControls: () => null }));
vi.mock('./shell/AgentTeamControls', () => ({ AgentTeamControls: () => null }));
vi.mock('./shell/AgentWorkspaceControls', () => ({ AgentWorkspaceDetails: () => null }));
vi.mock('../stores/uiStore', () => ({ useUiStore: (selector: (state: unknown) => unknown) => selector(fixture.ui) }));
vi.mock('../platform/api', () => ({ getWebApiOptional: () => undefined, getFateApiOptional: () => undefined, getFateApi: vi.fn() }));
vi.mock('../lib/clipboard', () => ({ writeClipboardText: vi.fn() }));
vi.mock('./shell/flightDeck', () => ({ selectChangeOrigins: () => [], writerConflictState: () => 'none' }));
vi.mock('./files/LazyMonaco', () => ({ LazyFileViewer: () => null, LazyDiffViewer: () => null }));
vi.mock('./files/RasterImagePreview', () => ({ RasterImagePreview: () => null }));
vi.mock('react-virtuoso', () => ({ Virtuoso: () => null }));
vi.mock('../components/AppTooltip', () => ({ AppTooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock('../skins/SkinProvider', () => ({
  useSkinComponents: () => ({
    Symbol: ({ children }: { children: ReactNode }) => children,
    ActionContent: ({ children }: { children: ReactNode }) => children,
  }),
}));

let panelHeight = 900;
const observers = new Set<{ callback: ResizeObserverCallback; observer: ResizeObserver }>();

function resizePanel(height: number) {
  panelHeight = height;
  act(() => { observers.forEach(({ callback, observer }) => callback([], observer)); });
}

function pointer(handle: HTMLElement, type: string, y: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  fireEvent(handle, event);
}

beforeEach(() => {
  panelHeight = 900;
  fixture.workspace = {
    projectPath: '/fixture', directories: {}, expanded: new Set(), loadingDirectories: new Set(), treeTruncated: new Set(),
    query: '', searchResults: [], searchTruncated: false, searching: false, selectedFile: null, preview: null, previewLoading: false,
    search: vi.fn(), selectedChange: null, reviewedPaths: new Set(), diff: null, combinedDiff: null, worktrees: [],
    git: { repository: true, branch: 'main', changes: [], additions: 0, deletions: 0 },
  };
  fixture.runtime = { runtime: {}, subagentOrder: [], agentTeamOrder: [], agentTeamsById: {}, subagentsById: {} };
  fixture.ui = {};
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.matches('.files-panel, .changes-panel, .subagent-sessions') ? panelHeight : 0;
  });
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    entry: { callback: ResizeObserverCallback; observer: ResizeObserver };
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, observer: this }; }
    observe() { observers.add(this.entry); }
    unobserve() { observers.delete(this.entry); }
    disconnect() { observers.delete(this.entry); }
  });
});

afterEach(() => { cleanup(); observers.clear(); vi.unstubAllGlobals(); });

describe.each([
  { name: 'Files', Panel: FilesPanel, label: 'Resize file tree and preview', selector: '.file-tree', minimum: 100, reserve: 180, initial: 240, direction: 1 },
  { name: 'Changes', Panel: ChangesPanel, label: 'Resize changes list and preview', selector: '.changes-list', minimum: 90, reserve: 200, initial: 240, direction: 1 },
  { name: 'Subagent', Panel: SubagentSessionsPanel, label: 'Resize sub-agent chat preview', selector: '.subagent-chat-preview', minimum: 140, reserve: 180, initial: 260, direction: -1 },
])('$name splitter bounds', ({ name, Panel, label, selector, minimum, reserve, initial, direction }) => {
  function setup(height: number) {
    panelHeight = height;
    const view = render(<Panel />);
    const handle = screen.getByRole('separator', { name: label });
    const pane = view.container.querySelector(selector)!;
    return { ...view, handle, pane };
  }

  function expectSize(handle: HTMLElement, pane: Element, value: number, maximum: number) {
    expect(handle).toHaveAttribute('aria-valuemin', String(minimum));
    expect(handle).toHaveAttribute('aria-valuemax', String(maximum));
    expect(handle).toHaveAttribute('aria-valuenow', String(value));
    expect(pane).toHaveStyle({ flexBasis: `${value}px` });
  }

  it.each([1200, 500, 250, 50])('announces and reaches the actual bounds at %ipx', (height) => {
    const { handle, pane } = setup(height);
    const maximum = Math.max(minimum, height - reserve);
    expectSize(handle, pane, Math.min(initial, maximum), maximum);
    for (let step = 0; step < 100; step++) fireEvent.keyDown(handle, { key: direction === 1 ? 'ArrowDown' : 'ArrowUp' });
    expectSize(handle, pane, maximum, maximum);
    for (let step = 0; step < 100; step++) fireEvent.keyDown(handle, { key: direction === 1 ? 'ArrowUp' : 'ArrowDown' });
    expectSize(handle, pane, minimum, maximum);
  });

  it('clamps pointer movement, preserves the default reset, and reclamps when the container shrinks', () => {
    const { handle, pane } = setup(1200);
    const maximum = 1200 - reserve;
    pointer(handle, 'pointerdown', 200);
    pointer(handle, 'pointermove', 200 + 3000 * direction);
    expectSize(handle, pane, maximum, maximum);
    pointer(handle, 'pointerup', 3000);
    fireEvent.doubleClick(handle);
    expectSize(handle, pane, initial, maximum);
    pointer(handle, 'pointerdown', 200);
    pointer(handle, 'pointermove', 200 - 3000 * direction);
    expectSize(handle, pane, minimum, maximum);
    pointer(handle, 'pointerup', -3000);
    fireEvent.doubleClick(handle);
    resizePanel(350);
    expectSize(handle, pane, 350 - reserve, 350 - reserve);
    resizePanel(1200);
    expectSize(handle, pane, 350 - reserve, maximum);
    resizePanel(50);
    fireEvent.doubleClick(handle);
    expectSize(handle, pane, minimum, minimum);
  });

  if (name !== 'Subagent') it('observes a panel that appears after an empty state and disconnects on removal', () => {
    fixture.workspace.projectPath = null;
    const view = render(<Panel />);
    expect(observers.size).toBe(0);
    fixture.workspace.projectPath = '/fixture';
    panelHeight = 500;
    view.rerender(<Panel />);
    const handle = screen.getByRole('separator', { name: label });
    expectSize(handle, view.container.querySelector(selector)!, 240, 500 - reserve);
    expect(observers.size).toBe(1);
    fixture.workspace.projectPath = null;
    view.rerender(<Panel />);
    expect(observers.size).toBe(0);
    fixture.workspace.projectPath = '/fixture';
    panelHeight = 50;
    view.rerender(<Panel />);
    expectSize(screen.getByRole('separator', { name: label }), view.container.querySelector(selector)!, minimum, minimum);
  });

  it('keeps the fallback before layout and retains the last measured size while hidden', () => {
    const { handle, pane } = setup(0);
    expectSize(handle, pane, initial, 900 - reserve);
    resizePanel(350);
    expectSize(handle, pane, 350 - reserve, 350 - reserve);
    resizePanel(0);
    expectSize(handle, pane, 350 - reserve, 350 - reserve);
    resizePanel(1200);
    fireEvent.doubleClick(handle);
    expectSize(handle, pane, initial, 1200 - reserve);
  });

  it.each([NaN, Infinity, -Infinity])('ignores nonfinite container measurements (%s)', (height) => {
    const { handle, pane } = setup(height);
    expectSize(handle, pane, initial, 900 - reserve);
    resizePanel(350);
    expectSize(handle, pane, 350 - reserve, 350 - reserve);
    resizePanel(height);
    expectSize(handle, pane, 350 - reserve, 350 - reserve);
  });

  it('uses new limits if the container shrinks during an active drag', () => {
    const { handle, pane } = setup(1200);
    pointer(handle, 'pointerdown', 200);
    pointer(handle, 'pointermove', 200 + 500 * direction);
    resizePanel(350);
    pointer(handle, 'pointermove', 200 + 700 * direction);
    expectSize(handle, pane, 350 - reserve, 350 - reserve);
    pointer(handle, 'pointermove', 200 - 1200 * direction);
    expectSize(handle, pane, minimum, 350 - reserve);
    pointer(handle, 'pointerup', -1000);
  });

  it('falls back to window resize observation when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const { handle, pane, unmount } = setup(1200);
    const resizeListener = addListener.mock.calls.find(([type]) => type === 'resize')?.[1];
    expect(resizeListener).toBeDefined();
    expectSize(handle, pane, initial, 1200 - reserve);
    panelHeight = 350;
    fireEvent(window, new Event('resize'));
    expectSize(handle, pane, 350 - reserve, 350 - reserve);
    unmount();
    expect(removeListener).toHaveBeenCalledWith('resize', resizeListener);
    fireEvent(window, new Event('resize'));
  });
});
