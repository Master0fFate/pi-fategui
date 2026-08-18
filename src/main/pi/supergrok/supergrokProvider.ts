import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { XAI_API_BASE_URL } from './supergrokOAuth';
import { loginXai, refreshXaiTokens, type SuperGrokCredentials, type SuperGrokFetch } from './supergrokOAuth';
import { fetchSuperGrokModels, mergeSuperGrokModels, supergrokStaticModels, type SuperGrokModelConfig } from './supergrokModels';

/**
 * Fate UI's vendored SuperGrok provider (xAI subscription OAuth).
 *
 * Adapted from pi-supergrok 0.2.2 (MIT, github.com/dvcrn/pi-supergrok). The
 * provider registers on every ModelRuntime like a pi extension would:
 * - /login lists "SuperGrok (xAI OAuth)" with a browser OAuth flow (PKCE +
 *   loopback callback), credentials stored by the SDK in Fate's auth store.
 * - The model list is the static seed merged with the live /v1/models list
 *   once credentials exist; the merged list persists in models-store.json so
 *   offline starts keep the last known models.
 * - Streaming runs through the SDK's openai-completions implementation with
 *   the resolved OAuth bearer token and the x-grok-source header.
 */

type ProviderConfig = Parameters<ModelRuntime['registerProvider']>[1];
type ProviderModel = NonNullable<ProviderConfig['models']>[number];
type RefreshModelsContext = Parameters<NonNullable<ProviderConfig['refreshModels']>>[0];
type SuperGrokOAuth = NonNullable<ProviderConfig['oauth']>;
type OAuthLoginCallbacks = Parameters<SuperGrokOAuth['login']>[0];
/** Minimal auth view Fate needs from the runtime for live model fetches. */
type RuntimeAuthView = Pick<ModelRuntime, 'getAuth'> & {
  getAuth: (providerId: string) => Promise<{ auth: { apiKey?: string } } | undefined>;
};

export const SUPERGROK_PROVIDER_ID = 'supergrok';
const SUPERGROK_FETCH_TIMEOUT_MS = 12_000;

function toProviderModels(models: readonly SuperGrokModelConfig[]): ProviderModel[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}

function isUsableModel(value: unknown): value is ProviderModel {
  if (!value || typeof value !== 'object') return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.trim() !== '';
}

function restoredModels(context: RefreshModelsContext): ProviderModel[] | undefined {
  const stored = context.stored;
  if (!stored || !Array.isArray(stored.models)) return undefined;
  const restored = stored.models.filter(isUsableModel).map((entry) => ({ ...entry }));
  return restored.length > 0 ? restored : undefined;
}

/** Build the full provider config. `runtime` supplies auth for live fetches. */
export function supergrokProviderConfig(runtime: RuntimeAuthView, fetchImpl?: SuperGrokFetch): ProviderConfig {
  const oauth: SuperGrokOAuth = {
    name: 'SuperGrok / xAI OAuth',
    isSubscription: true,
    login: async (callbacks: OAuthLoginCallbacks) => loginXai(callbacks, fetchImpl) as unknown as Awaited<ReturnType<SuperGrokOAuth['login']>>,
    refreshToken: async (credentials: SuperGrokCredentials, signal: AbortSignal) => refreshXaiTokens(credentials, fetchImpl, signal) as unknown as Awaited<ReturnType<SuperGrokOAuth['refreshToken']>>,
    getApiKey: (credentials: SuperGrokCredentials) => credentials.access,
  };
  return {
    name: 'SuperGrok (xAI OAuth)',
    baseUrl: XAI_API_BASE_URL,
    api: 'openai-completions',
    headers: { 'x-grok-source': 'pi-supergrok' },
    oauth,
    models: toProviderModels(supergrokStaticModels()),
    refreshModels: async (context) => {
      const seed = toProviderModels(supergrokStaticModels());
      if (context.signal.aborted) return seed;
      const restored = restoredModels(context);
      // No network (offline restore) or no stored credential yet: seed wins.
      if (!context.allowNetwork) return restored ?? seed;
      let accessToken: string | undefined;
      try {
        const auth = await runtime.getAuth(SUPERGROK_PROVIDER_ID);
        accessToken = auth?.auth.apiKey;
      } catch { /* Auth resolution failure keeps the last known list. */ }
      if (!accessToken) return restored ?? seed;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SUPERGROK_FETCH_TIMEOUT_MS);
      const abortWithParent = () => controller.abort(context.signal.reason);
      if (context.signal.aborted) abortWithParent();
      else context.signal.addEventListener('abort', abortWithParent, { once: true });
      controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
      try {
        const live = await fetchSuperGrokModels(accessToken, fetchImpl, controller.signal);
        if (context.signal.aborted) return restored ?? seed;
        const merged = toProviderModels(mergeSuperGrokModels(live));
        // The persisted form carries api/provider stamps for models-store restore.
        const stamped = merged.map((model) => ({ ...model, api: 'openai-completions' as const, provider: SUPERGROK_PROVIDER_ID }) as unknown as NonNullable<RefreshModelsContext['stored']>['models'][number]);
        const published = await context.publish({ persist: { models: stamped, checkedAt: Date.now() } });
        return published ? merged : restored ?? seed;
      } catch {
        // Offline, expired token, or a broken catalog: keep the last known list.
        return restored ?? seed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Register SuperGrok on a ModelRuntime, exactly like a pi extension would. */
export function registerSuperGrokProvider(runtime: ModelRuntime): void {
  runtime.registerProvider(SUPERGROK_PROVIDER_ID, supergrokProviderConfig(runtime));
}
