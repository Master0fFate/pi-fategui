import type { SkinComponents, SymbolProps, TabProps } from './types';

const Original = ({ children }: Pick<SymbolProps, 'children'>) => <>{children}</>;
const Empty = () => null;
const TabContent = ({ label, icon, labelClassName }: TabProps) => <>{icon}<span className={labelClassName}>{label}</span></>;

export const defaultComponents: SkinComponents = {
  ActionContent: Original,
  Symbol: Original,
  TabContent,
  PromptHeading: Empty,
  PromptPrefix: Empty,
  MessageHeading: Empty,
  ContextGauge: Original,
};
