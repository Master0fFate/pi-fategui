import type { LucideIcon } from 'lucide-react';

export function InspectorSectionHeading({ icon: Icon, title, detail, className = 'context-section-heading' }: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  className?: string;
}) {
  return (
    <header className={className}>
      <span><Icon size={13} /><strong>{title}</strong></span>
      {detail ? <small>{detail}</small> : null}
    </header>
  );
}
