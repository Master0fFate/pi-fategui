import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { ConversationTimeline } from './ConversationTimeline';

// JSDOM has no layout measurements. Render a two-row virtual window and let
// the test move it: changing a DOM node is not enough to expand offscreen rows.
vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  type Props = { data: string[]; itemContent: (index: number, id: string) => ReactNode };
  const Virtuoso = React.forwardRef<{ scrollToIndex: () => void }, Props>(({ data, itemContent }, ref) => {
    const [start, setStart] = useState(0);
    React.useImperativeHandle(ref, () => ({ scrollToIndex: () => undefined }), []);
    return <div>
      <button type="button" onClick={() => setStart((index) => index === 0 ? 2 : 0)}>Move virtual window</button>
      {data.slice(start, start + 2).map((id, offset) => <div key={id}>{itemContent(start + offset, id)}</div>)}
    </div>;
  });
  return { Virtuoso };
});

const ready = (sessionId = 's1'): RuntimeState => ({
  status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId, sessionFile: null,
  streaming: false, model: null, models: [], thinkingLevel: 'medium', permissionLevel: 'edit',
  messages: [], commands: [], error: null,
});

const seedDetails = (suffix = '') => useRuntimeStore.getState().applyEvents([
  { type: 'message.started' as const, messageId: `thinking-1${suffix}`, role: 'assistant' as const, timestamp: 1 },
  { type: 'assistant.reasoning' as const, messageId: `thinking-1${suffix}`, delta: 'First thought', timestamp: 2 },
  { type: 'tool.started' as const, toolCallId: `read-1${suffix}`, name: 'read', input: '{"path":"one"}', timestamp: 3 },
  { type: 'tool.completed' as const, toolCallId: `read-1${suffix}`, name: 'read', output: 'First output', error: false, timestamp: 4 },
  { type: 'message.started' as const, messageId: `thinking-2${suffix}`, role: 'assistant' as const, timestamp: 5 },
  { type: 'assistant.reasoning' as const, messageId: `thinking-2${suffix}`, delta: 'Second thought', timestamp: 6 },
  { type: 'tool.started' as const, toolCallId: `read-2${suffix}`, name: 'read', input: '{"path":"two"}', timestamp: 7 },
  { type: 'tool.completed' as const, toolCallId: `read-2${suffix}`, name: 'read', output: 'Second output', error: false, timestamp: 8 },
]);

describe('conversation-wide detail expansion', () => {
  beforeEach(() => {
    useRuntimeStore.getState().setRuntime({ ...ready(), sessionId: null });
    useRuntimeStore.getState().setRuntime(ready());
  });

  it('applies to reasoning and tools even after virtual rows unmount, and resets on session switch', async () => {
    const user = userEvent.setup();
    seedDetails();
    const { container } = render(<ConversationTimeline />);
    const reasoning = () => container.querySelector<HTMLDetailsElement>('.reasoning-row');
    const tool = () => container.querySelector<HTMLButtonElement>('.tool-card-header');
    expect(reasoning()?.open).toBe(false);
    expect(tool()).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: 'Expand all reasoning and tools' }));
    expect(reasoning()?.open).toBe(true);
    expect(tool()).toHaveAttribute('aria-expanded', 'true');
    await user.click(reasoning()!.querySelector('summary')!);
    await user.click(tool()!);
    expect(reasoning()?.open).toBe(false);
    expect(tool()).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: 'Move virtual window' }));
    expect(reasoning()?.open).toBe(true);
    expect(tool()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Second output')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse all reasoning and tools' }));
    expect(reasoning()?.open).toBe(false);
    expect(tool()).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByRole('button', { name: 'Move virtual window' }));
    expect(reasoning()?.open).toBe(false);
    expect(tool()).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: 'Expand all reasoning and tools' }));
    act(() => { useRuntimeStore.getState().setRuntime(ready('s2')); seedDetails('-new'); });
    expect(screen.getByRole('button', { name: 'Expand all reasoning and tools' })).toBeInTheDocument();
    expect(reasoning()?.open).toBe(false);
    expect(tool()).toHaveAttribute('aria-expanded', 'false');
  });
});
