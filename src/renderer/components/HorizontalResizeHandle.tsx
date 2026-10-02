import { useCallback, useEffect, useRef } from 'react';
import { clampResizeValue, resizeBounds } from './resizeBounds';

interface HorizontalResizeHandleProps {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  direction?: 1 | -1;
  onChange: (value: number) => void;
  onReset: () => void;
}

export function HorizontalResizeHandle({
  label,
  value,
  minimum,
  maximum,
  direction = 1,
  onChange,
  onReset,
}: HorizontalResizeHandleProps) {
  const start = useRef({ y: 0, value: 0 });
  const activePointer = useRef<number>();
  const bounds = resizeBounds(minimum, maximum);
  const boundedValue = clampResizeValue(value, bounds);

  const finish = useCallback(() => {
    activePointer.current = undefined;
    document.body.classList.remove('is-resizing-horizontal-pane');
  }, []);

  useEffect(() => finish, [finish]);

  return (
    <div
      className="horizontal-resize-handle"
      role="separator"
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={bounds.minimum}
      aria-valuemax={bounds.maximum}
      aria-valuenow={clampResizeValue(Math.round(boundedValue), bounds)}
      tabIndex={0}
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        event.preventDefault();
        start.current = { y: event.clientY, value: boundedValue };
        activePointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing-horizontal-pane');
      }}
      onPointerMove={(event) => {
        if (activePointer.current !== event.pointerId) return;
        onChange(clampResizeValue(start.current.value + (event.clientY - start.current.y) * direction, bounds));
      }}
      onPointerUp={(event) => {
        if (activePointer.current !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        finish();
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 16 : -16;
        onChange(clampResizeValue(boundedValue + delta * direction, bounds));
      }}
    />
  );
}
