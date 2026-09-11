import type { ComponentType, ReactNode } from 'react';

export interface SymbolProps { text: string; children: ReactNode }
export interface TabProps { label: string; active: boolean; icon?: ReactNode; labelClassName?: string }
export interface PromptProps { target: string; hint: string }
export interface MessageHeadingProps { label: string; role: string }
export interface GaugeProps { percent: number | null; estimated: boolean; children: ReactNode }

// Only presentation leaves vary. Features retain controls, state, refs, and actions.
export interface SkinComponents {
  toolbarBreakpoint: number;
  ActionContent: ComponentType<SymbolProps>;
  Symbol: ComponentType<SymbolProps>;
  TabContent: ComponentType<TabProps>;
  PromptHeading: ComponentType<PromptProps>;
  PromptPrefix: ComponentType;
  MessageHeading: ComponentType<MessageHeadingProps>;
  ContextGauge: ComponentType<GaugeProps>;
}
