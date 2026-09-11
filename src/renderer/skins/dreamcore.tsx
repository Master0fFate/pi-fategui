import type { GaugeProps, MessageHeadingProps, PromptProps, SkinComponents, SymbolProps, TabProps } from './types';

function ActionContent({ text }: SymbolProps) {
  return <span className="terminal-action"><span aria-hidden="true">[</span>{text}<span aria-hidden="true">]</span></span>;
}
function Symbol({ text }: SymbolProps) {
  return <span className="terminal-symbol" aria-hidden="true">{text}</span>;
}
function TabContent({ label, active, labelClassName }: TabProps) {
  return <span className="terminal-tab" data-active={active}><span className="terminal-tab-marker" aria-hidden="true">{active ? '>' : ' '}</span><span className={labelClassName}>{label}</span></span>;
}
function PromptHeading({ target, hint }: PromptProps) {
  return <div className="terminal-prompt-heading"><span>message <span aria-hidden="true">/</span> <strong>{target}</strong></span><small>{hint}</small></div>;
}
function PromptPrefix() {
  return <span className="terminal-prompt-prefix" aria-hidden="true">&gt;</span>;
}
function MessageHeading({ label, role }: MessageHeadingProps) {
  return <header className="terminal-message-heading"><span aria-hidden="true">{role === 'user' ? '>' : ':'}</span><span>{label}</span></header>;
}
function ContextGauge({ percent, estimated }: GaugeProps) {
  return <span className="terminal-context" aria-hidden="true">ctx {percent === null ? '?' : `${estimated ? '~' : ''}${Math.round(percent)}%`}</span>;
}

export const dreamcoreComponents: SkinComponents = { ActionContent, Symbol, TabContent, PromptHeading, PromptPrefix, MessageHeading, ContextGauge };
