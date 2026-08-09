import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Profiler } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalMaxState } from '../../../shared/contracts/goalmaxxing';
import type { BrowserAnnotation, PiDesktopApi, RuntimeState, SubagentRun } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useBrowserStore } from '../../stores/browserStore';
import { attachBrowserAnnotationToSession, clampComposerInputHeight, clearComposerSessionDrafts, Composer, uniqueAttachmentName } from './Composer';
import { ContextWheel } from './ContextWheel';
import { AssistantMarkdown, coalesceSubagentWaitPolls, ConversationTimeline, followsMessage, forkEntryForMessage, MessageRow } from './ConversationTimeline';
import { ConversationImageViewerProvider, isSafeMermaidSource } from './RichMessageContent';
import { ToolCard } from './ToolCard';

vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    render: async (id: string) => ({ svg: `<svg data-diagram-id="${id}" viewBox="0 0 100 50"><script>bad()</script><text onclick="bad()">Flow</text></svg>` }),
  },
}));

const ready = (overrides: Partial<RuntimeState> = {}): RuntimeState => ({
  status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
  streaming: false,
  model: { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000, supportsImages: false },
  models: [], thinkingLevel: 'medium', permissionLevel: 'edit', messages: [], commands: [{ name: 'review', description: 'Review current changes' }], error: null,
  ...overrides,
});

const childRun: SubagentRun = {
  id: 'child-auth', parentSessionId: 's1', parentToolCallId: 'delegate-auth', task: 'Review the authentication flow',
  role: 'reviewer', handle: 'auth-reviewer-1', displayName: 'Auth Reviewer', agentName: 'direct', agentSource: 'direct',
  permissionLevel: 'read-only', enabledTools: ['read'], skills: [], skillMode: 'none', preloadedSkills: [], status: 'running',
  model: { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000 }, routingModels: [], thinkingLevel: 'medium',
  executionMode: 'managed', controlCount: 0, attempt: 1, maxAttempts: 1, mailbox: { state: 'closed', ttlMs: 300_000, followUpCount: 0 },
  notification: 'never', dependsOn: [], createdAt: 1, updatedAt: 2, messages: [], tools: [], omittedActivity: 0, transcriptTruncated: false,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
};

const activeGoalFixture = (status: GoalMaxState['status'] = 'active'): GoalMaxState => ({
  schemaVersion: 2, id: 'goal-1', sessionId: 's1', projectPath: '/project', revision: 1, objective: 'Implement GoalMax', originalBriefRef: null, originalBriefHash: null,
  status, phase: 'implementation', executionState: 'running-root', verificationLevel: 'normal', agentStrategy: 'auto',
  criteria: [{ id: 'criterion-1', title: 'Implement', description: '', required: true, status: 'active', evidenceIds: [], ownerNodeIds: [], updatedAt: 1 }],
  budget: { tokenLimit: null, timeLimitMs: null, source: null }, permission: { permissionLevel: 'edit', projectTrusted: true, revision: 1, resolvedAt: 1 },
  progress: { meaningfulTurnCount: 0, noProgressTurnCount: 0, repeatedFailureCount: 0, planningOnlyTurnCount: 0, changedFileCount: 0, baselineWorkspaceFingerprint: 'a', latestWorkspaceFingerprint: 'a', latestEvidenceAt: null, latestMeaningfulProgressAt: null, lastFailureFingerprint: null },
  evidence: [], continuation: { pending: false, attempt: 0, lastScheduledAt: null, lastSettledAt: null, reason: null }, steering: [], childAssignments: [], tokensUsed: 0, tokenBaseline: 0, elapsedMs: 0, timeline: [],
  createdAt: 1, updatedAt: 1, startedAt: 1, completedAt: null, blockedReason: null, failure: null,
});

const reset = () => {
  useRuntimeStore.getState().setRuntime({ ...ready(), sessionId: null });
  useRuntimeStore.getState().setRuntime(ready());
  useUiStore.setState({ sendMessageWithModifier: false, composerDraftRequest: null, toast: null, goalEditorOpen: false, selectedAgent: null });
  useGoalMaxStore.setState({ projectPath: '/project', sessionId: 's1', goal: null, loading: false, selectionGeneration: 1 });
  useBrowserStore.getState().reset();
};

describe('conversation components', () => {
  beforeEach(reset);
  afterEach(() => {
    clearComposerSessionDrafts();
    Reflect.deleteProperty(window, 'piDesktop');
    vi.restoreAllMocks();
  });

  it('keeps 5,000 timeline entries behind a virtualized viewport', () => {
    useRuntimeStore.getState().applyEvents(Array.from({ length: 5_000 }, (_value, index) => ({
      type: 'message.started' as const, messageId: `m${index}`, role: 'assistant' as const, timestamp: index,
    })));
    const { container } = render(<div style={{ height: 600 }}><ConversationTimeline /></div>);
    expect(screen.getByLabelText('Conversation timeline')).toHaveAttribute('data-entry-count', '5000');
    expect(container.querySelectorAll('.timeline-row').length).toBeLessThan(5_000);
  });

  it('reserves footer clearance only on entries that follow a message', () => {
    expect(followsMessage({ kind: 'message' })).toBe(true);
    expect(followsMessage({ kind: 'tool' })).toBe(false);
    expect(followsMessage(undefined)).toBe(false);
  });

  it('does not rerender a stable message for another message’s live delta', () => {
    useRuntimeStore.setState((state) => ({ runtime: { ...state.runtime, streaming: true } }));
    useRuntimeStore.getState().applyEvents([
      { type: 'message.completed', messageId: 'stable-user', role: 'user', text: 'Stable prompt', timestamp: 1 },
      { type: 'message.started', messageId: 'live-assistant', role: 'assistant', timestamp: 2 },
      { type: 'assistant.text', messageId: 'live-assistant', delta: 'first', timestamp: 3 },
    ]);
    const onRender = vi.fn();
    render(<Profiler id="stable-message" onRender={onRender}><MessageRow messageId="stable-user" /></Profiler>);
    const initialRenderCount = onRender.mock.calls.length;

    act(() => {
      useRuntimeStore.getState().applyEvents([
        { type: 'assistant.text', messageId: 'live-assistant', delta: ' second', timestamp: 4 },
      ]);
    });

    expect(onRender).toHaveBeenCalledTimes(initialRenderCount);
  });

  it('defers full Markdown parsing until the active stream completes', () => {
    useRuntimeStore.setState((state) => ({ runtime: { ...state.runtime, streaming: true } }));
    useRuntimeStore.getState().applyEvents([
      { type: 'message.started', messageId: 'streaming-markdown', role: 'assistant', timestamp: 1 },
      { type: 'assistant.text', messageId: 'streaming-markdown', delta: '**draft**', timestamp: 2 },
    ]);
    const { rerender } = render(<MessageRow messageId="streaming-markdown" />);
    expect(screen.getByText('**draft**')).toBeInTheDocument();
    expect(screen.queryByText('draft')).not.toBeInTheDocument();

    useRuntimeStore.getState().applyEvents([{ type: 'run.completed', runId: 'run', aborted: false, timestamp: 3 }]);
    rerender(<MessageRow messageId="streaming-markdown" />);
    expect(screen.getByText('draft').tagName).toBe('STRONG');
  });

  it('renders assistant Markdown as semantic formatted content', () => {
    const { container } = render(<AssistantMarkdown text={'## Result\n\n**Ready** with `code`:\n\n- one\n- two'} />);
    expect(screen.getByRole('heading', { name: 'Result' })).toBeInTheDocument();
    expect(screen.getByText('Ready').tagName).toBe('STRONG');
    expect(container.querySelector('.markdown-content code')).toHaveTextContent('code');
    expect(container.querySelectorAll('.markdown-content li')).toHaveLength(2);
  });

  it('opens HTTP(S) and localhost links in the built-in browser, with a native link menu on right click', async () => {
    const browserState = {
      activeTabId: 'browser-main', visible: false, viewBlocked: false, sessionFullAccess: false, paused: true, controlLevel: 'off' as const, mode: 'agent' as const,
      tabs: [{ id: 'browser-main', profileId: 'project', url: 'http://localhost:4173/preview', title: 'Preview', loading: false, canGoBack: false, canGoForward: false, documentEpoch: 1, semanticAvailable: true }], grants: [],
    };
    const navigateBrowser = vi.fn(async () => browserState);
    const showBrowserLinkContextMenu = vi.fn(async () => undefined);
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { navigateBrowser, showBrowserLinkContextMenu } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<AssistantMarkdown text={'[Open local preview](localhost:4173/preview)'} />);
    const link = screen.getByRole('link', { name: 'Open local preview' });

    await user.click(link);

    expect(navigateBrowser).toHaveBeenCalledWith('http://localhost:4173/preview');
    expect(useUiStore.getState().browserOpen).toBe(true);
    fireEvent.contextMenu(link);
    expect(showBrowserLinkContextMenu).toHaveBeenCalledWith('http://localhost:4173/preview');
  });

  it('links agent mentions in Markdown without touching inline code', () => {
    useRuntimeStore.getState().hydrateRuntime(ready({ subagents: [childRun] }));
    render(<AssistantMarkdown text={'Ping @auth-reviewer-1, then run `@auth-reviewer-1`.'} />);
    expect(screen.getAllByRole('button', { name: '@auth-reviewer-1' })).toHaveLength(1);
    expect(screen.getByText('@auth-reviewer-1', { selector: 'code' })).toBeInTheDocument();
  });

  it('places message metadata and icon actions below the bubble', () => {
    useRuntimeStore.setState({ runtime: ready({
      sessionCapabilities: { fork: true, clone: true, import: true, compact: true },
      forkPoints: [{ entryId: 'prompt-1', text: 'Refine this component' }],
    }) });
    useRuntimeStore.getState().applyEvents([
      { type: 'message.completed', messageId: 'user-1', role: 'user', text: 'Refine this component', timestamp: 1 },
      { type: 'message.completed', messageId: 'assistant-1', role: 'assistant', text: 'Done.', timestamp: 2 },
    ]);
    const { container } = render(<MessageRow messageId="assistant-1" />);
    const bubble = container.querySelector('.chat-message');
    const footer = container.querySelector('.message-footer');
    if (!bubble || !footer) throw new Error('Expected a message bubble and footer.');
    expect(bubble.querySelector('.message-footer')).toBeNull();
    expect(footer).toHaveTextContent('Model');
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fork from this message' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('copies message text through the trusted desktop clipboard bridge', async () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.completed', messageId: 'copy-me', role: 'assistant', text: 'Copy this exact response', timestamp: 1 },
    ]);
    const writeClipboardText = vi.fn(async () => undefined);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { writeClipboardText } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    const { container } = render(<MessageRow messageId="copy-me" />);

    await user.hover(container.querySelector('.chat-message-row')!);
    await user.click(screen.getByRole('button', { name: 'Copy message' }));

    expect(writeClipboardText).toHaveBeenCalledWith('Copy this exact response');
    expect(await screen.findByRole('button', { name: 'Message copied' })).toBeInTheDocument();
    expect(useUiStore.getState().toast).toMatchObject({ kind: 'success', title: 'Message copied' });
  });

  it('maps long and duplicate prompts to Pi fork points by active-branch order', () => {
    const longPrompt = `Keep this exact context: ${'x'.repeat(2_500)}`;
    const messages = {
      'user-1': { role: 'user', text: longPrompt },
      'assistant-1': { role: 'assistant', text: 'First answer' },
      'user-2': { role: 'user', text: longPrompt },
      'assistant-2': { role: 'assistant', text: 'Second answer' },
    };
    const points = [
      { entryId: 'entry-1', text: longPrompt.slice(0, 2_000) },
      { entryId: 'entry-2', text: longPrompt.slice(0, 2_000) },
    ];
    const order = ['user-1', 'assistant-1', 'user-2', 'assistant-2'];

    expect(forkEntryForMessage('assistant-1', order, messages, points)).toBe('entry-1');
    expect(forkEntryForMessage('assistant-2', order, messages, points)).toBe('entry-2');
  });

  it('retries an assistant response by forking and resending its originating prompt', async () => {
    const originalPrompt = `Retry this: ${'detail '.repeat(400)}`;
    const state = ready({
      sessionCapabilities: { fork: true, clone: true, import: true, compact: true },
      forkPoints: [{ entryId: 'prompt-long', text: originalPrompt.slice(0, 2_000) }],
    });
    useRuntimeStore.setState({ runtime: state });
    useRuntimeStore.getState().applyEvents([
      { type: 'message.completed', messageId: 'user-long', role: 'user', text: originalPrompt, timestamp: 1 },
      { type: 'message.completed', messageId: 'assistant-long', role: 'assistant', text: 'Previous answer', timestamp: 2 },
    ]);
    const forkSession = vi.fn(async () => ({ state, selectedText: originalPrompt }));
    const prompt = vi.fn(async () => ({ accepted: true as const, runId: 'retry-run' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { forkSession, prompt } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<MessageRow messageId="assistant-long" />);

    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry).toBeEnabled();
    await user.click(retry);

    expect(forkSession).toHaveBeenCalledWith('prompt-long');
    expect(prompt).toHaveBeenCalledWith({ text: originalPrompt, behavior: 'prompt' });
    expect(useUiStore.getState().toast).toMatchObject({ kind: 'success', title: 'Trying again' });
  });

  it('injects the clicked assistant response into the fork composer instead of its user prompt', async () => {
    const state = ready({
      sessionCapabilities: { fork: true, clone: true, import: true, compact: true },
      forkPoints: [{ entryId: 'prompt-1', text: 'My original prompt' }],
    });
    useRuntimeStore.setState({ runtime: state });
    useRuntimeStore.getState().applyEvents([
      { type: 'message.completed', messageId: 'user-1', role: 'user', text: 'My original prompt', timestamp: 1 },
      { type: 'message.completed', messageId: 'assistant-1', role: 'assistant', text: 'The assistant response to carry forward', timestamp: 2 },
    ]);
    const forkSession = vi.fn(async () => ({ state, selectedText: 'My original prompt' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { forkSession } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<MessageRow messageId="assistant-1" />);

    await user.click(screen.getByRole('button', { name: 'Fork from this message' }));

    expect(forkSession).toHaveBeenCalledWith('prompt-1');
    expect(useUiStore.getState().composerDraftRequest).toMatchObject({
      text: 'The assistant response to carry forward',
      selectAll: true,
    });
  });

  it('copies only the source inside a fenced code block', async () => {
    const writeText = vi.fn(async () => undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { container } = render(<AssistantMarkdown text={'```ts\nconst answer = 42;\n```'} />);
    const copy = screen.getByRole('button', { name: 'Copy code' });
    const shell = container.querySelector('.code-block-shell');
    expect(shell?.querySelector('pre.code-block')).not.toContainElement(copy);
    expect(shell).toContainElement(copy);
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith('const answer = 42;');
  });

  it('renders Mermaid fences as diagrams instead of raw code', async () => {
    render(<AssistantMarkdown text={'```mermaid\nflowchart LR\n  A --> B\n```'} />);
    expect(screen.getByRole('status')).toHaveTextContent('Rendering diagram');
    const diagram = await screen.findByRole('img', { name: 'Mermaid diagram' });
    expect(diagram).toBeInTheDocument();
    expect(diagram.querySelector('script')).not.toBeInTheDocument();
    expect(diagram.querySelector('[onclick]')).not.toBeInTheDocument();
    expect(screen.queryByText('flowchart LR')).not.toBeInTheDocument();
  });

  it('bounds Mermaid parsing work for oversized model-authored diagrams', async () => {
    const source = `flowchart LR\n${Array.from({ length: 1_001 }, (_value, index) => `A${index} --> A${index + 1}`).join('\n')}`;
    render(<AssistantMarkdown text={`\`\`\`mermaid\n${source}\n\`\`\``} />);
    expect(await screen.findByText('Diagram could not be rendered')).toBeInTheDocument();
    expect(screen.getByText(/diagram source truncated/)).toBeInTheDocument();
  });

  it('rejects Mermaid sources that could fetch remote resources before rendering', async () => {
    const source = 'flowchart LR\n  A[image: https://tracking.example/pixel.png]';
    const encodedHtmlBypass = '%%{init: {"flowchart":{"htmlLabels":true}}}%%\nflowchart LR\nA["<img src=\'https&#58;//tracking.example/pixel\'>"]';
    const cssUrlBypass = 'flowchart LR\nA --> B\nstyle A fill:url(https\\3a//tracking.example/pixel.svg)';
    const schemeRelativeBypass = 'flowchart LR\nA[//tracking.example/pixel.svg]';
    expect(isSafeMermaidSource(source)).toBe(false);
    expect(isSafeMermaidSource(encodedHtmlBypass)).toBe(false);
    expect(isSafeMermaidSource(cssUrlBypass)).toBe(false);
    expect(isSafeMermaidSource(schemeRelativeBypass)).toBe(false);
    render(<AssistantMarkdown text={`\`\`\`mermaid\n${encodedHtmlBypass}\n\`\`\``} />);
    expect(await screen.findByText('Diagram could not be rendered')).toBeInTheDocument();
  });

  it('saves from cinematic view and closes from its backdrop without closing on the image', async () => {
    const saveImageAs = vi.fn(async () => ({ saved: true as const, path: 'C:/Pictures/architecture.png' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { saveImageAs } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<AssistantMarkdown text={'![Architecture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)'} />);
    const trigger = screen.getByRole('button', { name: 'Expand image: Architecture' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Save image as' }));
    expect(await screen.findByRole('button', { name: 'Image saved' })).toBeInTheDocument();
    expect(saveImageAs).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/png', suggestedName: 'Architecture' }));
    expect(dialog).toBeInTheDocument();
    await user.click(screen.getByRole('img', { name: 'Architecture' }));
    expect(dialog).toBeInTheDocument();
    await user.click(dialog);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Close image viewer' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the cinematic viewer open when its virtualized message row is recycled', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ConversationImageViewerProvider>
        <AssistantMarkdown text={'![Architecture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)'} />
      </ConversationImageViewerProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Expand image: Architecture' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    rerender(<ConversationImageViewerProvider><span>Row recycled</span></ConversationImageViewerProvider>);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close image viewer' })).toBeInTheDocument();
  });

  it('does not fetch model-authored remote images without user consent', async () => {
    const user = userEvent.setup();
    render(<AssistantMarkdown text={'![Remote preview](https://images.example.test/preview.png)'} />);
    expect(screen.queryByRole('img', { name: 'Remote preview' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load remote image: Remote preview' }));
    expect(screen.getByRole('img', { name: 'Remote preview' })).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('loads local images referenced by their on-device path', async () => {
    const readLocalImage = vi.fn(async () => ({ data: 'iVBORw0KGgo=', mimeType: 'image/png' as const }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { readLocalImage } as unknown as PiDesktopApi });

    render(<AssistantMarkdown text={'![SomaHue meditation video section](C:/elsewhere/chakra-video-section.png)'} />);

    expect(await screen.findByRole('img', { name: 'SomaHue meditation video section' })).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=');
    expect(readLocalImage).toHaveBeenCalledWith('C:/elsewhere/chakra-video-section.png');
  });

  it('renders structured image blocks returned by an image-capable model', () => {
    render(<AssistantMarkdown text="" images={[{ data: 'iVBORw0KGgo=', mimeType: 'image/png', alt: 'Generated concept' }]} />);
    expect(screen.getByRole('button', { name: 'Expand image: Generated concept' })).toBeInTheDocument();
  });

  it('shows sent attachments and image-producing tool results in the live timeline', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.completed', messageId: 'user-image', role: 'user', text: 'What is in this?', images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png', alt: 'Attached image 1' }], timestamp: 1 },
      { type: 'tool.started', toolCallId: 'image-tool', name: 'generate_image', input: '{}', timestamp: 2 },
      { type: 'tool.completed', toolCallId: 'image-tool', name: 'generate_image', output: 'Generated preview', images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png', alt: 'Generated image 1' }], error: false, timestamp: 3 },
    ]);
    expect(useRuntimeStore.getState().messagesById['user-image']?.images).toHaveLength(1);
    expect(useRuntimeStore.getState().toolsById['image-tool']?.images).toHaveLength(1);
    render(<><MessageRow messageId="user-image" /><ToolCard toolCallId="image-tool" /></>);
    expect(screen.getByRole('button', { name: 'Expand image: Attached image 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand image: Generated image 1' })).toBeInTheDocument();
  });

  it('omits empty assistant shells while keeping reasoning and tool rows contiguous', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.started', messageId: 'assistant-empty', role: 'assistant', timestamp: 1 },
      { type: 'assistant.reasoning', messageId: 'assistant-empty', delta: 'Checking the project', timestamp: 2 },
      { type: 'message.completed', messageId: 'assistant-empty', role: 'assistant', text: '', timestamp: 3 },
      { type: 'tool.started', toolCallId: 'read-1', name: 'read', input: '{}', timestamp: 4 },
    ]);
    render(<div style={{ height: 600 }}><ConversationTimeline /></div>);
    expect(screen.queryByText('Pi')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Conversation timeline')).toHaveAttribute('data-visible-entry-count', '2');
  });

  it('coalesces adjacent subagent wait polls in the timeline without dropping runtime history', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'tool.started', toolCallId: 'wait-1', name: 'subagent_manage', input: '{"action":"wait","runIds":["@review-1"],"until":"activity","timeoutSeconds":10}', timestamp: 1 },
      { type: 'tool.completed', toolCallId: 'wait-1', name: 'subagent_manage', output: 'Still running', error: false, timestamp: 2 },
      { type: 'tool.started', toolCallId: 'wait-2', name: 'subagent_manage', input: '{"action":"wait","runIds":["@review-1"],"until":"activity","timeoutSeconds":30}', timestamp: 3 },
      { type: 'tool.completed', toolCallId: 'wait-2', name: 'subagent_manage', output: 'Still running', error: false, timestamp: 4 },
      { type: 'tool.started', toolCallId: 'wait-3', name: 'subagent_manage', input: '{"action":"wait","runIds":["@review-1"],"until":"all","timeoutSeconds":1200}', timestamp: 5 },
    ]);
    const state = useRuntimeStore.getState();
    const display = coalesceSubagentWaitPolls(state.visibleTimelineOrder, state.timelineById, state.toolsById);

    expect(state.toolOrder).toEqual(['wait-1', 'wait-2', 'wait-3']);
    expect(state.visibleTimelineOrder).toHaveLength(3);
    expect(display).toEqual({ order: ['tool:wait-3'], waitPollCountById: { 'tool:wait-3': 3 } });

    render(<div style={{ height: 600 }}><ConversationTimeline /></div>);
    expect(screen.getByLabelText('Conversation timeline')).toHaveAttribute('data-visible-entry-count', '1');

    render(<ToolCard toolCallId="wait-3" waitPollCount={3} />);
    expect(screen.getAllByRole('article', { name: /subagent_manage tool/iu })).toHaveLength(1);
    expect(screen.getByText('3 wait polls · Running')).toBeInTheDocument();
  });

  it('keeps failed, differently targeted, and interrupted waits visible', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'tool.started', toolCallId: 'wait-a', name: 'subagent_manage', input: '{"action":"wait","runIds":["@review-1"]}', timestamp: 1 },
      { type: 'tool.completed', toolCallId: 'wait-a', name: 'subagent_manage', output: 'Wait failed', error: true, timestamp: 2 },
      { type: 'tool.started', toolCallId: 'wait-b', name: 'subagent_manage', input: '{"action":"wait","runIds":["@review-1"]}', timestamp: 3 },
      { type: 'tool.started', toolCallId: 'wait-c', name: 'subagent_manage', input: '{"action":"wait","runIds":["@review-2"]}', timestamp: 4 },
      { type: 'tool.started', toolCallId: 'status', name: 'subagent_manage', input: '{"action":"status","runIds":["@review-2"]}', timestamp: 5 },
      { type: 'tool.started', toolCallId: 'wait-d', name: 'subagent_manage', input: '{"action":"wait","runIds":["@review-2"]}', timestamp: 6 },
    ]);
    const state = useRuntimeStore.getState();

    expect(coalesceSubagentWaitPolls(state.visibleTimelineOrder, state.timelineById, state.toolsById).order).toEqual([
      'tool:wait-a', 'tool:wait-b', 'tool:wait-c', 'tool:status', 'tool:wait-d',
    ]);
  });

  it('keeps tool calls compact while exposing details and status on the icon', async () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'tool.started', toolCallId: 'passed', name: 'read', input: '{"path":"README.md"}', timestamp: 10 },
      { type: 'tool.completed', toolCallId: 'passed', name: 'read', output: 'contents', error: false, timestamp: 20 },
      { type: 'tool.started', toolCallId: 'failed', name: 'bash', input: '{"command":"exit 1"}', timestamp: 30 },
      { type: 'tool.completed', toolCallId: 'failed', name: 'bash', output: 'failed', error: true, timestamp: 40 },
    ]);
    const user = userEvent.setup();
    const { container } = render(<><ToolCard toolCallId="passed" /><ToolCard toolCallId="failed" /></>);

    expect(container.querySelector('.tool-card--succeeded .tool-status-icon')).toBeInTheDocument();
    expect(container.querySelector('.tool-card--error .tool-status-icon')).toBeInTheDocument();
    const failedTool = screen.getByRole('article', { name: 'bash tool error' });
    const disclosure = failedTool.querySelector('button');
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await user.click(disclosure!);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(failedTool).toHaveTextContent('failed');
  });

  it('keeps subagent lifecycle state visible in its compact tool card', () => {
    const launchTool = {
      id: 'delegate-auth', name: 'subagent_start', input: '{"task":"Review auth"}', output: 'Started @auth-reviewer-1',
      outputTruncated: false, status: 'succeeded' as const, startedAt: 1, updatedAt: 2, endedAt: 2,
      subagentRunIds: [childRun.id],
    };
    const hydrateChild = (run: SubagentRun) => useRuntimeStore.getState().hydrateRuntime(ready({
      subagents: [run],
      tools: [launchTool],
    }));
    hydrateChild(childRun);
    const { container } = render(<ToolCard toolCallId={launchTool.id} />);

    expect(screen.getByRole('article', { name: 'subagent_start tool running' })).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.queryByText(/Child session .* settled/iu)).not.toBeInTheDocument();

    act(() => hydrateChild({ ...childRun, status: 'completed', endedAt: 3, updatedAt: 3, result: 'Auth is sound.' }));
    expect(screen.getByRole('article', { name: 'subagent_start tool completed' })).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();

    act(() => hydrateChild({ ...childRun, status: 'error', endedAt: 4, updatedAt: 4, error: 'Review failed.' }));
    expect(screen.getByRole('article', { name: 'subagent_start tool error' })).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(container.querySelector('.tool-card--error .tool-status-icon')).toBeInTheDocument();
  });

  it('inserts resource commands at the caret without replacing the current draft', async () => {
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);
    const composer = screen.getByRole('textbox', { name: 'Message Pi' }) as HTMLTextAreaElement;
    await user.type(composer, 'Keep this draft');
    composer.setSelectionRange(5, 5);

    act(() => useUiStore.getState().requestComposerInsertion('/review '));

    await waitFor(() => expect(composer).toHaveValue('Keep /review this draft'));
    expect(composer).toHaveFocus();
    await waitFor(() => expect(composer).toHaveProperty('selectionStart', 13));
  });

  it('shows actual Pi context usage beside the send action', () => {
    useRuntimeStore.setState({ runtime: ready({ contextUsage: { tokens: 42_000, contextWindow: 100_000, percent: 42 } }) });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    render(<Composer onOpenProject={vi.fn()} />);
    const meter = screen.getByRole('meter', { name: 'Context usage: 42% of 100k tokens' });
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    expect(meter).not.toHaveTextContent('42');
  });

  it('shows a completed post-compaction estimate instead of an endless recalculating state', async () => {
    const user = userEvent.setup();
    const view = render(<ContextWheel usage={{ tokens: 24_000, contextWindow: 100_000, percent: 24, estimated: true }} />);
    const estimated = screen.getByRole('meter', { name: 'Estimated context usage: 24% of 100k tokens' });
    await user.hover(estimated);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Estimated context ~24k / 100k · ~24%');

    view.rerender(<ContextWheel usage={{ tokens: null, contextWindow: 100_000, percent: null }} />);
    expect(screen.getByRole('meter', { name: 'Context usage will update after the next response for a 100k token window' })).toBeInTheDocument();
    expect(screen.queryByText(/recalculating/iu)).not.toBeInTheDocument();
  });

  it('anchors the model beside context usage and shortens unusually long names', async () => {
    const fullName = 'A very long provider model name for production';
    useRuntimeStore.setState({ runtime: ready({ model: { ...ready().model!, name: fullName } }) });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    const user = userEvent.setup();
    const { container } = render(<Composer onOpenProject={vi.fn()} />);
    const modelButton = screen.getByRole('button', { name: 'Model and reasoning settings' });
    const modelContext = container.querySelector('.composer-model-context');
    expect(modelButton).not.toHaveAttribute('title');
    await user.hover(modelButton);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(`Current: ${fullName} Next: ${fullName}`);
    expect(modelButton.querySelector('strong')).toHaveTextContent(`${fullName.slice(0, 27).trimEnd()}…`);
    expect(modelContext).toContainElement(modelButton);
    expect(modelContext).toContainElement(screen.getByRole('meter'));
  });

  it('selects real Pi tool levels and confirms unsandboxed Full access', async () => {
    const state = ready();
    const setPermissionLevel = vi.fn(async (level: 'read-only' | 'edit' | 'full-access') => ({ ...state, permissionLevel: level }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { setPermissionLevel } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Permission level: Edit files' }));
    expect(screen.getByRole('dialog', { name: 'Permission level' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Read only' }));
    expect(setPermissionLevel).toHaveBeenCalledWith('read-only');
    expect(await screen.findByRole('button', { name: 'Permission level: Read only' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Permission level: Read only' }));
    await user.click(screen.getByRole('button', { name: 'Full access' }));
    expect(screen.getByText('Enable Full access?')).toBeInTheDocument();
    expect(setPermissionLevel).not.toHaveBeenCalledWith('full-access');
    await user.click(screen.getByRole('button', { name: 'Enable full access' }));
    expect(setPermissionLevel).toHaveBeenCalledWith('full-access');
    expect(await screen.findByRole('button', { name: 'Permission level: Full access' })).toBeInTheDocument();
  });

  it('moves auxiliary actions into an upward compact popover without hiding permissions', async () => {
    vi.spyOn(HTMLFormElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 500, bottom: 124, left: 0, width: 500, height: 124,
      toJSON: () => ({}),
    } as DOMRect);
    const listFiles = vi.fn(async () => ({
      path: '',
      entries: [
        { path: 'README.md', name: 'README.md', kind: 'file' as const, symlink: false },
        { path: 'src', name: 'src', kind: 'directory' as const, symlink: false },
      ],
      truncated: false,
    }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { listFiles } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    const permission = screen.getByRole('button', { name: 'Permission level: Edit files' });
    expect(permission.querySelector('span')).toBeNull();
    expect(permission).not.toHaveAttribute('title');
    await user.hover(permission);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Permission: Edit files');
    await user.click(screen.getByRole('button', { name: 'Open composer tools' }));
    const tools = screen.getByRole('dialog', { name: 'Composer tools' });
    const projectTagButton = within(tools).getByRole('button', { name: 'Tag project file or folder' });
    expect(projectTagButton.querySelector('.lucide-hash')).toBeInTheDocument();
    expect(projectTagButton.querySelector('.lucide-at-sign')).not.toBeInTheDocument();
    await user.click(projectTagButton);
    expect(screen.getByLabelText('Message Pi')).toHaveValue('#');
    const resources = await screen.findByRole('listbox', { name: 'Project resources' });
    expect(within(resources).getByRole('option', { name: /#README\.md.*project file/iu })).toBeInTheDocument();
    expect(within(resources).getByRole('option', { name: /#src.*folder/iu })).toBeInTheDocument();
    expect(listFiles).toHaveBeenCalledWith('');
    expect(screen.queryByRole('dialog', { name: 'Composer tools' })).not.toBeInTheDocument();
  });

  it('offers real slash/file gates and sends with the desktop prompt API', async () => {
    const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: {
        prompt,
        abort: vi.fn(),
        listFiles: vi.fn(async () => ({
          path: '',
          entries: [{ path: 'src/example file.ts', name: 'example file.ts', kind: 'file' as const, symlink: false }],
          truncated: false,
        })),
      } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Attach image' })).toBeDisabled();
    await user.type(screen.getByLabelText('Message Pi'), '/rev');
    expect(screen.getByRole('option', { name: /review/i })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /review/i }));
    expect(screen.getByLabelText('Message Pi')).toHaveValue('/review ');

    await user.click(screen.getByRole('button', { name: 'Tag project file or folder' }));
    expect(screen.getByLabelText('Message Pi')).toHaveValue('/review #');
    await user.click(await screen.findByRole('option', { name: /#"src\/example file\.ts"/iu }));
    expect(screen.getByLabelText('Message Pi')).toHaveValue('/review #"src/example file.ts" ');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(prompt).toHaveBeenCalledWith({ text: '/review #"src/example file.ts"', behavior: 'prompt' });
  });

  it('sends typed browser annotation references and clears only accepted attachments', async () => {
    const annotation: BrowserAnnotation = {
      id: 'browser-note-1', tabId: 'browser-main', url: 'https://example.test/', origin: 'https://example.test',
      documentEpoch: 1, pageRevision: 1, kind: 'element',
      target: {
        frameId: 'frame-main', semanticRef: 'e1', role: 'button', accessibleName: 'Save changes', tagName: 'button',
        rectCssPx: { x: 1, y: 2, width: 30, height: 20 }, rectNormalized: { x: 0, y: 0, width: 0.1, height: 0.1 },
        locatorHints: {}, fingerprint: { attributesHash: 'a', nearbyTextHash: 'b', ancestorHash: 'c' },
      },
      comment: 'Use this exact control', semanticCoverage: 1, reattachConfidence: 0.9, createdAt: 1,
    };
    useBrowserStore.getState().hydrate({
      activeTabId: 'browser-main', visible: false, viewBlocked: false, sessionFullAccess: false, paused: true, controlLevel: 'off', mode: 'agent', tabs: [], grants: [],
    }, '/project');
    useBrowserStore.getState().setAnnotations([annotation]);
    attachBrowserAnnotationToSession('/project', 's1', annotation.id);
    const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-browser-note' }));
    const dismissBrowserAnnotations = vi.fn(async () => true);
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt, dismissBrowserAnnotations } as unknown as PiDesktopApi });
    render(<Composer onOpenProject={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Remove browser annotation 1' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Message Pi'), { target: { value: 'Update this component' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(prompt).toHaveBeenCalledWith({
      text: 'Update this component', behavior: 'prompt', browserAnnotations: [{ id: annotation.id }],
    }));
    await waitFor(() => expect(dismissBrowserAnnotations).toHaveBeenCalledWith([annotation.id]));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove browser annotation 1' })).not.toBeInTheDocument());
  });

  it('autocompletes project files and folders with canonical # tags', async () => {
    const searchFiles = vi.fn(async () => ({ entries: [
      { path: 'src', name: 'src', kind: 'directory' as const, symlink: false },
      { path: 'src/nested/view.tsx', name: 'view.tsx', kind: 'file' as const, symlink: false },
    ], truncated: false }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { searchFiles, listFiles: vi.fn(async () => ({ entries: [], truncated: false })) } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);
    const input = screen.getByLabelText('Message Pi');

    await user.type(input, '#src');
    const resources = await screen.findByRole('listbox', { name: 'Project resources' });
    expect(within(resources).getByRole('option', { name: /#src.*folder.*descendant files/iu })).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(input).toHaveValue('#src/nested/view.tsx ');
    expect(searchFiles).toHaveBeenCalledWith('src', 100);
  });

  it('restores an Untitled session draft after a composer remount without sharing it', async () => {
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    const first = render(<Composer onOpenProject={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Message Pi'), { target: { value: 'Untitled session draft' } });
    first.unmount();

    render(<Composer onOpenProject={vi.fn()} />);
    expect(screen.getByLabelText('Message Pi')).toHaveValue('Untitled session draft');
    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 'another-untitled-session' })));
    expect(screen.getByLabelText('Message Pi')).toHaveValue('');
    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 's1' })));
    expect(screen.getByLabelText('Message Pi')).toHaveValue('Untitled session draft');
  });

  it('clears an accepted draft even when the composer remounts while prompt admission is pending', async () => {
    let acceptPrompt: ((value: { accepted: boolean; runId: string }) => void) | undefined;
    const prompt = vi.fn(() => new Promise<{ accepted: boolean; runId: string }>((resolve) => { acceptPrompt = resolve; }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt } as unknown as PiDesktopApi });
    const first = render(<Composer onOpenProject={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Message Pi'), { target: { value: 'Send once' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    first.unmount();

    render(<Composer onOpenProject={vi.fn()} />);
    expect(screen.getByLabelText('Message Pi')).toHaveValue('Send once');
    act(() => acceptPrompt?.({ accepted: true, runId: 'run-1' }));
    await waitFor(() => expect(screen.getByLabelText('Message Pi')).toHaveValue(''));
  });

  it('restores one project new-session draft until Pi accepts it', async () => {
    const savedSession = {
      id: 'saved', title: 'Saved session', firstMessage: 'Saved prompt', path: '/sessions/saved.jsonl',
      createdAt: '2025-01-01T00:00:00.000Z', modifiedAt: '2025-01-02T00:00:00.000Z', messageCount: 2, active: false,
    };
    const prompt = vi.fn()
      .mockResolvedValueOnce({ accepted: false, runId: 'rejected' })
      .mockResolvedValueOnce({ accepted: true, runId: 'accepted' });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt } as unknown as PiDesktopApi });
    useRuntimeStore.getState().setRuntime(ready({ sessionId: 'draft-1', sessions: [savedSession] }));
    render(<Composer onOpenProject={vi.fn()} />);
    const input = screen.getByLabelText('Message Pi');

    fireEvent.change(input, { target: { value: 'Keep this new-session draft' } });
    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 'saved', sessions: [{ ...savedSession, active: true }] })));
    await waitFor(() => expect(input).toHaveValue(''));

    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 'draft-2', sessions: [savedSession] })));
    await waitFor(() => expect(input).toHaveValue('Keep this new-session draft'));

    const send = screen.getByRole('button', { name: 'Send message' });
    fireEvent.click(send);
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(send).toBeEnabled());
    expect(input).toHaveValue('Keep this new-session draft');

    fireEvent.click(send);
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input).toHaveValue(''));

    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 'saved', sessions: [{ ...savedSession, active: true }] })));
    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 'draft-3', sessions: [savedSession] })));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('autocompletes stable agent handles and executes only exact stop syntax directly', async () => {
    const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
    const controlSubagent = vi.fn(async () => ready({ subagents: [{ ...childRun, status: 'cancelled', endedAt: 3 }] }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { prompt, controlSubagent } as unknown as PiDesktopApi,
    });
    useRuntimeStore.getState().hydrateRuntime(ready({ subagents: [childRun] }));
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);
    const input = screen.getByLabelText('Message Pi');

    await user.type(input, '@auth');
    const mentions = screen.getByRole('listbox', { name: 'Agent mentions' });
    expect(within(mentions).getByRole('option', { name: /@auth-reviewer-1.*Auth Reviewer.*running.*authentication flow/iu })).toBeInTheDocument();
    const deferredFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      deferredFrames.push(callback);
      return deferredFrames.length;
    });
    await user.click(within(mentions).getByRole('option'));
    expect(input).toHaveValue('@auth-reviewer-1 ');

    await user.type(input, 's');
    act(() => deferredFrames.splice(0).forEach((callback) => callback(0)));
    await user.type(input, 'ummarize your findings');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledWith({ text: '@auth-reviewer-1 summarize your findings', behavior: 'prompt' }));
    expect(controlSubagent).not.toHaveBeenCalled();

    await user.type(input, '@stop @auth-reviewer-1');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(controlSubagent).toHaveBeenCalledWith({ action: 'cancel', target: '@auth-reviewer-1' }));
    expect(prompt).toHaveBeenCalledOnce();
    expect(input).toHaveValue('');
  });

  it('locks rapid submissions and preserves newer draft and attachment edits after delayed acceptance', async () => {
    let acceptPrompt: ((value: { accepted: boolean; runId: string }) => void) | undefined;
    const prompt = vi.fn(() => new Promise<{ accepted: boolean; runId: string }>((resolve) => { acceptPrompt = resolve; }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt } as unknown as PiDesktopApi });
    useRuntimeStore.setState({ runtime: ready({ model: { ...ready().model!, supportsImages: true } }) });
    render(<Composer onOpenProject={vi.fn()} />);
    const input = screen.getByLabelText('Message Pi');
    const firstImage = new File(['first'], 'first.png', { type: 'image/png' });
    const newerImage = new File(['newer'], 'newer.png', { type: 'image/png' });
    fireEvent.paste(input, { clipboardData: { files: [firstImage] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove first.png' })).toBeInTheDocument());
    fireEvent.change(input, { target: { value: 'Submitted draft' } });

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.submit(input.closest('form')!);
    expect(prompt).toHaveBeenCalledOnce();

    fireEvent.change(input, { target: { value: 'Newer edit' } });
    fireEvent.paste(input, { clipboardData: { files: [newerImage] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove newer.png' })).toBeInTheDocument());
    acceptPrompt?.({ accepted: true, runId: 'run-1' });

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove first.png' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Remove newer.png' })).toBeInTheDocument();
    expect(input).toHaveValue('Newer edit');
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Submitted draft',
      images: [expect.objectContaining({ name: 'first.png' })],
    }));
  });

  it('isolates and restores unfinished text and attachments for each project session', async () => {
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    const imageModel = { ...ready().model!, supportsImages: true };
    useRuntimeStore.setState({ runtime: ready({ model: imageModel }) });
    render(<Composer onOpenProject={vi.fn()} />);
    const input = screen.getByLabelText('Message Pi');

    fireEvent.change(input, { target: { value: 'Session one draft' } });
    fireEvent.paste(input, { clipboardData: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove one.png' })).toBeInTheDocument());

    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 's2', model: imageModel })));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByRole('button', { name: 'Remove one.png' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Session two draft' } });

    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 's1', model: imageModel })));
    await waitFor(() => expect(input).toHaveValue('Session one draft'));
    expect(screen.getByRole('button', { name: 'Remove one.png' })).toBeInTheDocument();

    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 's2', model: imageModel })));
    await waitFor(() => expect(input).toHaveValue('Session two draft'));
    expect(screen.queryByRole('button', { name: 'Remove one.png' })).not.toBeInTheDocument();
  });

  it('restores each session selection even when the draft text is identical', async () => {
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    render(<Composer onOpenProject={vi.fn()} />);
    const input = screen.getByLabelText('Message Pi') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'identical draft' } });
    input.setSelectionRange(1, 4);
    fireEvent.select(input);
    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 's2' })));
    await waitFor(() => expect(input).toHaveValue(''));
    fireEvent.change(input, { target: { value: 'identical draft' } });
    input.setSelectionRange(6, 11);
    fireEvent.select(input);

    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 's1' })));
    await waitFor(() => expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]));
    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 's2' })));
    await waitFor(() => expect([input.selectionStart, input.selectionEnd]).toEqual([6, 11]));
  });

  it('clears an accepted origin draft without touching the session selected while acceptance is pending', async () => {
    let acceptPrompt: ((value: { accepted: boolean; runId: string }) => void) | undefined;
    const prompt = vi.fn(() => new Promise<{ accepted: boolean; runId: string }>((resolve) => { acceptPrompt = resolve; }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt } as unknown as PiDesktopApi });
    render(<Composer onOpenProject={vi.fn()} />);
    const input = screen.getByLabelText('Message Pi');

    fireEvent.change(input, { target: { value: 'Accepted in session one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 's2' })));
    await waitFor(() => expect(input).toHaveValue(''));
    fireEvent.change(input, { target: { value: 'Keep session two' } });

    acceptPrompt?.({ accepted: true, runId: 'run-1' });
    await waitFor(() => expect(input).toHaveValue('Keep session two'));
    act(() => useRuntimeStore.getState().setRuntime(ready({ sessionId: 's1' })));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('sends with Enter by default and keeps modifier-only sending as an opt-in', async () => {
    const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    const { unmount } = render(<Composer onOpenProject={vi.fn()} />);
    const defaultInput = screen.getByLabelText('Message Pi');

    await user.type(defaultInput, 'send now');
    fireEvent.keyDown(defaultInput, { key: 'Enter', shiftKey: true });
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.keyDown(defaultInput, { key: 'Enter' });
    await waitFor(() => expect(prompt).toHaveBeenCalledWith({ text: 'send now', behavior: 'prompt' }));
    unmount();

    useUiStore.setState({ sendMessageWithModifier: true });
    render(<Composer onOpenProject={vi.fn()} />);
    const modifierInput = screen.getByLabelText('Message Pi');
    await user.type(modifierInput, 'keep editing');
    fireEvent.keyDown(modifierInput, { key: 'Enter' });
    expect(prompt).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(modifierInput, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(prompt).toHaveBeenLastCalledWith({ text: 'keep editing', behavior: 'prompt' }));
  });

  it('resizes only from the upper composer separator and exposes themed overflow fades', async () => {
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    const user = userEvent.setup();
    render(<div className="welcome" style={{ height: 600 }}><Composer onOpenProject={vi.fn()} /></div>);
    const handle = screen.getByRole('separator', { name: 'Resize message input' });
    expect(handle).toHaveAttribute('aria-valuenow', '53');
    handle.focus();
    await user.keyboard('{ArrowUp}');
    expect(handle).toHaveAttribute('aria-valuenow', '71');

    const input = screen.getByLabelText('Message Pi');
    Object.defineProperties(input, {
      clientHeight: { configurable: true, value: 53 },
      scrollHeight: { configurable: true, value: 180 },
    });
    input.scrollTop = 10;
    fireEvent.scroll(input);
    const shell = input.closest('.composer-input-shell');
    expect(shell).toHaveAttribute('data-overflow-top', 'true');
    expect(shell).toHaveAttribute('data-overflow-bottom', 'true');
  });

  it('shows every command at prompt start and only skills or prompts for an inline slash', async () => {
    useRuntimeStore.setState({ runtime: ready({ commands: [
      { name: 'parallax', description: 'Control the Parallax protocol', source: 'extension' },
      { name: 'skill:vibesecurity', description: 'Defensive, evidence-first security review', source: 'skill' },
      { name: 'review', description: 'Review current changes', source: 'prompt' },
    ] }) });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);
    const input = screen.getByLabelText('Message Pi');

    await user.type(input, '/');
    let list = screen.getByRole('listbox', { name: 'Skills and commands' });
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    expect(within(list).getByRole('option', { name: /parallax/i })).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'ask /');
    list = screen.getByRole('listbox', { name: 'Skills and commands' });
    expect(list).toHaveTextContent('Skills & prompts');
    expect(within(list).queryByRole('option', { name: /parallax/i })).not.toBeInTheDocument();
    expect(within(list).getAllByRole('option')).toHaveLength(2);

    await user.type(input, 'vibe');
    const option = within(list).getByRole('option', { name: /vibesecurity/i });
    await user.click(option);
    expect(input).toHaveValue('ask /skill:vibesecurity ');

    await user.clear(input);
    await user.type(input, 'ask /not-found');
    expect(screen.queryByRole('listbox', { name: 'Skills and commands' })).not.toBeInTheDocument();
  });

  it('keeps multiple selected skills in one submitted composer message', async () => {
    useRuntimeStore.setState({ runtime: ready({ commands: [
      { name: 'skill:first', description: 'First workflow', source: 'skill' },
      { name: 'skill:second', description: 'Second workflow', source: 'skill' },
    ] }) });
    const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);
    const input = screen.getByLabelText('Message Pi');

    await user.type(input, '/first');
    await user.click(screen.getByRole('option', { name: /first/i }));
    await user.type(input, '/second');
    await user.click(screen.getByRole('option', { name: /second/i }));
    await user.type(input, 'Fix the issue');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(prompt).toHaveBeenCalledWith({
      text: '/skill:first /skill:second Fix the issue',
      behavior: 'prompt',
    });
  });

  it('renders recognized mentions as inspector links without linking unknown handles', async () => {
    useRuntimeStore.getState().hydrateRuntime(ready({ subagents: [childRun] }));
    useRuntimeStore.getState().applyEvents([
      { type: 'message.completed', messageId: 'mention-message', role: 'user', text: 'Ask @auth-reviewer-1, not @missing-agent-1.', timestamp: 1 },
    ]);
    const user = userEvent.setup();
    render(<MessageRow messageId="mention-message" />);

    const mention = screen.getByRole('button', { name: '@auth-reviewer-1' });
    expect(screen.getByText('@missing-agent-1').tagName).toBe('SPAN');
    await user.click(mention);
    expect(useUiStore.getState()).toMatchObject({ inspectorTab: 'sessions', selectedAgent: { kind: 'subagent', runId: childRun.id }, inspectorCollapsed: false });
  });

  it('renders extension output as a distinct system message', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.completed', messageId: 'system-1', role: 'system', text: '**Parallax** active', timestamp: 1 },
    ]);
    const { container } = render(<MessageRow messageId="system-1" />);
    expect(container.querySelector('.message-footer-meta')).toHaveTextContent('System');
    expect(screen.getByText('Parallax').tagName).toBe('STRONG');
    expect(container.querySelector('.chat-message--system')).toBeInTheDocument();
  });

  it('accepts pasted images when the active model supports them', async () => {
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    useRuntimeStore.setState({ runtime: ready({ model: { ...ready().model!, supportsImages: true } }) });
    const { container } = render(<Composer onOpenProject={vi.fn()} />);
    const image = new File(['image'], 'clipboard.png', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('Message Pi'), { clipboardData: { files: [image] } });
    await waitFor(() => expect(container.querySelector('.composer-attachments img')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Remove clipboard.png' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Expand image: clipboard.png' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('clipboard.png');
  });

  it('gives pasted images stable unique names and retains their captured data', async () => {
    const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt } as unknown as PiDesktopApi });
    useRuntimeStore.setState({ runtime: ready({ model: { ...ready().model!, supportsImages: true } }) });
    render(<Composer onOpenProject={vi.fn()} />);
    const imageOne = new File(['first image'], 'clipboard.png', { type: 'image/png' });
    const imageTwo = new File(['second image'], 'clipboard.png', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('Message Pi'), { clipboardData: { files: [imageOne, imageTwo] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove clipboard.png' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove clipboard-1.png' })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Message Pi'), 'Inspect these');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      images: [
        { name: 'clipboard.png', mimeType: 'image/png', data: 'Zmlyc3QgaW1hZ2U=' },
        { name: 'clipboard-1.png', mimeType: 'image/png', data: 'c2Vjb25kIGltYWdl' },
      ],
    }));
    expect(uniqueAttachmentName('clipboard.png', ['clipboard.png', 'clipboard-1.png'])).toBe('clipboard-2.png');
    expect(uniqueAttachmentName('wallpaper.png', ['cover.png'])).toBe('wallpaper.png');
  });

  it('routes /goalmax through the control plane without forwarding slash text to Pi', async () => {
    const created = activeGoalFixture();
    const createGoalMax = vi.fn(async () => created);
    const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { getGoalMax: vi.fn(async () => null), createGoalMax, prompt } as unknown as PiDesktopApi });
    render(<Composer onOpenProject={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Message Pi'), '/goalmax Implement and verify persistence{Enter}');
    await waitFor(() => expect(createGoalMax).toHaveBeenCalledWith({ objective: 'Implement and verify persistence', verificationLevel: 'normal', agentStrategy: 'auto', tokenLimit: null, timeLimitMs: null }));
    expect(prompt).not.toHaveBeenCalled();
    expect(useGoalMaxStore.getState().goal?.id).toBe('goal-1');
  });

  it('keeps bare /goalmax local and opens the current Goal Flight Deck', async () => {
    const prompt = vi.fn();
    useGoalMaxStore.setState({ goal: activeGoalFixture() });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt } as unknown as PiDesktopApi });
    render(<Composer onOpenProject={vi.fn()} />);

    await userEvent.setup().type(screen.getByLabelText('Message Pi'), '/goalmax{Enter}');

    expect(useUiStore.getState()).toMatchObject({ inspectorTab: 'goal', inspectorCollapsed: false });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('routes GoalMax pause, resume, and clear through the thread control plane', async () => {
    const active = activeGoalFixture();
    const paused = { ...active, revision: 2, status: 'paused' as const, executionState: 'idle' as const };
    const controlGoalMax = vi.fn(async ({ action }: { action: string }) => action === 'pause' ? paused : { ...active, revision: 3 });
    const clearGoalMax = vi.fn(async () => ({ cleared: true, archivedGoalId: active.id }));
    const prompt = vi.fn();
    useGoalMaxStore.setState({ goal: active });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { controlGoalMax, clearGoalMax, prompt } as unknown as PiDesktopApi });
    render(<Composer onOpenProject={vi.fn()} />);
    const user = userEvent.setup();
    const input = screen.getByLabelText('Message Pi');

    await user.type(input, '/goalmax pause{Enter}');
    await waitFor(() => expect(controlGoalMax).toHaveBeenCalledWith({ action: 'pause' }));
    await user.type(input, '/goalmax resume{Enter}');
    await waitFor(() => expect(controlGoalMax).toHaveBeenCalledWith({ action: 'resume' }));
    await user.type(input, '/goalmax clear{Enter}');
    await waitFor(() => expect(clearGoalMax).toHaveBeenCalledOnce());

    expect(useGoalMaxStore.getState().goal).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('queues Enter as a follow-up by default during an active Pi run', async () => {
    const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
    const abort = vi.fn(async () => ({ aborted: true }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt, abort } as unknown as PiDesktopApi });
    useRuntimeStore.setState({ runtime: ready({ streaming: true }), queue: { steering: 0, followUp: 0, items: [] } });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    const input = screen.getByLabelText('Message Pi');
    expect(input).toHaveAttribute('placeholder', 'Ask for follow-up changes…');
    await user.type(input, 'change direction{Enter}');
    expect(prompt).toHaveBeenCalledWith({ text: 'change direction', behavior: 'followUp' });
    expect(screen.getByRole('button', { name: 'Queue follow-up message' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Queue follow-up message' }).querySelector('.lucide-arrow-up')).toBeInTheDocument();
    expect(abort).not.toHaveBeenCalled();
  });

  it('queues a streaming arrow short-click exactly once', () => {
    vi.useFakeTimers();
    try {
      const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
      const abort = vi.fn(async () => ({ aborted: true }));
      Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt, abort } as unknown as PiDesktopApi });
      useRuntimeStore.setState({ runtime: ready({ streaming: true }), queue: { steering: 0, followUp: 0, items: [] } });
      render(<Composer onOpenProject={vi.fn()} />);
      fireEvent.change(screen.getByLabelText('Message Pi'), { target: { value: 'Queue this change' } });
      const send = screen.getByRole('button', { name: 'Queue follow-up message' });

      fireEvent.pointerDown(send, { button: 0, pointerId: 7, isPrimary: true });
      vi.advanceTimersByTime(1_250);
      fireEvent.pointerUp(send, { button: 0, pointerId: 7, isPrimary: true });
      fireEvent.click(send);

      expect(prompt).toHaveBeenCalledOnce();
      expect(prompt).toHaveBeenCalledWith({ text: 'Queue this change', behavior: 'followUp' });
      expect(abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts once after a two-second streaming arrow hold and suppresses queue submission', () => {
    vi.useFakeTimers();
    try {
      const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
      const abort = vi.fn(async () => ({ aborted: true }));
      Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt, abort } as unknown as PiDesktopApi });
      useRuntimeStore.setState({ runtime: ready({ streaming: true }), queue: { steering: 0, followUp: 0, items: [] } });
      render(<Composer onOpenProject={vi.fn()} />);
      const send = screen.getByRole('button', { name: 'Queue follow-up message' });

      fireEvent.pointerDown(send, { button: 0, pointerId: 8, isPrimary: true });
      vi.advanceTimersByTime(2_000);
      vi.advanceTimersByTime(5_000);
      fireEvent.pointerUp(send, { button: 0, pointerId: 8, isPrimary: true });
      fireEvent.click(send);

      expect(abort).toHaveBeenCalledOnce();
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an active goal after the two-second composer hold', () => {
    vi.useFakeTimers();
    try {
      const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
      const abort = vi.fn(async () => ({ aborted: true }));
      const cancelled = activeGoalFixture('cancelled');
      const controlGoalMax = vi.fn(async () => cancelled);
      Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt, abort, controlGoalMax } as unknown as PiDesktopApi });
      useGoalMaxStore.setState({ goal: activeGoalFixture() });
      useRuntimeStore.setState({ runtime: ready({ streaming: true }), queue: { steering: 0, followUp: 0, items: [] } });
      render(<Composer onOpenProject={vi.fn()} />);
      const send = screen.getByRole('button', { name: 'Queue follow-up message' });
      fireEvent.pointerDown(send, { button: 0, pointerId: 18, isPrimary: true });
      vi.advanceTimersByTime(2_000);
      fireEvent.pointerUp(send, { button: 0, pointerId: 18, isPrimary: true });
      fireEvent.click(send);
      expect(controlGoalMax).toHaveBeenCalledOnce();
      expect(controlGoalMax).toHaveBeenCalledWith({ action: 'cancel', reason: 'Cancelled from the composer hold control.' });
      expect(abort).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('keeps the hold-to-cancel control available while an active goal is idle and the draft is empty', () => {
    vi.useFakeTimers();
    try {
      const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
      const controlGoalMax = vi.fn(async () => activeGoalFixture('cancelled'));
      Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt, controlGoalMax } as unknown as PiDesktopApi });
      useGoalMaxStore.setState({ goal: activeGoalFixture() });
      useRuntimeStore.setState({ runtime: ready({ streaming: false }), queue: { steering: 0, followUp: 0, items: [] } });
      render(<Composer onOpenProject={vi.fn()} />);
      const send = screen.getByRole('button', { name: 'Goal control; hold to cancel goal' });
      expect(send).toBeEnabled();

      fireEvent.pointerDown(send, { button: 0, pointerId: 19, isPrimary: true });
      vi.advanceTimersByTime(2_000);
      fireEvent.pointerUp(send, { button: 0, pointerId: 19, isPrimary: true });
      fireEvent.click(send);

      expect(controlGoalMax).toHaveBeenCalledOnce();
      expect(prompt).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('cleans streaming arrow holds on cancellation, lost capture, and unmount', () => {
    vi.useFakeTimers();
    try {
      const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
      const abort = vi.fn(async () => ({ aborted: true }));
      Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt, abort } as unknown as PiDesktopApi });
      useRuntimeStore.setState({ runtime: ready({ streaming: true }), queue: { steering: 0, followUp: 0, items: [] } });
      const view = render(<Composer onOpenProject={vi.fn()} />);
      fireEvent.change(screen.getByLabelText('Message Pi'), { target: { value: 'Still here' } });
      const send = screen.getByRole('button', { name: 'Queue follow-up message' });

      fireEvent.pointerDown(send, { button: 0, pointerId: 9, isPrimary: true });
      vi.advanceTimersByTime(900);
      fireEvent.pointerCancel(send, { pointerId: 9 });
      vi.advanceTimersByTime(2_000);
      fireEvent.click(send);
      expect(prompt).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();

      fireEvent.pointerDown(send, { button: 0, pointerId: 10, isPrimary: true });
      fireEvent.lostPointerCapture(send, { pointerId: 10 });
      vi.advanceTimersByTime(2_000);
      expect(abort).not.toHaveBeenCalled();

      fireEvent.pointerDown(send, { button: 0, pointerId: 11, isPrimary: true });
      view.unmount();
      vi.advanceTimersByTime(2_000);
      expect(abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('previews a queued follow-up and converts it to steering in place', async () => {
    const queued = { id: '00000000-0000-4000-8000-000000000001', behavior: 'followUp' as const, text: 'Use the smaller API', createdAt: 1 };
    const steeredState = ready({ streaming: true, queue: { steering: 1, followUp: 0, items: [{ ...queued, behavior: 'steer' }] } });
    const mutateQueuedMessage = vi.fn(async () => ({ state: steeredState }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { mutateQueuedMessage } as unknown as PiDesktopApi });
    useRuntimeStore.setState({ runtime: ready({ streaming: true }), queue: { steering: 0, followUp: 1, items: [queued] } });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    expect(screen.getByText('Use the smaller API')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /More options for queued message/u })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: `Cancel queued message: ${queued.text}` })).toHaveLength(1);
    const mode = screen.getByRole('switch', { name: `Follow-up queued message: ${queued.text}` });
    expect(mode).toHaveTextContent('');
    await user.click(mode);

    expect(mutateQueuedMessage).toHaveBeenCalledWith({ id: queued.id, action: 'steer' });
    const steerMode = await screen.findByRole('switch', { name: `Steer queued message: ${queued.text}` });
    expect(steerMode).toBeEnabled();
    expect(steerMode).toHaveTextContent('');
  });

  it('shows accepted GoalMax updates after the composer draft clears', () => {
    const goal = activeGoalFixture();
    useGoalMaxStore.setState({ goal: {
      ...goal,
      steering: [{ id: 'steering-1', text: 'Also document the recovery path.', behavior: 'followUp', timestamp: 2, revision: 2 }],
    } });
    render(<Composer onOpenProject={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'GoalMax updates' })).toHaveTextContent('Also document the recovery path.');
    expect(screen.getByRole('region', { name: 'GoalMax updates' })).toHaveTextContent('Goal update');
  });

  it('moves a queued message back into the composer for editing', async () => {
    const queued = { id: '00000000-0000-4000-8000-000000000002', behavior: 'followUp' as const, text: 'Fix teh heading', createdAt: 1 };
    const emptyState = ready({ streaming: true, queue: { steering: 0, followUp: 0, items: [] } });
    const mutateQueuedMessage = vi.fn(async () => ({ state: emptyState, restored: { text: queued.text } }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { mutateQueuedMessage } as unknown as PiDesktopApi });
    useRuntimeStore.setState({ runtime: ready({ streaming: true }), queue: { steering: 0, followUp: 1, items: [queued] } });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: `Edit queued message: ${queued.text}` }));

    expect(mutateQueuedMessage).toHaveBeenCalledWith({ id: queued.id, action: 'edit' });
    expect(screen.getByLabelText('Message Pi')).toHaveValue('Fix teh heading');
    await waitFor(() => expect(screen.getByLabelText('Message Pi')).toHaveFocus());
  });

  it('grows and shrinks the message input with content, then scrolls at its cap', async () => {
    render(<div className="welcome"><Composer onOpenProject={vi.fn()} /></div>);
    const input = screen.getByLabelText('Message Pi');
    const form = input.closest('form');
    const shell = input.parentElement;
    let contentHeight = 120;
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => contentHeight });

    fireEvent.change(input, { target: { value: 'one\ntwo\nthree\nfour' } });
    await waitFor(() => expect(form?.style.getPropertyValue('--composer-input-height')).toBe('120px'));

    contentHeight = 2_000;
    fireEvent.change(input, { target: { value: Array.from({ length: 100 }, () => 'line').join('\n') } });
    await waitFor(() => expect(form?.style.getPropertyValue('--composer-input-height')).toBe(`${clampComposerInputHeight(2_000, Math.floor(window.innerHeight * 0.5 - 71))}px`));
    expect(shell).toHaveAttribute('data-overflow-bottom', 'true');

    contentHeight = 20;
    fireEvent.change(input, { target: { value: 'short' } });
    await waitFor(() => expect(form?.style.getPropertyValue('--composer-input-height')).toBe('53px'));
  });

  it('forks from the composer and restores the selected prompt', async () => {
    const state = ready({
      activeSessionRunning: false,
      runningSessionCount: 1,
      sessionCapabilities: { fork: true, clone: true, import: true, compact: true },
      forkPoints: [{ entryId: 'entry-1', text: 'Original direction' }],
    });
    useRuntimeStore.setState({ runtime: state });
    const forkSession = vi.fn(async () => ({ state, selectedText: 'Original direction' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { forkSession } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Create new session from latest prompt' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Create new session from latest prompt' }));
    expect(forkSession).toHaveBeenCalledWith('entry-1');
    expect(screen.getByLabelText('Message Pi')).toHaveValue('Original direction');
    expect(screen.getByLabelText('Message Pi')).toHaveFocus();
    expect(screen.getByText('Fork ready')).toBeInTheDocument();
  });

  it('keeps model and reasoning selectors enabled while streaming and reports staged-next semantics honestly', async () => {
    const current = ready().model!;
    const alternate = { provider: 'test', id: 'fast', name: 'Fast Model', reasoning: false, contextWindow: 200_000, supportsImages: true };
    const state = ready({ streaming: true, model: current, pendingModel: null, models: [current, alternate] });
    const staged = { ...state, model: current, pendingModel: alternate };
    useRuntimeStore.setState({ runtime: state });
    const setModel = vi.fn(async () => staged);
    const setThinkingLevel = vi.fn(async () => ({ ...state, pendingThinkingLevel: 'high' as const }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { setModel, setThinkingLevel } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    const modelButton = screen.getByRole('button', { name: 'Model and reasoning settings' });
    expect(modelButton).toBeVisible();
    expect(modelButton).toBeEnabled();
    await user.click(modelButton);
    expect(screen.getByLabelText('Current model: Model. Next model: Model.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Reasoning level' })).toBeEnabled();
    expect(screen.getByText('Stages for your next user message')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Reasoning level' }));
    await user.click(screen.getByRole('option', { name: 'High' }));
    await waitFor(() => expect(setThinkingLevel).toHaveBeenCalledWith('high'));
    expect(useRuntimeStore.getState().runtime.pendingThinkingLevel).toBe('high');

    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByRole('option', { name: /Fast Model/u }));
    await waitFor(() => expect(setModel).toHaveBeenCalledWith('test', 'fast'));
    expect(useRuntimeStore.getState().runtime.model?.id).toBe('model');
    expect(useRuntimeStore.getState().runtime.pendingModel?.id).toBe('fast');
    expect(modelButton).toHaveTextContent('Fast Model');
    expect(modelButton).not.toHaveTextContent('Next');
    expect(screen.getByLabelText('Current model: Model. Next model: Fast Model.')).toBeInTheDocument();
  });

  it('keeps model and reasoning selection in a compact composer popover', async () => {
    const alternate = { provider: 'test', id: 'fast', name: 'Fast Model', reasoning: true, contextWindow: 100_000, supportsImages: false };
    const state = ready({ models: [ready().model!, alternate] });
    const withModel = { ...state, pendingModel: alternate };
    useRuntimeStore.setState({ runtime: state });
    const setModel = vi.fn(async () => withModel);
    const setThinkingLevel = vi.fn(async () => ({ ...withModel, pendingThinkingLevel: 'high' as const }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { setModel, setThinkingLevel } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Model and reasoning settings' }));
    expect(screen.getByRole('dialog', { name: 'Model settings' })).toBeInTheDocument();
    screen.getByLabelText('Model').focus();
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(setModel).toHaveBeenCalledWith('test', 'fast');
    screen.getByLabelText('Reasoning level').focus();
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(setThinkingLevel).toHaveBeenCalledWith('high');
    expect(screen.queryByText('Ctrl/⌘ ↵')).not.toBeInTheDocument();
  });
});
