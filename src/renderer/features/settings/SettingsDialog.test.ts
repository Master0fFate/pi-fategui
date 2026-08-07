import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../../shared/contracts/ipc';
import { formatProviderName, groupModelsByProvider } from './SettingsDialog';

const model = (provider: string, id: string, name: string): ModelInfo => ({
  provider, id, name, reasoning: false, contextWindow: 100_000,
});

describe('settings model catalog', () => {
  it('separates models by provider and sorts both levels for stable picking', () => {
    const groups = groupModelsByProvider([
      model('openai', 'gpt-z', 'Zulu'),
      model('anthropic', 'claude-a', 'Alpha'),
      model('openai', 'gpt-a', 'Alpha'),
    ]);

    expect(groups.map((group) => group.title)).toEqual(['Anthropic', 'OpenAI']);
    expect(groups[1]?.models.map((entry) => entry.id)).toEqual(['gpt-a', 'gpt-z']);
  });

  it('turns unknown provider slugs into readable titles', () => {
    expect(formatProviderName('acme-cloud')).toBe('Acme Cloud');
    expect(formatProviderName('openai')).toBe('OpenAI');
  });
});
