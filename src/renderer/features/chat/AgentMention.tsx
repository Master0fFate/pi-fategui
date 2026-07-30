import { Fragment, type AnchorHTMLAttributes, type ClassAttributes, type ReactNode } from 'react';
import { subagentDisplayName, subagentHandle } from '../../../shared/subagentIdentity';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';

const agentUrlPrefix = 'fate-agent:';
const mentionPattern = /@([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?![a-z0-9-])/giu;

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

function mentionNodes(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(mentionPattern)) {
    const index = match.index;
    const handle = match[1]?.toLocaleLowerCase();
    if (index === undefined || !handle || (index > 0 && /[\p{L}\p{N}_@]/u.test(value[index - 1] ?? ''))) continue;
    if (index > cursor) nodes.push({ type: 'text', value: value.slice(cursor, index) });
    nodes.push({ type: 'link', url: `${agentUrlPrefix}${handle}`, children: [{ type: 'text', value: `@${handle}` }] });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) });
  return nodes.length ? nodes : [{ type: 'text', value }];
}

function transformMentions(node: MarkdownNode): void {
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
  const children: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') children.push(...mentionNodes(child.value));
    else {
      transformMentions(child);
      children.push(child);
    }
  }
  node.children = children;
}

export function remarkAgentMentions() {
  return (tree: MarkdownNode) => transformMentions(tree);
}

export function AgentMentionChip({ handle, children }: { handle: string; children?: ReactNode }) {
  const runId = useRuntimeStore((state) => {
    for (const id of state.subagentOrder) {
      const run = state.subagentsById[id];
      if (run && subagentHandle(run) === handle) return id;
    }
    for (const workflow of state.runtime.subagentWorkflows ?? []) {
      const node = workflow.nodes.find((candidate) => candidate.handle === handle && candidate.runId);
      if (node?.runId) return node.runId;
    }
    return null;
  });
  const identity = useRuntimeStore((state) => {
    const run = runId ? state.subagentsById[runId] : undefined;
    return run ? `${subagentDisplayName(run)}\0${run.status}` : '';
  });
  if (!runId || !identity) return <span>{children ?? `@${handle}`}</span>;
  const [displayName, status] = identity.split('\0');
  return (
    <button
      className="agent-mention"
      type="button"
      title={`Open ${displayName} · ${status}`}
      onClick={() => useUiStore.getState().openSubagent(runId)}
    >
      {children ?? `@${handle}`}
    </button>
  );
}

type AgentMentionLinkProps = ClassAttributes<HTMLAnchorElement> & AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };

export function AgentMentionLink({ href, children, node: _node, ...props }: AgentMentionLinkProps) {
  if (href?.startsWith(agentUrlPrefix)) {
    const handle = href.slice(agentUrlPrefix.length).toLocaleLowerCase();
    return <AgentMentionChip handle={handle}>{children}</AgentMentionChip>;
  }
  return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
}

export function MentionText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(mentionPattern)) {
    const index = match.index;
    const handle = match[1]?.toLocaleLowerCase();
    if (index === undefined || !handle || (index > 0 && /[\p{L}\p{N}_@]/u.test(text[index - 1] ?? ''))) continue;
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(<AgentMentionChip key={`${index}:${handle}`} handle={handle} />);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts.map((part, index) => <Fragment key={typeof part === 'string' ? `${index}:${part}` : index}>{part}</Fragment>)}</>;
}
