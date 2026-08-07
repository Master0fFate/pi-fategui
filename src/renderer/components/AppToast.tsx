import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect } from 'react';
import { useUiStore } from '../stores/uiStore';

export function AppToast() {
  const toast = useUiStore((state) => state.toast);
  const dismissToast = useUiStore((state) => state.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(dismissToast, toast.kind === 'error' ? 7_000 : 4_500);
    return () => window.clearTimeout(timeout);
  }, [dismissToast, toast]);

  if (!toast) return null;
  const Icon = toast.kind === 'success'
    ? CheckCircle2
    : toast.kind === 'warning'
      ? TriangleAlert
      : toast.kind === 'error'
        ? CircleAlert
        : Info;

  return (
    <div className={`app-toast app-toast--${toast.kind}`} role={toast.kind === 'error' || toast.kind === 'warning' ? 'alert' : 'status'} aria-atomic="true">
      <Icon size={17} aria-hidden="true" />
      <div><strong>{toast.title}</strong><span>{toast.message}</span></div>
      <button type="button" aria-label="Dismiss notification" onClick={dismissToast}><X size={13} /></button>
    </div>
  );
}
