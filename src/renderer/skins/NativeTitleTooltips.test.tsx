import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { applySkin, setSkinDefinitions } from '../skin';
import { builtInSkins } from '../../shared/skins';
import { NativeTitleTooltips } from './NativeTitleTooltips';

afterEach(() => { cleanup(); setSkinDefinitions(builtInSkins); applySkin('default'); });
it('themes native titles without changing controls, and restores them when leaving or switching skins', () => {
  applySkin('dreamcore');
  render(<><button title="Full explanation" aria-label="Action">Action</button><NativeTitleTooltips /></>);
  const button = screen.getByRole('button', { name: 'Action' });
  fireEvent.mouseOver(button);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Full explanation');
  expect(button).not.toHaveAttribute('title');
  expect(button).toHaveAttribute('aria-describedby', 'skin-native-title-tooltip');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(button).toHaveAttribute('title', 'Full explanation');
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.focusIn(button);
  expect(screen.getByRole('tooltip')).toBeInTheDocument();
  act(() => { applySkin('default'); });
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  expect(button).toHaveAttribute('title', 'Full explanation');
});
