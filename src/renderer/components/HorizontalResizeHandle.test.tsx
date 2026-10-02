import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HorizontalResizeHandle } from './HorizontalResizeHandle';
import { clampResizeValue, resizeBounds } from './resizeBounds';

function pointer(handle: HTMLElement, type: string, y: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  fireEvent(handle, event);
}

function Fixture({ minimum = 100, maximum = 300, initial = 240, direction = 1 }: {
  minimum?: number; maximum?: number; initial?: number; direction?: 1 | -1;
}) {
  const [value, setValue] = useState(initial);
  return <><output>{value}</output><HorizontalResizeHandle label="Resize fixture" minimum={minimum} maximum={maximum}
    value={value} direction={direction} onChange={setValue} onReset={() => setValue(240)} /></>;
}

describe('horizontal splitter presentation', () => {
  it.each([
    [NaN, 300, 0, 300], [Infinity, 300, 0, 300], [-Infinity, 300, 0, 300],
    [100, NaN, 100, 100], [100, Infinity, 100, 100], [100, -Infinity, 100, 100],
    [-100, -30, 0, 0], [100, 30, 100, 100],
  ])('keeps bounds finite and ordered for (%s, %s)', (minimum, maximum, expectedMinimum, expectedMaximum) => {
    const bounds = resizeBounds(minimum!, maximum!);
    expect(bounds).toEqual({ minimum: expectedMinimum, maximum: expectedMaximum });
    expect(clampResizeValue(NaN, bounds)).toBe(expectedMinimum);
    expect(clampResizeValue(-Infinity, bounds)).toBe(expectedMinimum);
    expect(clampResizeValue(Infinity, bounds)).toBe(expectedMaximum);
  });

  it.each([NaN, Infinity, -Infinity])('announces a finite value and emits finite changes for %s', (value) => {
    const onChange = vi.fn();
    render(<HorizontalResizeHandle label="Resize fixture" minimum={100} maximum={300} value={value} onChange={onChange} onReset={vi.fn()} />);
    const handle = screen.getByRole('separator');
    expect(Number(handle.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(100);
    expect(Number(handle.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(300);
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(Number.isFinite(onChange.mock.lastCall?.[0])).toBe(true);
  });

  it.each([1, -1] as const)('clamps keyboard and pointer output for direction %i', (direction) => {
    const { container } = render(<Fixture direction={direction} />);
    const handle = screen.getByRole('separator');
    for (let index = 0; index < 20; index++) fireEvent.keyDown(handle, { key: direction === 1 ? 'ArrowDown' : 'ArrowUp' });
    expect(container.querySelector('output')).toHaveTextContent('300');
    expect(handle).toHaveAttribute('aria-valuenow', '300');
    pointer(handle, 'pointerdown', 200);
    pointer(handle, 'pointermove', 200 - 1000 * direction);
    expect(container.querySelector('output')).toHaveTextContent('100');
    pointer(handle, 'pointermove', 200 + 1000 * direction);
    expect(container.querySelector('output')).toHaveTextContent('300');
    pointer(handle, 'pointerup', 200);
    expect(document.body).not.toHaveClass('is-resizing-horizontal-pane');
  });

  it('normalizes an inverted range and bounds the announced value and emitted changes', () => {
    const onChange = vi.fn();
    render(<HorizontalResizeHandle label="Resize fixture" minimum={100} maximum={30} value={240} onChange={onChange} onReset={vi.fn()} />);
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-valuemin', '100');
    expect(handle).toHaveAttribute('aria-valuemax', '100');
    expect(handle).toHaveAttribute('aria-valuenow', '100');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(100);
  });

  it('keeps fractional bounds from being exceeded by rounded ARIA values', () => {
    render(<Fixture minimum={100.6} maximum={300.6} initial={300.6} />);
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-valuenow', '300.6');
    expect(handle).toHaveAttribute('aria-valuemax', '300.6');
  });

  it('preserves the sub-agent preview direction, 16px step and 260px starting size', () => {
    render(<Fixture minimum={140} maximum={720} initial={260} direction={-1} />);
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-valuenow', '260');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(handle).toHaveAttribute('aria-valuenow', '276');
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(handle).toHaveAttribute('aria-valuenow', '260');
    pointer(handle, 'pointerdown', 200);
    pointer(handle, 'pointermove', 150);
    expect(handle).toHaveAttribute('aria-valuenow', '310');
    pointer(handle, 'pointerup', 150);
  });

  it('ignores other pointers and stops dragging after cancellation, lost capture or unmount', () => {
    const onChange = vi.fn();
    const view = render(<HorizontalResizeHandle label="Resize fixture" minimum={100} maximum={300} value={240} onChange={onChange} onReset={vi.fn()} />);
    const handle = screen.getByRole('separator');
    pointer(handle, 'pointerdown', 200);
    pointer(handle, 'pointermove', 250, 2);
    expect(onChange).not.toHaveBeenCalled();
    pointer(handle, 'pointercancel', 200);
    pointer(handle, 'pointermove', 250);
    expect(onChange).not.toHaveBeenCalled();
    expect(document.body).not.toHaveClass('is-resizing-horizontal-pane');
    pointer(handle, 'pointerdown', 200);
    fireEvent.lostPointerCapture(handle);
    pointer(handle, 'pointermove', 250);
    expect(onChange).not.toHaveBeenCalled();
    pointer(handle, 'pointerdown', 200);
    expect(document.body).toHaveClass('is-resizing-horizontal-pane');
    view.unmount();
    expect(document.body).not.toHaveClass('is-resizing-horizontal-pane');
  });
});
