import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}

interface SelectControlProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly disabled?: boolean;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly onValueChange: (value: string) => void;
}

export function SelectControl({ label, value, options, disabled = false, className = '', contentClassName = '', onValueChange }: SelectControlProps) {
  return (
    <Select.Root value={value} disabled={disabled} onValueChange={onValueChange}>
      <Select.Trigger className={`custom-select-trigger ${className}`.trim()} aria-label={label}>
        <Select.Value />
        <Select.Icon className="custom-select-chevron"><ChevronDown size={13} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className={`custom-select-content ${contentClassName}`.trim()} position="popper" align="end" sideOffset={6} collisionPadding={12}>
          <Select.Viewport className="custom-select-viewport">
            {options.map((option) => (
              <Select.Item className="custom-select-item" key={option.value} value={option.value}>
                <Select.ItemIndicator className="custom-select-indicator"><Check size={13} /></Select.ItemIndicator>
                <span className="custom-select-copy">
                  <Select.ItemText>{option.label}</Select.ItemText>
                  {option.detail && <small>{option.detail}</small>}
                </span>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
