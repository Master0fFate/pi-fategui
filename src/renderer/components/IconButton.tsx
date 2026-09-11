import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { AppTooltip } from './AppTooltip';
import { useSkinComponents } from '../skins/SkinProvider';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  terminalLabel?: string;
  children: ReactNode;
}

export function IconButton({ label, terminalLabel, children, className = '', ...props }: IconButtonProps) {
  const { ActionContent } = useSkinComponents();
  return (
    <AppTooltip content={label} wrapTrigger triggerClassName="tooltip-trigger--icon">
      <button className={`icon-button ${className}`} aria-label={label} {...props}>
        <ActionContent text={terminalLabel ?? label}>{children}</ActionContent>
      </button>
    </AppTooltip>
  );
}
