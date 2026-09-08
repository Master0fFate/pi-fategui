import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { ResourcesPanel } from './ResourcesPanel';

const initialState = useRuntimeStore.getInitialState();
afterEach(() => useRuntimeStore.setState(initialState, true));

it('renders before skills are hydrated and updates when discovery completes', () => {
  useRuntimeStore.setState(initialState, true);
  expect(initialState.runtime.skills).toBeUndefined();
  render(<ResourcesPanel />);
  expect(screen.getByText('No Pi resources loaded')).toBeInTheDocument();

  act(() => useRuntimeStore.setState((state) => ({
    runtime: { ...state.runtime, skills: [{ name: 'review', description: 'Review changes' }] },
  })));
  expect(screen.getByText('Review changes')).toBeInTheDocument();
  expect(screen.queryByText('No Pi resources loaded')).not.toBeInTheDocument();
});
