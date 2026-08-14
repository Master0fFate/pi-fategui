import { describe, expect, it } from 'vitest';
import { speechSettingsSchema } from '../../shared/contracts/ipc';
import { resolveModelLanguage, speechModels } from './speechModels';

describe('speech model catalog', () => {
  it('covers all three tiers with unique ids and files', () => {
    const ids = new Set(speechModels.map((model) => model.id));
    const files = new Set(speechModels.map((model) => model.fileName));
    expect(ids.size).toBe(speechModels.length);
    expect(files.size).toBe(speechModels.length);
    const tiers = new Set(speechModels.map((model) => model.tier));
    expect([...tiers].sort()).toEqual(['balanced', 'max', 'mini']);
  });

  it('pins every download to an immutable commit with a checksum', () => {
    for (const model of speechModels) {
      expect(model.url).toMatch(/^https:\/\/huggingface\.co\/handy-computer\/.+\/resolve\/[0-9a-f]{40}\//);
      expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(model.bytes).toBeGreaterThan(0);
    }
  });

  it('keeps the three current models on their existing files so installed downloads stay valid', () => {
    const unified = speechModels.find((model) => model.id === 'parakeet-unified');
    expect(unified?.fileName).toBe('parakeet-unified-en-0.6b-Q5_K_M.gguf');
    const canary = speechModels.find((model) => model.id === 'canary-flash');
    expect(canary?.fileName).toBe('canary-180m-flash-Q5_K_M.gguf');
    const cohere = speechModels.find((model) => model.id === 'cohere-transcribe');
    expect(cohere?.fileName).toBe('cohere-transcribe-03-2026-Q4_K_M.gguf');
  });

  it('exposes at least one streaming model in the balanced tier', () => {
    const streaming = speechModels.filter((model) => model.tier === 'balanced' && model.streaming);
    expect(streaming.length).toBeGreaterThanOrEqual(2);
    for (const model of streaming) {
      // Parakeet-class streamers need their buffered menu; others use the default slot.
      if (model.id === 'parakeet-unified') expect(model.streamFamily).toEqual({ kind: 'parakeet_buffered' });
    }
  });
});

describe('resolveModelLanguage', () => {
  it('maps short codes through the model language map', () => {
    const nemotron = speechModels.find((model) => model.id === 'nemotron-stream')!;
    expect(resolveModelLanguage(nemotron, 'en')).toBe('en-US');
    expect(resolveModelLanguage(nemotron, 'pt')).toBe('pt-BR');
  });

  it('passes auto through only for detecting models and falls back to en otherwise', () => {
    const nemotron = speechModels.find((model) => model.id === 'nemotron-stream')!;
    const canary = speechModels.find((model) => model.id === 'canary-flash')!;
    // Nemotron's stream rejects the literal "auto" tag: auto means omitting the
    // language so the engine detects it.
    expect(resolveModelLanguage(nemotron, 'auto')).toBeUndefined();
    expect(resolveModelLanguage(nemotron, undefined)).toBeUndefined();
    expect(resolveModelLanguage(canary, 'auto')).toBe('en');
    expect(resolveModelLanguage(canary, 'en')).toBe('en');
    expect(resolveModelLanguage(canary, undefined)).toBe('en');
  });
});

describe('speech settings migration', () => {
  it('maps legacy tier ids to their model ids', () => {
    expect(speechSettingsSchema.parse({ modelId: 'mini' }).modelId).toBe('canary-flash');
    expect(speechSettingsSchema.parse({ modelId: 'balanced' }).modelId).toBe('parakeet-unified');
    expect(speechSettingsSchema.parse({ modelId: 'max' }).modelId).toBe('cohere-transcribe');
  });

  it('accepts new model ids and defaults the accuracy pass to off', () => {
    const parsed = speechSettingsSchema.parse({ modelId: 'nemotron-stream' });
    expect(parsed.modelId).toBe('nemotron-stream');
    expect(parsed.finalAccuracyPass).toBe(false);
  });
});
