import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { WorkspaceActivityPulse } from './WorkspaceActivityPulse';

const ready = (overrides: Partial<RuntimeState> = {}): RuntimeState => ({
  status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 'session-1', sessionFile: null,
  streaming: false, model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null, ...overrides,
});

const git = {
  repository: true, branch: 'main', upstream: 'origin/main', pushTarget: 'origin/main', ahead: 0, behind: 0,
  changes: [{ path: 'src/app.ts', indexStatus: ' ', workTreeStatus: 'M', additions: 1, deletions: 0, binary: false }],
  additions: 1, deletions: 0, truncated: false,
};

describe('WorkspaceActivityPulse', () => {
  beforeEach(() => {
    useRuntimeStore.getState().hydrateRuntime(ready());
    useWorkspaceStore.setState({ projectPath: '/project', git, gitLoading: false });
  });

  it('treats an active background session as work and keeps dirty Git evidence neutral', () => {
    act(() => useRuntimeStore.getState().hydrateRuntime(ready({ activeSessionRunning: true })));
    const { rerender } = render(<WorkspaceActivityPulse />);
    expect(screen.getByLabelText(/Activity: Thinking/u)).toHaveTextContent('1 changed');

    act(() => useRuntimeStore.getState().hydrateRuntime(ready()));
    rerender(<WorkspaceActivityPulse />);
    expect(screen.getByLabelText(/Activity: Ready/u)).toHaveTextContent('1 changed');
    expect(screen.queryByText(/Completed with changes/u)).not.toBeInTheDocument();
  });

  it('names a validated running file edit and reports unavailable context honestly', () => {
    act(() => useRuntimeStore.getState().hydrateRuntime(ready({
      tools: [{
        id: 'edit-1', name: 'edit', input: '{}', output: '', outputTruncated: false, status: 'running', startedAt: 1, updatedAt: 1,
        provenance: { actor: { kind: 'root' }, affectedPaths: [{ path: 'src/app.ts', operation: 'edit' }] },
      }],
    })));
    render(<WorkspaceActivityPulse />);
    expect(screen.getByText('Editing src/app.ts')).toBeVisible();
    expect(screen.getByText('Context unavailable')).toBeVisible();
  });
});
