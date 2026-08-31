import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

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
  readonly compact?: boolean;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  /** Which side of the trigger the dropdown opens on. Defaults to 'bottom' (Radix default). */
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  /** Render a filter input at the top of the dropdown that narrows options by label, detail, or value. */
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly searchLabel?: string;
  readonly onValueChange: (value: string) => void;
}

function matchesQuery(option: SelectOption, query: string): boolean {
  return `${option.label} ${option.detail ?? ''} ${option.value}`.toLowerCase().includes(query);
}

export function SelectControl({
  label,
  value,
  options,
  disabled = false,
  className = '',
  contentClassName = '',
  compact = false,
  placeholder,
  autoFocus = false,
  side = 'bottom',
  searchable = false,
  searchPlaceholder = 'Filter options',
  searchLabel = 'Filter options',
  onValueChange,
}: SelectControlProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const listEngagedRef = useRef(false);
  const normalizedQuery = query.trim().toLowerCase();

  const filteredMatches = useMemo(() => {
    if (!searchable || !normalizedQuery) return options;
    return options.filter((option) => matchesQuery(option, normalizedQuery));
  }, [searchable, normalizedQuery, options]);

  const visibleOptions = useMemo(() => {
    if (!searchable || !normalizedQuery) return options;
    const selected = options.find((option) => option.value === value);
    if (selected && !filteredMatches.some((option) => option.value === selected.value)) {
      // Keep the current selection pinned at the top while it does not match the query.
      // Keeping it mounted also prevents Radix from re-focusing options mid-typing.
      return [selected, ...filteredMatches];
    }
    return filteredMatches;
  }, [searchable, normalizedQuery, options, value, filteredMatches]);

  const optionNodes = () =>
    viewportRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? ([] as unknown as NodeListOf<HTMLElement>);

  // Move focus to the option at a relative offset from the current selection
  // (mirrors native select navigation: ArrowDown lands on the next option).
  const focusRelativeOption = (offset: number) => {
    const nodes = Array.from(optionNodes());
    if (nodes.length === 0) return;
    const checkedIndex = nodes.findIndex((node) => node.getAttribute('data-state') === 'checked');
    const base = checkedIndex >= 0 ? checkedIndex : 0;
    nodes[(base + offset + nodes.length) % nodes.length]?.focus();
  };

  useEffect(() => {
    if (!open || !searchable) return;
    // Radix keeps focus on the trigger when the menu opens and later re-focuses the
    // highlighted option once the popper positions, which steals focus away from the
    // filter input. Re-assert focus in a short settle window (skipped while the user
    // navigates the option list).
    listEngagedRef.current = false;
    const settle = () => {
      if (!listEngagedRef.current && document.activeElement !== searchRef.current) {
        searchRef.current?.focus();
      }
    };
    settle();
    let attempts = 0;
    const id = window.setInterval(() => {
      attempts += 1;
      if (attempts >= 10 || document.activeElement === searchRef.current) {
        window.clearInterval(id);
        return;
      }
      settle();
    }, 16);
    return () => window.clearInterval(id);
  }, [open, searchable]);

  useEffect(() => {
    // Belt-and-suspenders: after every query change, make sure the input still owns
    // focus so keystrokes are never swallowed by the option list.
    if (!open || !searchable) return;
    const id = window.setTimeout(() => {
      if (!listEngagedRef.current && document.activeElement !== searchRef.current) {
        searchRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [open, searchable, query]);

  const chooseFirstMatch = () => {
    const first = (normalizedQuery ? filteredMatches : visibleOptions)[0];
    if (first) {
      onValueChange(first.value);
      setOpen(false);
    }
  };

  return (
    <Select.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery('');
      }}
      value={value}
      disabled={disabled}
      onValueChange={onValueChange}
    >
      <Select.Trigger className={`custom-select-trigger${compact ? ' custom-select-trigger--compact' : ''} ${className}`.trim()} aria-label={label} autoFocus={autoFocus}>
        <Select.Value placeholder={placeholder} />
        <Select.Icon className="custom-select-chevron"><ChevronDown size={compact ? 11 : 13} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className={`custom-select-content${compact ? ' custom-select-content--compact' : ''} ${contentClassName}`.trim()}
          position="popper"
          side={side}
          align="end"
          sideOffset={6}
          collisionPadding={12}
          onEscapeKeyDown={(event) => {
            if (!searchable || !query) return;
            event.preventDefault();
            listEngagedRef.current = false;
            setQuery('');
          }}
        >
          {searchable && (
            <div className="custom-select-search" role="search">
              <Search size={12} aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => {
                  listEngagedRef.current = false;
                  setQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' || event.key === 'Tab') return;
                  // Swallow keys before they reach Radix so its typeahead and list
                  // navigation never steal focus away from the input while typing.
                  event.stopPropagation();
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    listEngagedRef.current = true;
                    focusRelativeOption(1);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    listEngagedRef.current = true;
                    focusRelativeOption(-1);
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    if (normalizedQuery) {
                      chooseFirstMatch();
                    } else {
                      listEngagedRef.current = true;
                      focusRelativeOption(0);
                    }
                  }
                }}
                placeholder={searchPlaceholder}
                aria-label={searchLabel}
                spellCheck={false}
                disabled={disabled || options.length === 0}
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear filter"
                  onClick={() => {
                    listEngagedRef.current = false;
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
          <Select.Viewport ref={viewportRef} className="custom-select-viewport">
            {visibleOptions.map((option) => (
              <Select.Item className="custom-select-item" key={option.value} value={option.value}>
                <Select.ItemIndicator className="custom-select-indicator"><Check size={compact ? 11 : 13} /></Select.ItemIndicator>
                <span className="custom-select-copy">
                  <Select.ItemText>{option.label}</Select.ItemText>
                  {option.detail && <small>{option.detail}</small>}
                </span>
              </Select.Item>
            ))}
            {searchable && normalizedQuery && filteredMatches.length === 0 && (
              <div className="custom-select-empty" role="status">No options match “{query.trim()}”</div>
            )}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
