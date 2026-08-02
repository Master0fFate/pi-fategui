import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { FlightRecorder } from './FlightRecorder';

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  return {
    Virtuoso: ({ data = [], itemContent }: { data?: readonly unknown[]; itemContent: (index: number, item: unknown) => React.ReactNode }) => (
      <div>{data.map((item, index) => <div key={index}>{itemContent(index, item)}</div>)}</div>
    ),
  };
});

const ready: RuntimeState = {
  status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 'session-1', sessionFile: null,
  streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
};

describe('FlightRecorder', () => {
  beforeEach(() => {
    useRuntimeStore.getState().hydrateRuntime(ready);
    useWorkspaceStore.setState({ projectPath: '/project', git: null });
    useUiStore.setState({ flightDeckJump: null, inspectorTab: 'sessions', inspectorCollapsed: false });
  });

  it('renders jumps only for retained targets and uses categorical error copy', () => {
    useRuntimeStore.getState().applyEvents([
      { type: 'message.completed', messageId: 'kept', role: 'assistant', text: 'Retained answer', timestamp: 1 },
      { type: 'error', error: { code: 'UNKNOWN', message: 'private-runtime-detail', retryable: false }, timestamp: 2 },
    ]);
    const state = useRuntimeStore.getState();
    useRuntimeStore.setState({
      timelineOrder: [...state.timelineOrder, 'message:missing'],
      timelineById: {
        ...state.timelineById,
        'message:missing': { id: 'message:missing', kind: 'message', messageId: 'missing', timestamp: 3 },
      },
    });

    render(<FlightRecorder />);
    expect(screen.getByRole('region', { name: 'Flight Recorder' })).toBeVisible();
    expect(screen.getAllByText('Not retained')).toHaveLength(1);
    expect(screen.queryByText('private-runtime-detail')).not.toBeInTheDocument();
    expect(screen.getByText('Runtime error retained')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Open Assistant message' }));
    expect(useUiStore.getState().flightDeckJump?.target).toEqual({ kind: 'message', messageId: 'kept' });
  });

  it('wraps bounded recorder copy in a dedicated description element', () => {
    const boundedEntries = Array.from({ length: 257 }, (_value, index) => ({
      id: `compaction:${index}`,
      kind: 'compaction' as const,
      phase: 'completed' as const,
      timestamp: index,
    }));
    useRuntimeStore.setState({
      timelineOrder: boundedEntries.map((entry) => entry.id),
      timelineById: Object.fromEntries(boundedEntries.map((entry) => [entry.id, entry])),
    });

    render(<FlightRecorder />);
    const description = screen.getByText('Older recorder activity is bounded');
    expect(description).toHaveClass('recorder-boundary-copy');
    expect(description.parentElement).toHaveClass('recorder-boundary');
  });
});
