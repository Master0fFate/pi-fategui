import { FolderClosed, Library, Users } from 'lucide-react';
import { defaultComponents } from './default';
import type { SkinComponents, TabProps } from './types';

function TabContent({ label, icon, labelClassName }: TabProps) {
  const navigationIcon = label === 'Sessions' ? <FolderClosed size={18} />
    : label === 'Agents' ? <Users size={18} />
      : label === 'Resources' ? <Library size={18} /> : null;
  return <>{icon ?? navigationIcon}<span className={labelClassName}>{label}</span></>;
}

// Feature state and handlers stay owned by the workbench; only presentation differs.
export const m3ExpressiveComponents: SkinComponents = { ...defaultComponents, TabContent };
