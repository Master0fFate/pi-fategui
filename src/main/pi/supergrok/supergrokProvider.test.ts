import { describe, expect, it, vi } from 'vitest';
import {
  buildXaiAuthorizeUrl,
  generatePkce,
  packXaiRefresh,
  parseOAuthCallbackInput,
  parseXaiRefresh,
} from './supergrokOAuth';
import { fetchSuperGrokModels, mapSuperGrokModel, mergeSuperGrokModels, supergrokStaticModels } from './supergrokModels';
import { registerSuperGrokProvider, supergrokProviderConfig, SUPERGROK_PROVIDER_ID } from './supergrokProvider';
import type { SuperGrokFetch } from './supergrokOAuth';

describe('superGrok oauth primitives', () => {
  it('builds a PKCE authorize URL on the xAI origin', () => {
    const url = new URL(buildXaiAuthorizeUrl({
      authorizationEndpoint: 'https://auth.x.ai/oauth2/authorize',
      redirectUri: 'http://127.0.0.1:56121/callback',
      codeChallenge: 'challenge',
      state: 'state',
      nonce: 'nonce',
    }));
    expect(url.origin).toBe('https://auth.x.ai');
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state');
    expect(url.searchParams.get('scope')).toContain('grok-cli:access');
  });

  it('rejects authorize endpoints off the xAI origin', () => {
    expect(() => buildXaiAuthorizeUrl({ authorizationEndpoint: 'https://evil.example/authorize', redirectUri: 'http://127.0.0.1/callback', codeChallenge: 'c', state: 's', nonce: 'n' })).toThrow(/not on xAI's origin/);
  });

  it('round-trips packed refresh tokens', () => {
    const packed = packXaiRefresh({ refreshToken: 'r1', tokenEndpoint: 'https://auth.x.ai/oauth2/token', redirectUri: 'http://127.0.0.1:56121/callback' });
    expect(packed.startsWith('xai:')).toBe(true);
    expect(parseXaiRefresh(packed)).toEqual({ refreshToken: 'r1', tokenEndpoint: 'https://auth.x.ai/oauth2/token', redirectUri: 'http://127.0.0.1:56121/callback' });
    expect(parseXaiRefresh('plain-refresh')).toEqual({ refreshToken: 'plain-refresh' });
    expect(parseXaiRefresh('xai:not-base64-json!!!').refreshToken).toBe('');
  });

  it('validates callback URLs against the expected state', () => {
    expect(parseOAuthCallbackInput('http://127.0.0.1:56121/callback?code=abc&state=s1', 's1')).toEqual({ code: 'abc' });
    expect(parseOAuthCallbackInput('http://127.0.0.1:56121/callback?code=abc&state=other', 's1')).toEqual({ error: 'OAuth state mismatch.' });
    expect(parseOAuthCallbackInput('http://127.0.0.1:56121/callback?error=denied', 's1')).toEqual({ error: 'denied' });
    expect(parseOAuthCallbackInput('  pasted-code  ', 's1')).toEqual({ code: 'pasted-code' });
  });

  it('generates matching PKCE pairs', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge).not.toContain('=');
  });
});

describe('superGrok model catalog', () => {
  it('seeds the documented model list', () => {
    const ids = supergrokStaticModels().map((model) => model.id);
    expect(ids).toEqual(['grok-4.20-0309-non-reasoning', 'grok-4.20-0309-reasoning', 'grok-4.3', 'grok-build-0.1', 'grok-composer-2.5-fast']);
  });

  it('maps live entries and drops non-chat models', () => {
    expect(mapSuperGrokModel({ id: 'grok-imagine-1' })).toBeUndefined();
    expect(mapSuperGrokModel({ id: 'grok-video' })).toBeUndefined();
    const mapped = mapSuperGrokModel({ id: 'grok-5', name: 'Grok 5', reasoning: true, context_window: 200_000, max_output_tokens: 32_000, pricing: { prompt_text_token_price: 30, completion_text_token_price: 60 } })!;
    expect(mapped.contextWindow).toBe(200_000);
    expect(mapped.maxTokens).toBe(32_000);
    expect(mapped.cost).toEqual({ input: 0.003, output: 0.006, cacheRead: 0, cacheWrite: 0 }); // per-10k → per-million
    const nonReasoning = mapSuperGrokModel({ id: 'grok-9-non-reasoning' })!;
    expect(nonReasoning.reasoning).toBe(false);
    const inferredReasoning = mapSuperGrokModel({ id: 'grok-9' })!;
    expect(inferredReasoning.reasoning).toBe(true);
  });

  it('merges live models without overriding the static seed', () => {
    const merged = mergeSuperGrokModels([
      { id: 'grok-4.3', name: 'Live Grok 4.3', reasoning: false, input: ['text', 'image'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 999, maxTokens: 999 },
      { id: 'grok-5', name: 'Grok 5', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100, maxTokens: 100 },
    ]);
    const grok43 = merged.find((model) => model.id === 'grok-4.3')!;
    expect(grok43.name).toBe('Grok 4.3 (SuperGrok)'); // static wins
    expect(merged.some((model) => model.id === 'grok-5')).toBe(true);
  });

  it('fetches the live list with the OAuth bearer token', async () => {
    const fetchImpl: SuperGrokFetch = (async (url, init) => {
      expect(String(url)).toBe('https://api.x.ai/v1/models');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
      return new Response(JSON.stringify({ data: [{ id: 'grok-5', reasoning: true }] }), { status: 200 });
    }) as SuperGrokFetch;
    const models = await fetchSuperGrokModels('tok', fetchImpl);
    expect(models.map((model) => model.id)).toEqual(['grok-5']);
  });
});

describe('registerSuperGrokProvider', () => {
  it('registers the provider on a ModelRuntime under the supergrok id', () => {
    const registerProvider = vi.fn();
    registerSuperGrokProvider({ registerProvider } as never);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    const [id, config] = registerProvider.mock.calls[0] as [string, ReturnType<typeof supergrokProviderConfig>];
    expect(id).toBe(SUPERGROK_PROVIDER_ID);
    expect(config.name).toBe('SuperGrok (xAI OAuth)');
    expect(config.oauth?.name).toBe('SuperGrok / xAI OAuth');
    expect(config.models!.length).toBeGreaterThan(0);
  });
});

describe('supergrokProviderConfig', () => {
  function refreshContext(options: { allowNetwork?: boolean; stored?: { models: unknown[] }; publish?: (entry: { persist: { models: unknown[]; checkedAt: number } }) => Promise<boolean> } = {}) {
    return {
      signal: new AbortController().signal,
      allowNetwork: options.allowNetwork ?? false,
      ...(options.stored ? { stored: { checkedAt: 1, ...options.stored } } : {}),
      publish: options.publish ?? (async () => true),
    } as unknown as Parameters<NonNullable<ReturnType<typeof supergrokProviderConfig>['refreshModels']>>[0];
  }

  it('registers with OAuth, openai-completions, and the seed list', () => {
    const runtime = { getAuth: async () => undefined };
    const config = supergrokProviderConfig(runtime);
    expect(config.name).toBe('SuperGrok (xAI OAuth)');
    expect(config.baseUrl).toBe('https://api.x.ai/v1');
    expect(config.api).toBe('openai-completions');
    expect(config.headers).toEqual({ 'x-grok-source': 'pi-supergrok' });
    expect(config.models).toHaveLength(5);
    expect(config.oauth?.name).toBe('SuperGrok / xAI OAuth');
    expect(config.oauth?.isSubscription).toBe(true);
  });

  it('returns the seed when no credential exists, without network calls', async () => {
    const fetchImpl = (async () => { throw new Error('must not fetch'); }) as unknown as SuperGrokFetch;
    const config = supergrokProviderConfig({ getAuth: async () => undefined }, fetchImpl);
    const models = await config.refreshModels!(refreshContext({ allowNetwork: true }));
    expect(models).toHaveLength(5);
  });

  it('merges live models and persists them when signed in', async () => {
    const persisted: { models: unknown[]; checkedAt: number }[] = [];
    const fetchImpl: SuperGrokFetch = (async () => new Response(JSON.stringify({ data: [{ id: 'grok-6', reasoning: true, context_window: 400_000 }] }), { status: 200 })) as SuperGrokFetch;
    const config = supergrokProviderConfig({ getAuth: async () => ({ auth: { apiKey: 'tok' } }) }, fetchImpl);
    const models = await config.refreshModels!(refreshContext({ allowNetwork: true, publish: async (entry) => { persisted.push(entry.persist as never); return true; } }));
    expect(models.map((model) => model.id)).toContain('grok-6');
    expect(models).toHaveLength(6); // 5 static + 1 live
    expect(persisted).toHaveLength(1);
    expect((persisted[0] as { models: Array<{ provider: string; api: string }> }).models[0]!.provider).toBe(SUPERGROK_PROVIDER_ID);
  });

  it('restores the persisted list offline and keeps it on fetch failure', async () => {
    const storedModel = { id: 'grok-4.3', name: 'Grok 4.3 (SuperGrok)', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8_192, provider: SUPERGROK_PROVIDER_ID, api: 'openai-completions' };
    const config = supergrokProviderConfig({ getAuth: async () => ({ auth: { apiKey: 'tok' } }) });
    const offline = await config.refreshModels!(refreshContext({ allowNetwork: false, stored: { models: [storedModel] } }));
    expect(offline).toHaveLength(1);
    const failing: SuperGrokFetch = (async () => { throw new Error('network down'); }) as unknown as SuperGrokFetch;
    const failingConfig = supergrokProviderConfig({ getAuth: async () => ({ auth: { apiKey: 'tok' } }) }, failing);
    const kept = await failingConfig.refreshModels!(refreshContext({ allowNetwork: true, stored: { models: [storedModel] } }));
    expect(kept).toHaveLength(1); // last known list, not the seed
  });
});
