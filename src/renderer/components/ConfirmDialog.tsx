import * as Dialog from '@radix-ui/react-dialog';
import { useRef } from 'react';
import { useSkinComponents } from '../skins/SkinProvider';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
  returnFocusTo?: HTMLElement | null;
}

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel, busy = false, error, returnFocusTo }: ConfirmDialogProps) {
  const { ActionContent } = useSkinComponents();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const fallbackFocus = useRef<HTMLElement | null>(null);

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay confirm-dialog-overlay" />
        <Dialog.Content
          className="confirm-dialog"
          role="alertdialog"
          onOpenAutoFocus={(event) => {
            const active = document.activeElement;
            returnFocus.current = returnFocusTo ?? (active instanceof HTMLElement ? active : null);
            fallbackFocus.current = returnFocus.current?.closest<HTMLElement>('[data-dialog-return-focus]') ?? null;
            event.preventDefault();
            cancelButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus.current?.isConnected ? returnFocus.current : fallbackFocus.current;
            if (target?.isConnected) target.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
          onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
        >
          <Dialog.Title className="confirm-dialog-title">{title}</Dialog.Title>
          <Dialog.Description className="confirm-dialog-description">{message}</Dialog.Description>
          {error ? <p className="confirm-dialog-error" role="status">{error}</p> : null}
          <div className="confirm-dialog-actions">
            <button ref={cancelButton} type="button" aria-label="Cancel" disabled={busy} onClick={onCancel}>
              <ActionContent text="cancel">Cancel</ActionContent>
            </button>
            <button className="confirm-dialog-danger" type="button" aria-label={confirmLabel} aria-busy={busy} disabled={busy} onClick={onConfirm}>
              <ActionContent text={busy ? 'working...' : confirmLabel.toLowerCase()}>{busy ? 'Working…' : confirmLabel}</ActionContent>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
