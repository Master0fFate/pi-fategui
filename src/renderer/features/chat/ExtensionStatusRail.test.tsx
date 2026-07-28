import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeState } from '../../../shared/contracts/ipc';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { ExtensionStatusRail } from './ExtensionStatusRail';

const ready = (extensionUi?: RuntimeState['extensionUi']): RuntimeState => ({
  status: 'ready',
  project: { path: '/project', name: 'project', trusted: true },
  sessionId: 's1',
  sessionFile: null,
  streaming: false,
  model: null,
  models: [],
  thinkingLevel: 'medium',
  messages: [],
  commands: [],
  ...(extensionUi ? { extensionUi } : {}),
  error: null,
});

describe('ExtensionStatusRail', () => {
  beforeEach(() => useRuntimeStore.getState().setRuntime(ready()));

  it('occupies no output when extension UI state is empty', () => {
    const { container, rerender } = render(<ExtensionStatusRail />);
    expect(container).toBeEmptyDOMElement();

    useRuntimeStore.getState().setRuntime(ready({ statuses: [], widgets: [], working: null, title: null }));
    rerender(<ExtensionStatusRail />);
    expect(container).toBeEmptyDOMElement();

    useRuntimeStore.getState().setRuntime(ready({
      statuses: [{ key: 'empty', text: '   ' }],
      widgets: [{ key: 'empty-widget', lines: [''] }],
      working: null,
      title: '  ',
    }));
    rerender(<ExtensionStatusRail />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a single compact status without a details affordance', () => {
    useRuntimeStore.getState().setRuntime(ready({
      statuses: [{ key: 'review', text: 'Review ready' }],
      widgets: [],
      working: null,
      title: null,
    }));
    render(<ExtensionStatusRail />);

    expect(screen.getByRole('status', { name: 'Pi extension status' })).toHaveTextContent('Review ready');
    expect(screen.queryByRole('button', { name: /extension details/u })).not.toBeInTheDocument();
  });

  it('prioritizes working text and exposes keyed, multiline provenance in bounded details', async () => {
    useRuntimeStore.getState().setRuntime(ready({
      title: 'Parallax',
      working: 'Coordinating workers',
      statuses: [
        { key: 'worker-1', text: 'Implementation complete' },
        { key: 'worker-2', text: 'Tests running' },
      ],
      widgets: [{ key: 'checks', lines: ['Typecheck pending', 'Vitest passed'] }],
    }));
    const user = userEvent.setup();
    render(<ExtensionStatusRail />);

    const rail = screen.getByRole('status', { name: 'Pi extension status' });
    expect(within(rail).getByText('Coordinating workers')).toBeInTheDocument();
    await user.click(within(rail).getByRole('button', { name: 'Show 6 extension details' }));

    const details = screen.getByRole('dialog', { name: 'Extension details' });
    expect(details).toHaveTextContent('TitleParallax');
    expect(details).toHaveTextContent('Status · worker-2Tests running');
    expect(details).toHaveTextContent('Widget · checksTypecheck pending Vitest passed');
    expect([...details.querySelectorAll('dd')].some((item) => item.textContent === 'Typecheck pending\nVitest passed')).toBe(true);
  });
});
