import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { applySkin } from '../skin';
import { IconButton } from '../components/IconButton';
import { SkinProvider, useSkinComponents } from './SkinProvider';

function Fixture() {
  const { PromptHeading, PromptPrefix, ContextGauge } = useSkinComponents();
  const [text, setText] = useState('draft');
  const [count, setCount] = useState(0);
  return <><PromptHeading target="Pi" hint="Enter to send" /><label>Prompt<PromptPrefix /><textarea value={text} onChange={(event) => setText(event.target.value)} /></label><IconButton label="Open terminal" terminalLabel="term" onClick={() => setCount(count + 1)}><svg data-testid="default-icon" /></IconButton><output>{count}</output><ContextGauge percent={42} estimated={false}><svg data-testid="default-gauge" /></ContextGauge></>;
}

afterEach(() => { cleanup(); delete document.documentElement.dataset.skin; localStorage.clear(); });
describe('skin component presentation', () => {
  it('changes component content without replacing input nodes or feature state', () => {
    applySkin('default');
    render(<SkinProvider><Fixture /></SkinProvider>);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'keep my draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(screen.getByTestId('default-icon')).toBeInTheDocument();
    act(() => { applySkin('dreamcore'); });
    expect(screen.queryByTestId('default-icon')).not.toBeInTheDocument();
    expect(screen.queryByTestId('default-gauge')).not.toBeInTheDocument();
    expect(screen.getByText('ctx 42%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open terminal' })).toHaveTextContent('[term]');
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).toHaveValue('keep my draft');
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(screen.getByRole('status')).toHaveTextContent('2');
    act(() => { applySkin('default'); });
    expect(screen.getByTestId('default-icon')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).toHaveValue('keep my draft');
  });
});
