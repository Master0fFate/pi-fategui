import { useCallback, useEffect, useRef } from 'react';

interface ResizeHandleProps {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  direction: 1 | -1;
  onChange: (value: number) => void;
  onReset: () => void;
}

export function ResizeHandle({
  label,
  value,
  minimum,
  maximum,
  direction,
  onChange,
  onReset,
}: ResizeHandleProps) {
  const start = useRef({ x: 0, value: 0 });
  const activePointer = useRef<number>();

  const finishResize = useCallback(() => {
    activePointer.current = undefined;
    document.body.classList.remove('is-resizing');
  }, []);

  useEffect(() => finishResize, [finishResize]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      start.current = { x: event.clientX, value };
      activePointer.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add('is-resizing');
    },
    [value],
  );

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onDoubleClick={onReset}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (activePointer.current !== event.pointerId) return;
        onChange(start.current.value + (event.clientX - start.current.x) * direction);
      }}
      onPointerUp={(event) => {
        if (activePointer.current !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        finishResize();
      }}
      onPointerCancel={finishResize}
      onLostPointerCapture={finishResize}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 12 : -12;
        onChange(value + delta * direction);
      }}
    />
  );
}
