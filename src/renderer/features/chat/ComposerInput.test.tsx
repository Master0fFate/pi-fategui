import { createRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerPresentation, type ComposerSubmitKey } from './ComposerInput';

function Entry({ source, action, disabled = false, submitKey = 'enter', intercept = false }: {
  source: 'desktop' | 'network'; action: () => void; disabled?: boolean; submitKey?: ComposerSubmitKey; intercept?: boolean;
}) {
  const [value, setValue] = useState('');
  return <ComposerPresentation source={source} input={{ 'aria-label': 'Shared message', value,
    onChange: (event) => setValue(event.target.value),
    onKeyDown: (event) => { if (intercept && event.key === 'Enter') event.preventDefault(); } }}
    action={{ label: 'Shared send', content: 'send', disabled }} onAction={action} submitKey={submitKey}>
    {({ input, sendAction }) => <>
      {source === 'desktop' ? <button type="button">Native attachment control</button>
        : <p>Native attachments and voice unavailable on this connection.</p>}
      {input}<div className="composer-toolbar">{sendAction}</div>
    </>}
  </ComposerPresentation>;
}

describe('actual shared Composer entry/action presentation', () => {
  it.each(['desktop', 'network'] as const)('uses one controlled entry and submit behavior for %s', (source) => {
    const action = vi.fn(); render(<Entry source={source} action={action} />);
    const input = screen.getByRole('textbox', { name: 'Shared message' });
    const send = screen.getByRole('button', { name: 'Shared send' });
    expect(input).toHaveAttribute('data-composer-entry', source);
    expect(input.closest('form')).toHaveAttribute('data-composer-source', source);
    expect(send).toHaveAttribute('data-composer-action', source);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    fireEvent.change(input, { target: { value: 'Shared draft' } });
    expect(input).toHaveValue('Shared draft');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(action).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(action).toHaveBeenCalledTimes(1);
    fireEvent.click(send); expect(action).toHaveBeenCalledTimes(2);
    if (source === 'network') expect(screen.queryByRole('button', { name: 'Native attachment control' })).not.toBeInTheDocument();
  });

  it('preserves modifier preference, source suggestion interception, IME composition and disabled actions', () => {
    const action = vi.fn();
    const view = render(<Entry source="desktop" action={action} submitKey="modifier-enter" />);
    let input = screen.getByRole('textbox', { name: 'Shared message' });
    fireEvent.keyDown(input, { key: 'Enter' }); expect(action).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }); expect(action).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true }); expect(action).toHaveBeenCalledTimes(1);
    view.rerender(<Entry source="desktop" action={action} intercept />);
    input = screen.getByRole('textbox', { name: 'Shared message' });
    fireEvent.keyDown(input, { key: 'Enter' }); expect(action).toHaveBeenCalledTimes(1);
    view.rerender(<Entry source="network" action={action} disabled />);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Shared send' }));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('keeps real DOM refs and desktop keyboard versus stop-click action mapping', () => {
    const formRef = createRef<HTMLFormElement>();
    const inputRef = createRef<HTMLTextAreaElement>();
    const shellRef = createRef<HTMLDivElement>();
    const stop = vi.fn(); const queue = vi.fn();
    render(<ComposerPresentation source="desktop" formRef={formRef} inputRef={inputRef} inputShellRef={shellRef}
      input={{ 'aria-label': 'Shared message', value: 'draft', onChange: vi.fn(), onSelect: vi.fn(), onScroll: vi.fn(), onPaste: vi.fn() }}
      action={{ label: 'Stop Pi', content: 'stop', disabled: false, attributes: { 'data-mode': 'stop' } }}
      submitKey="enter" onAction={stop} onKeyboardAction={queue}>
      {({ input, sendAction }) => <>{input}{sendAction}</>}
    </ComposerPresentation>);
    expect(formRef.current).toBe(inputRef.current?.closest('form'));
    expect(shellRef.current).toContainElement(inputRef.current);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Shared message' }), { key: 'Enter' });
    expect(queue).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Pi' }));
    expect(stop).toHaveBeenCalledTimes(1); expect(queue).toHaveBeenCalledTimes(1);
  });
});
