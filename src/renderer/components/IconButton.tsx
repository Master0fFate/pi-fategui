import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { AppTooltip } from './AppTooltip';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, children, className = '', ...props }: IconButtonProps) {
  return (
    <AppTooltip content={label} wrapTrigger triggerClassName="tooltip-trigger--icon">
      <button className={`icon-button ${className}`} aria-label={label} {...props}>
        {children}
      </button>
    </AppTooltip>
  );
}
