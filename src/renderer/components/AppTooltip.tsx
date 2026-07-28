import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';

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
        <TooltipPrimitive.Trigger asChild>{trigger}</TooltipPrimitive.Trigger>
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
