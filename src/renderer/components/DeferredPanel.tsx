import { Component, Suspense, type ReactNode } from 'react';

interface DeferredPanelProps {
  children: ReactNode;
  label: string;
  className: string;
}

/** Keep a pending or failed panel chunk inside its tab, leaving navigation usable. */
export class DeferredPanel extends Component<DeferredPanelProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    const { children, label, className } = this.props;
    if (this.state.failed) {
      return <div className={className} role="alert"><p>Unable to load {label}.</p><p>Other tabs are still available. Reload the app to try again.</p></div>;
    }
    return <Suspense fallback={<div className={className} role="status">Loading {label}…</div>}>{children}</Suspense>;
  }
}
