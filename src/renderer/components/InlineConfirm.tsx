import { TriangleAlert } from 'lucide-react';
import { useId } from 'react';

interface InlineConfirmProps {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

/** Compact confirmation that stays inside the product surface. */
export function InlineConfirm({ title, message, confirmLabel, onConfirm, onCancel, busy = false }: InlineConfirmProps) {
  const messageId = useId();
  return (
    <div className="inline-confirm" role="alertdialog" aria-label={title} aria-describedby={messageId}>
      <TriangleAlert size={15} aria-hidden="true" />
      <div className="inline-confirm-copy">
        <strong>{title}</strong>
        <span id={messageId}>{message}</span>
      </div>
      <div className="inline-confirm-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="inline-confirm-danger" onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
      </div>
    </div>
  );
}
