import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { messageText } from './PiEventNormalizer';

const TITLE_LIMIT = 50;
const PROMPT_LIMIT = 8_000;
const TITLE_TIMEOUT_MS = 30_000;
// Cap, not target: models that cannot disable thinking spend output tokens on
// reasoning before the title, so leave room for reasoning plus the title.
const TITLE_MAX_TOKENS = 512;

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
        // No `reasoning` option: its absence is the adapter's strongest
        // "thinking disabled" signal for providers that honor it. Models that
        // still think (custom proxies, entries without reasoning flags) fit
        // inside TITLE_MAX_TOKENS because it is a cap, not a target.
        maxTokens: TITLE_MAX_TOKENS,
        signal: controller.signal,
      });
      if (response.stopReason === 'error' || response.stopReason === 'aborted') return null;
      // A length stop can cut the response inside the thinking phase with no
      // text emitted at all; an empty title falls back to the first message.
      const raw = messageText(response);
      if (!raw.trim()) return null;
      return sanitizeGeneratedSessionTitle(raw);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
