import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi, RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { clampComposerInputHeight, Composer } from './Composer';
import { AssistantMarkdown, ConversationTimeline, MessageRow } from './ConversationTimeline';
import { isSafeMermaidSource } from './RichMessageContent';
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

const reset = () => {
  useRuntimeStore.getState().setRuntime({ ...ready(), sessionId: null });
  useRuntimeStore.getState().setRuntime(ready());
  useUiStore.setState({ sendMessageWithModifier: false });
};

describe('conversation components', () => {
  beforeEach(reset);
  afterEach(() => {
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

  it('does not fetch model-authored remote images without user consent', async () => {
    const user = userEvent.setup();
    render(<AssistantMarkdown text={'![Remote preview](https://images.example.test/preview.png)'} />);
    expect(screen.queryByRole('img', { name: 'Remote preview' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load remote image: Remote preview' }));
    expect(screen.getByRole('img', { name: 'Remote preview' })).toHaveAttribute('referrerpolicy', 'no-referrer');
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

  it('shows actual Pi context usage beside the send action', () => {
    useRuntimeStore.setState({ runtime: ready({ contextUsage: { tokens: 42_000, contextWindow: 100_000, percent: 42 } }) });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {} as PiDesktopApi });
    render(<Composer onOpenProject={vi.fn()} />);
    const meter = screen.getByRole('meter', { name: 'Context usage: 42% of 100k tokens' });
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    expect(meter).not.toHaveTextContent('42');
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
    expect(await screen.findByRole('tooltip')).toHaveTextContent(`Current model: ${fullName}`);
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
    const selectProjectFile = vi.fn(async () => 'README.md');
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { selectProjectFile } as unknown as PiDesktopApi,
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
    expect(within(tools).getByRole('button', { name: 'Add file reference' })).toBeInTheDocument();
    await user.click(within(tools).getByRole('button', { name: 'Add file reference' }));
    expect(selectProjectFile).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Message Pi')).toHaveValue('@README.md');
    expect(screen.queryByRole('dialog', { name: 'Composer tools' })).not.toBeInTheDocument();
  });

  it('offers real slash/file gates and sends with the desktop prompt API', async () => {
    const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
    Object.defineProperty(window, 'piDesktop', {
      configurable: true,
      value: { prompt, abort: vi.fn(), selectProjectFile: vi.fn(async () => 'src/example file.ts') } as unknown as PiDesktopApi,
    });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Attach image' })).toBeDisabled();
    await user.type(screen.getByLabelText('Message Pi'), '/rev');
    expect(screen.getByRole('option', { name: /review/i })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /review/i }));
    expect(screen.getByLabelText('Message Pi')).toHaveValue('/review ');

    await user.click(screen.getByRole('button', { name: 'Add file reference' }));
    expect(screen.getByLabelText('Message Pi')).toHaveValue('/review @"src/example file.ts"');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(prompt).toHaveBeenCalledWith({ text: '/review @"src/example file.ts"', behavior: 'prompt' });
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

  it('renders extension output as a distinct system message', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.completed', messageId: 'system-1', role: 'system', text: '**Parallax** active', timestamp: 1 },
    ]);
    const { container } = render(<MessageRow messageId="system-1" />);
    expect(screen.getByText('System')).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: /^Follow up/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop Pi' }));
    expect(abort).toHaveBeenCalledOnce();
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
    await user.click(screen.getByRole('button', { name: 'Steer' }));

    expect(mutateQueuedMessage).toHaveBeenCalledWith({ id: queued.id, action: 'steer' });
    expect(await screen.findByText('Steering')).toBeInTheDocument();
  });

  it('moves a queued message back into the composer for editing', async () => {
    const queued = { id: '00000000-0000-4000-8000-000000000002', behavior: 'followUp' as const, text: 'Fix teh heading', createdAt: 1 };
    const emptyState = ready({ streaming: true, queue: { steering: 0, followUp: 0, items: [] } });
    const mutateQueuedMessage = vi.fn(async () => ({ state: emptyState, restored: { text: queued.text } }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { mutateQueuedMessage } as unknown as PiDesktopApi });
    useRuntimeStore.setState({ runtime: ready({ streaming: true }), queue: { steering: 0, followUp: 1, items: [queued] } });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /More options for queued message/u }));
    await user.click(screen.getByRole('button', { name: 'Edit message' }));

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
      sessionCapabilities: { fork: true, clone: true, import: true, compact: true },
      forkPoints: [{ entryId: 'entry-1', text: 'Original direction' }],
    });
    useRuntimeStore.setState({ runtime: state });
    const forkSession = vi.fn(async () => ({ state, selectedText: 'Original direction' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { forkSession } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Create new session from latest prompt' }));
    expect(forkSession).toHaveBeenCalledWith('entry-1');
    expect(screen.getByLabelText('Message Pi')).toHaveValue('Original direction');
    expect(screen.getByLabelText('Message Pi')).toHaveFocus();
    expect(screen.getByText('Fork ready')).toBeInTheDocument();
  });

  it('keeps model and reasoning selection in a compact composer popover', async () => {
    const alternate = { provider: 'test', id: 'fast', name: 'Fast Model', reasoning: true, contextWindow: 100_000, supportsImages: false };
    const state = ready({ models: [ready().model!, alternate] });
    const withModel = { ...state, model: alternate };
    useRuntimeStore.setState({ runtime: state });
    const setModel = vi.fn(async () => withModel);
    const setThinkingLevel = vi.fn(async () => ({ ...withModel, thinkingLevel: 'high' as const }));
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
