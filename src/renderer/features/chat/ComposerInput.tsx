import type {
  ButtonHTMLAttributes, ChangeEventHandler, FormHTMLAttributes, KeyboardEvent, ReactNode, Ref, TextareaHTMLAttributes,
} from 'react';

export type ComposerSubmitKey = 'enter' | 'modifier-enter' | 'button-only';
export interface ComposerPresentationProps {
  source: 'desktop' | 'network';
  formRef?: Ref<HTMLFormElement>;
  formProps?: Omit<FormHTMLAttributes<HTMLFormElement>, 'children' | 'onSubmit'> & {
    'data-compact-toolbar'?: string;
    'data-session-drop'?: boolean | undefined;
  };
  inputRef?: Ref<HTMLTextAreaElement>;
  inputShellRef?: Ref<HTMLDivElement>;
  inputPrefix?: ReactNode;
  input: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
    value: string;
    onChange: ChangeEventHandler<HTMLTextAreaElement>;
  };
  action: {
    label: string;
    disabled: boolean;
    content: ReactNode;
    attributes?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children' | 'aria-label' | 'disabled' | 'onClick'> & {
      'data-mode'?: 'stop' | 'send';
    };
  };
  submitKey: ComposerSubmitKey;
  onAction: () => void;
  /** Desktop Enter queues/submits; clicking the same action can instead stop a running turn. */
  onKeyboardAction?: () => void;
  /** Capability-specific attachments, headings, native tools, recovery and tooltip placement are slots.
   * Input, submit action and event dispatch themselves are rendered only here for both sources. */
  children: (controls: { input: ReactNode; sendAction: ReactNode }) => ReactNode;
}

/** The actual shared input/action presentation, independent of desktop RuntimeState or wire DTOs.
 * Source controllers supply captured, authorized actions; this component never resolves a target. */
export function ComposerPresentation({ source, formRef, formProps, inputRef, inputShellRef, inputPrefix,
  input, action, submitKey, onAction, onKeyboardAction, children }: ComposerPresentationProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    input.onKeyDown?.(event); // source-specific mention/slash navigation and draft undo take priority
    if (event.defaultPrevented || event.key !== 'Enter' || submitKey === 'button-only') return;
    const shouldSend = submitKey === 'modifier-enter' ? event.ctrlKey || event.metaKey : !event.shiftKey && !event.altKey;
    if (!shouldSend) return;
    event.preventDefault();
    if (!action.disabled && !input.disabled && !input.readOnly) (onKeyboardAction ?? onAction)();
  };
  const entry = <div ref={inputShellRef} className="composer-input-shell" data-overflow-top="false" data-overflow-bottom="false">
    {inputPrefix}
    <textarea {...input} ref={inputRef} data-composer-entry={source} onKeyDown={onKeyDown} />
  </div>;
  const sendAction = <button {...action.attributes} className={action.attributes?.className ?? 'send-button'}
    type="submit" aria-label={action.label} disabled={action.disabled} data-composer-action={source}>
    {action.content}
  </button>;
  return <form {...formProps} ref={formRef} className={formProps?.className ?? 'composer'} data-composer-source={source}
    onSubmit={(event) => { event.preventDefault(); if (!action.disabled) onAction(); }}>
    {children({ input: entry, sendAction })}
  </form>;
}
