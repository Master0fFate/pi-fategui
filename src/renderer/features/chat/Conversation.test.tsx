import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi, RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { Composer } from './Composer';
import { ConversationTimeline } from './ConversationTimeline';

const ready = (overrides: Partial<RuntimeState> = {}): RuntimeState => ({
  status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
  streaming: false,
  model: { provider: 'test', id: 'model', name: 'Model', reasoning: true, contextWindow: 100_000, supportsImages: false },
  models: [], thinkingLevel: 'medium', messages: [], commands: [{ name: 'review', description: 'Review current changes' }], error: null,
  ...overrides,
});

const reset = () => useRuntimeStore.getState().setRuntime(ready());

describe('conversation components', () => {
  beforeEach(reset);
  afterEach(() => { Reflect.deleteProperty(window, 'piDesktop'); });

  it('keeps 5,000 timeline entries behind a virtualized viewport', () => {
    useRuntimeStore.getState().applyEvents(Array.from({ length: 5_000 }, (_value, index) => ({
      type: 'message.started' as const, messageId: `m${index}`, role: 'assistant' as const, timestamp: index,
    })));
    const { container } = render(<div style={{ height: 600 }}><ConversationTimeline /></div>);
    expect(screen.getByLabelText('Conversation timeline')).toHaveAttribute('data-entry-count', '5000');
    expect(container.querySelectorAll('.timeline-row').length).toBeLessThan(5_000);
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
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(prompt).toHaveBeenCalledWith({ text: '/review @"src/example file.ts"', behavior: 'prompt' });
  });

  it('shows stop, steer and follow-up only for an active Pi run', async () => {
    const prompt = vi.fn(async () => ({ accepted: true, runId: 'run-1' }));
    const abort = vi.fn(async () => ({ aborted: true }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt, abort } as unknown as PiDesktopApi });
    useRuntimeStore.setState({ runtime: ready({ streaming: true }), queue: { steering: 1, followUp: 2 } });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);

    await user.type(screen.getByLabelText('Message Pi'), 'change direction');
    expect(screen.getByRole('button', { name: 'Steer (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Follow up (2)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Steer (1)' }));
    expect(prompt).toHaveBeenCalledWith({ text: 'change direction', behavior: 'steer' });
    await user.click(screen.getByRole('button', { name: 'Stop Pi' }));
    expect(abort).toHaveBeenCalledOnce();
  });
});
