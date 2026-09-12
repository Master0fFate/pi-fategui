import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { ConversationTimeline } from './ConversationTimeline';

const virtuosoMock = vi.hoisted(() => ({ renders: 0 }));

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  type MockHandle = { autoscrollToBottom: () => void; scrollToIndex: () => void };
  type MockProps = { data?: readonly unknown[] };
  const Virtuoso = React.forwardRef<MockHandle, MockProps>(({ data }, ref) => {
    virtuosoMock.renders += 1;
    React.useImperativeHandle(ref, () => ({
      autoscrollToBottom: () => undefined,
      scrollToIndex: () => undefined,
    }), []);
    return <div data-testid="virtuoso" data-count={data?.length ?? 0} />;
  });
  return { Virtuoso };
});

const ready = (messages: RuntimeState['messages'] = []): RuntimeState => ({
  status: 'ready',
  project: { path: '/project', name: 'project', trusted: true },
  sessionId: 'memo-session',
  sessionFile: null,
  streaming: false,
  model: null,
  models: [],
  thinkingLevel: 'medium',
  permissionLevel: 'edit',
  messages,
  commands: [],
  error: null,
});

function Parent() {
  const [unrelated, setUnrelated] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setUnrelated((value) => value + 1)}>parent {unrelated}</button>
      <ConversationTimeline />
    </>
  );
}

describe('ConversationTimeline memoization', () => {
  beforeEach(() => {
    virtuosoMock.renders = 0;
    useRuntimeStore.getState().setRuntime({ ...ready(), sessionId: null });
    useRuntimeStore.getState().setRuntime(ready());
    useUiStore.setState({ flightDeckJump: null, toast: null });
  });

  it('skips unrelated parent renders but still renders timeline structural changes', async () => {
    const user = userEvent.setup();
    render(<Parent />);
    const initialRenders = virtuosoMock.renders;

    await user.click(screen.getByRole('button', { name: 'parent 0' }));
    expect(screen.getByRole('button', { name: 'parent 1' })).toBeInTheDocument();
    expect(virtuosoMock.renders).toBe(initialRenders);

    act(() => {
      useRuntimeStore.getState().hydrateRuntime(ready([
        { id: 'message-1', role: 'user', text: 'Structural update', timestamp: 1 },
      ]));
    });

    expect(screen.getByTestId('virtuoso')).toHaveAttribute('data-count', '1');
    expect(virtuosoMock.renders).toBeGreaterThan(initialRenders);
  });
});
