export interface SanitizableAgentMessage {
  readonly role: string;
  readonly stopReason?: string;
}

/**
 * Strip assistant messages that ended in error or length from a restored
 * agent message list. Live pi recovery removes such messages from agent state
 * after a compact-and-retry or auto-retry; session restore replays them from
 * the JSONL entry range, which Anthropic rejects as modified history. The
 * JSONL file itself is never touched; only the in-memory model context.
 */
export function stripReplayedFailedAssistants(messages: readonly SanitizableAgentMessage[] | undefined): SanitizableAgentMessage[] | undefined {
  if (!messages) return messages;
  return messages.filter((message) => !(message.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'length')));
}
