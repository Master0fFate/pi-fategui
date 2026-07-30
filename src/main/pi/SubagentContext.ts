import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import type { ParentModel } from './SubagentProtocol';

export interface ContextTransferEstimate {
  currentTokens: number;
  transferTokens: number;
  projectedTokens: number;
  contextWindow: number;
}

export class SubagentContextWindowError extends Error {
  readonly code = 'SUBAGENT_CONTEXT_WINDOW_EXCEEDED';

  constructor(
    readonly direction: string,
    readonly receiver: Pick<ParentModel, 'provider' | 'id' | 'contextWindow'>,
    readonly estimate: ContextTransferEstimate,
  ) {
    const available = Math.max(0, estimate.contextWindow - estimate.currentTokens);
    super(
      `Refused ${direction} transfer: the receiving model ${receiver.provider}/${receiver.id} has a maximum context window of ${estimate.contextWindow.toLocaleString()} tokens, `
      + `with approximately ${available.toLocaleString()} tokens currently available. The transfer is approximately ${estimate.transferTokens.toLocaleString()} tokens `
      + `and would project the context to ${estimate.projectedTokens.toLocaleString()} tokens. Shorten or split the message, close context in the receiver, or choose a larger-context model. Automatic compaction was not used.`,
    );
    this.name = 'SubagentContextWindowError';
  }
}

/** Pi's own provider-neutral estimator uses a conservative four-characters-per-token heuristic. */
export function estimateTransferTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimatedSessionTokens(session: AgentSession): number {
  const reported = session.getContextUsage?.();
  const state = session.agent?.state;
  const streamingMessage = state?.streamingMessage;
  const streamingTokens = streamingMessage && !session.messages.includes(streamingMessage)
    ? estimateTokens(streamingMessage as Parameters<typeof estimateTokens>[0])
    : 0;
  if (reported?.tokens !== null && reported?.tokens !== undefined && reported.tokens > 0) return reported.tokens + streamingTokens;

  let tokens = 0;
  if (state?.systemPrompt) tokens += estimateTransferTokens(state.systemPrompt);
  for (const message of [...session.messages, ...(streamingMessage && !session.messages.includes(streamingMessage) ? [streamingMessage] : [])]) {
    try {
      tokens += estimateTokens(message as Parameters<typeof estimateTokens>[0]);
    } catch {
      tokens += estimateTransferTokens(JSON.stringify(message) ?? '');
    }
  }
  if (state?.tools?.length) {
    try {
      const tools = state.tools.map((tool) => {
        const candidate = tool as unknown as { name?: unknown; description?: unknown; parameters?: unknown };
        return { name: candidate.name, description: candidate.description, parameters: candidate.parameters };
      });
      tokens += estimateTransferTokens(JSON.stringify(tools));
    } catch {
      // Tool metadata is a small baseline compared with model context; message admission remains conservative.
    }
  }
  return tokens;
}

export function contextTransferEstimate(
  receiver: Pick<ParentModel, 'provider' | 'id' | 'contextWindow'>,
  text: string,
  session?: AgentSession,
): ContextTransferEstimate {
  const contextWindow = Math.max(1, Math.floor(receiver.contextWindow));
  const currentTokens = session ? estimatedSessionTokens(session) : 0;
  const transferTokens = estimateTransferTokens(text);
  return {
    currentTokens,
    transferTokens,
    projectedTokens: currentTokens + transferTokens,
    contextWindow,
  };
}

export function assertContextTransfer(
  direction: string,
  receiver: Pick<ParentModel, 'provider' | 'id' | 'contextWindow'>,
  text: string,
  session?: AgentSession,
): ContextTransferEstimate {
  const estimate = contextTransferEstimate(receiver, text, session);
  if (estimate.projectedTokens > estimate.contextWindow) throw new SubagentContextWindowError(direction, receiver, estimate);
  return estimate;
}

export function isContextWindowError(error: unknown): error is SubagentContextWindowError {
  return error instanceof SubagentContextWindowError;
}
