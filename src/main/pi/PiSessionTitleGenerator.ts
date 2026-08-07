import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { messageText } from './PiEventNormalizer';

const TITLE_LIMIT = 50;
const PROMPT_LIMIT = 8_000;
const TITLE_TIMEOUT_MS = 15_000;

export interface SessionTitleGenerator {
  generate(prompt: string, modelRuntime: ModelRuntime, session: AgentSession): Promise<string | null>;
}

export function sanitizeGeneratedSessionTitle(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/u)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim() ?? '';
  if (!normalized) return 'New session';
  const characters = [...normalized];
  if (characters.length <= TITLE_LIMIT) return normalized;
  return `${characters.slice(0, TITLE_LIMIT - 3).join('').trimEnd()}...`;
}

export class PiSessionTitleGenerator implements SessionTitleGenerator {
  async generate(prompt: string, modelRuntime: ModelRuntime, session: AgentSession): Promise<string | null> {
    const model = session.model;
    if (!model) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
    timeout.unref();
    try {
      const response = await modelRuntime.completeSimple(model, {
        systemPrompt: 'Create a concise sidebar title for this coding session. Return only the title: one line, no quotes, no markdown, at most 50 characters. Describe the concrete task rather than repeating filler words.',
        messages: [{ role: 'user', content: prompt.slice(0, PROMPT_LIMIT), timestamp: Date.now() }],
      }, {
        maxTokens: 40,
        signal: controller.signal,
      });
      if (response.stopReason === 'error' || response.stopReason === 'aborted') return null;
      return sanitizeGeneratedSessionTitle(messageText(response));
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
