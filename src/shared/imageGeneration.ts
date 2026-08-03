export const imageGenerationProviderIds = [
  'auto',
  'openai-codex',
  'openai',
  'google',
  'openrouter',
  'custom',
] as const;

export type ImageGenerationProviderId = (typeof imageGenerationProviderIds)[number];

export const openAICompatibleImageApis = ['openai-completions', 'openai-responses'] as const;

export function isOpenAICompatibleImageApi(api: string | undefined): boolean {
  return Boolean(api && openAICompatibleImageApis.some((candidate) => candidate === api));
}

export interface ImageGenerationSettings {
  provider: ImageGenerationProviderId;
  model: string | null;
  customProvider: string | null;
}

export interface ImageGenerationModelPreset {
  id: string;
  name: string;
  detail: string;
  maxResolution?: '1K' | '2K' | '4K';
}

export interface ImageGenerationProviderPreset {
  id: Exclude<ImageGenerationProviderId, 'auto' | 'custom'>;
  name: string;
  providerId: string;
  auth: string;
  endpoint: string;
  description: string;
  defaultModel: string;
  models: readonly ImageGenerationModelPreset[];
}

const openAIModels = [
  { id: 'gpt-image-2', name: 'GPT Image 2', detail: 'Highest-quality GPT Image model' },
  { id: 'gpt-image-1.5', name: 'GPT Image 1.5', detail: 'Previous-generation quality model' },
  { id: 'gpt-image-1', name: 'GPT Image 1', detail: 'Established GPT Image model' },
  { id: 'gpt-image-1-mini', name: 'GPT Image 1 Mini', detail: 'Lower-cost GPT Image model' },
] as const satisfies readonly ImageGenerationModelPreset[];

export const imageGenerationProviderPresets = [
  {
    id: 'openai-codex',
    name: 'OpenAI · ChatGPT',
    providerId: 'openai-codex',
    auth: 'ChatGPT OAuth from Pi',
    endpoint: 'chatgpt.com/backend-api',
    description: 'Uses the ChatGPT Plus/Pro account already signed in through Pi.',
    defaultModel: 'gpt-image-2',
    models: openAIModels,
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    providerId: 'openai',
    auth: 'OpenAI credential from Pi',
    endpoint: 'api.openai.com/v1/images/generations',
    description: 'Uses Pi’s stored OpenAI credential or OPENAI_API_KEY; Fate UI never receives a pasted key.',
    defaultModel: 'gpt-image-2',
    models: openAIModels,
  },
  {
    id: 'google',
    name: 'Google Gemini',
    providerId: 'google',
    auth: 'Gemini credential from Pi',
    endpoint: 'generativelanguage.googleapis.com/v1beta/interactions',
    description: 'Uses the Gemini credential already configured for Pi and Google’s native image models.',
    defaultModel: 'gemini-3.1-flash-image',
    models: [
      { id: 'gemini-3.1-flash-lite-image', name: 'Nano Banana 2 Lite', detail: 'Fastest and lowest cost', maxResolution: '1K' },
      { id: 'gemini-3.1-flash-image', name: 'Nano Banana 2', detail: 'Balanced speed, quality, and 4K output', maxResolution: '4K' },
      { id: 'gemini-3-pro-image', name: 'Nano Banana Pro', detail: 'Premium precision and complex composition', maxResolution: '4K' },
      { id: 'gemini-2.5-flash-image', name: 'Nano Banana', detail: 'Legacy compatibility model', maxResolution: '1K' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter Images',
    providerId: 'openrouter',
    auth: 'OpenRouter OAuth or credential from Pi',
    endpoint: 'openrouter.ai/api/v1/images',
    description: 'Uses Pi’s OpenRouter sign-in and a curated set of raster image models.',
    defaultModel: 'openai/gpt-image-2',
    models: [
      { id: 'openai/gpt-image-2', name: 'OpenAI · GPT Image 2', detail: 'OpenAI quality through OpenRouter' },
      { id: 'google/gemini-3.1-flash-image', name: 'Google · Nano Banana 2', detail: 'Fast native Gemini image generation' },
      { id: 'google/gemini-3-pro-image', name: 'Google · Nano Banana Pro', detail: 'Premium Gemini image generation' },
      { id: 'black-forest-labs/flux.2-pro', name: 'Black Forest Labs · FLUX.2 Pro', detail: 'High-fidelity raster generation' },
      { id: 'bytedance-seed/seedream-4.5', name: 'ByteDance · Seedream 4.5', detail: 'Versatile text-to-image generation' },
    ],
  },
] as const satisfies readonly ImageGenerationProviderPreset[];

export const defaultImageGenerationSettings: ImageGenerationSettings = {
  provider: 'auto',
  model: null,
  customProvider: null,
};

export function imageGenerationPreset(provider: ImageGenerationProviderId): ImageGenerationProviderPreset | undefined {
  return imageGenerationProviderPresets.find((preset) => preset.id === provider);
}

export function defaultImageGenerationModel(provider: ImageGenerationProviderId): string | null {
  return imageGenerationPreset(provider)?.defaultModel ?? null;
}
