import { describe, expect, it } from 'vitest';
import { disabledModelMessage, enabledModelIdentity, isModelDisabled, modelIdentity, visibleModels } from './modelVisibility';

describe('model visibility', () => {
  it('builds the same provider/id key the composer picker uses', () => {
    expect(modelIdentity('crof', 'kimi-k3')).toBe('crof/kimi-k3');
  });

  it('drops disabled models from picker lists and keeps the rest', () => {
    const models = [
      { provider: 'crof', id: 'kimi-k3' },
      { provider: 'crof', id: 'glm-5' },
      { provider: 'xai', id: 'grok-4' },
    ];
    expect(visibleModels(models, ['crof/glm-5'])).toEqual([
      { provider: 'crof', id: 'kimi-k3' },
      { provider: 'xai', id: 'grok-4' },
    ]);
    expect(visibleModels(models, [])).toBe(models);
  });

  it('clears a default model that the user hid', () => {
    expect(enabledModelIdentity(['crof/glm-5'], 'crof/glm-5')).toBeNull();
    expect(enabledModelIdentity(['crof/glm-5'], 'crof/kimi-k3')).toBe('crof/kimi-k3');
    expect(enabledModelIdentity([], 'crof/glm-5')).toBe('crof/glm-5');
  });

  it('tells subagents why a hidden model is unavailable', () => {
    expect(isModelDisabled(['alternate/glm'], 'alternate', 'glm')).toBe(true);
    expect(isModelDisabled(['alternate/glm'], 'test', 'model')).toBe(false);
    expect(disabledModelMessage('alternate', 'glm')).toContain('disabled in Fate UI settings');
  });
});
