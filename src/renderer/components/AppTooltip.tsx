import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { FocusEvent, ReactElement, ReactNode } from 'react';

type TooltipSide = 'top' | 'right' | 'bottom' | 'left';
type TooltipAlign = 'start' | 'center' | 'end';

interface AppTooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: TooltipSide;
  align?: TooltipAlign;
  sideOffset?: number;
  delayDuration?: number;
  wrapTrigger?: boolean;
  triggerClassName?: string;
}

/** Focus opens a tooltip for keyboard users only. A programmatic focus return
 * (a dialog closed by pointer restores its opener) must not raise a tooltip
 * over neighboring controls, where it would intercept the next click. */
function openOnKeyboardFocusOnly(event: FocusEvent<HTMLElement>): void {
  let keyboard = true;
  // With wrapTrigger the handler sits on a wrapper span. Only the element that
  // really took focus can match :focus-visible, never that wrapper.
  const focused = event.target instanceof Element ? event.target : event.currentTarget;
  try { keyboard = focused.matches(':focus-visible'); }
  catch { /* An engine without the selector keeps the focus-open behavior. */ }
  // Radix skips its own focus handler for a default-prevented event.
  if (!keyboard) event.preventDefault();
}

export function AppTooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  sideOffset = 8,
  delayDuration,
  wrapTrigger = false,
  triggerClassName = '',
}: AppTooltipProps) {
  if (content === null || content === undefined || content === false || content === '') return children;

  const trigger = wrapTrigger
    ? <span className={`tooltip-trigger ${triggerClassName}`.trim()}>{children}</span>
    : children;

  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration ?? 350} skipDelayDuration={150} disableHoverableContent={false}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild onFocus={openOnKeyboardFocusOnly}>{trigger}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className="tooltip"
            side={side}
            align={align}
            sideOffset={sideOffset}
            collisionPadding={12}
            avoidCollisions
            sticky="always"
          >
            <span className="tooltip-content">{content}</span>
            <TooltipPrimitive.Arrow className="tooltip-arrow" width={10} height={5} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
