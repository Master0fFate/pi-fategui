import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defineTool, getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ImageGenerationSettings } from '../../shared/contracts/ipc';
import {
  defaultImageGenerationModel,
  defaultImageGenerationSettings,
  imageGenerationPreset,
  isOpenAICompatibleImageApi,
  type ImageGenerationProviderId,
} from '../../shared/imageGeneration';
import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_DIMENSION,
  MAX_PROMPT_IMAGE_TOTAL_PIXELS,
  encodedImageSize,
} from './PiPromptImages';

const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
const MAX_IMAGE_PROMPT_CHARACTERS = 32_000;
const MAX_ERROR_BYTES = 8_000;
const MAX_BASE64_CHARACTERS = Math.ceil(MAX_PROMPT_IMAGE_BYTES / 3) * 4 + 4;
const MAX_IMAGE_RESPONSE_BYTES = MAX_BASE64_CHARACTERS + 1_000_000;

type RasterMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
type ImageOutputFormat = 'png' | 'jpeg' | 'webp';
type ImageQuality = 'auto' | 'low' | 'medium' | 'high';
type ImageSize = 'auto' | '1024x1024' | '1536x1024' | '1024x1536';
type ImageToolContext = Pick<ExtensionContext, 'cwd' | 'model' | 'modelRegistry' | 'sessionManager'>;
type ImageDriverModel = NonNullable<ImageToolContext['model']>;
export type ImageGenerationSettingsResolver = () => ImageGenerationSettings;

export interface ImageGenerationRequest {
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
  outputFormat: ImageOutputFormat;
  signal: AbortSignal | undefined;
  context: ImageToolContext;
}

export interface GeneratedRasterImage {
  data: string;
  mimeType: RasterMimeType;
  revisedPrompt?: string;
  provider: string;
  model: string;
  imageModel?: string;
  imageId?: string;
  requestId?: string;
}

export interface GeneratedImageStoreRequest {
  image: Buffer;
  dimensions: { width: number; height: number };
  generated: GeneratedRasterImage;
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
  outputFormat: ImageOutputFormat;
  sessionId: string;
}

export interface StoredGeneratedImage {
  image: Buffer;
  savedPath: string;
  metadataPath: string | null;
  warning: string | null;
}

export type RasterImageGenerator = (request: ImageGenerationRequest) => Promise<GeneratedRasterImage>;
export type GeneratedImageStore = (request: GeneratedImageStoreRequest) => Promise<StoredGeneratedImage>;

interface ImageStreamResult {
  data: string;
  imageId?: string;
  outputFormat?: ImageOutputFormat;
  revisedPrompt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function mimeTypeFor(format: ImageOutputFormat): RasterMimeType {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function extensionFor(mimeType: RasterMimeType): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function outputFormatFor(mimeType: RasterMimeType): ImageOutputFormat {
  if (mimeType === 'image/jpeg') return 'jpeg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function safePathSegment(value: string, fallback: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80);
  return sanitized || fallback;
}

async function atomicWrite(target: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, { mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export const saveGeneratedImage: GeneratedImageStore = async ({
  image, dimensions, generated, prompt, size, quality, outputFormat, sessionId,
}) => {
  const imageId = generated.imageId ?? randomUUID();
  const directory = path.join(getAgentDir(), 'generated-images', safePathSegment(sessionId, 'unsaved-session'));
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const fileName = `${timestamp}-${safePathSegment(imageId, randomUUID())}.${extensionFor(generated.mimeType)}`;
  const savedPath = path.join(directory, fileName);
  await atomicWrite(savedPath, image);
  const metadataPath = savedPath.replace(/\.[^.]+$/u, '.json');
  const metadata = {
    createdAt: new Date().toISOString(),
    prompt,
    provider: generated.provider,
    responseModel: generated.model,
    imageModel: generated.imageModel ?? 'gpt-image-2',
    imageId,
    savedPath,
    mimeType: generated.mimeType,
    width: dimensions.width,
    height: dimensions.height,
    size,
    quality,
    outputFormat: outputFormatFor(generated.mimeType),
    requestedOutputFormat: outputFormat,
    ...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
    ...(generated.requestId ? { requestId: generated.requestId } : {}),
  };
  try {
    await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return { image, savedPath, metadataPath, warning: null };
  } catch {
    return {
      image,
      savedPath,
      metadataPath: null,
      warning: 'The image was saved, but its metadata sidecar could not be written.',
    };
  }
};

function imageGenerationError(code: unknown, message: unknown, status?: number): Error {
  const normalizedCode = typeof code === 'string' ? code : '';
  const normalizedMessage = typeof message === 'string' ? message : '';
  if (normalizedCode === 'moderation_blocked') {
    return new Error('OpenAI blocked this image request under its safety policy. Revise the prompt or reference image and try again.');
  }
  if (status === 401 || status === 403 || /auth|unauthorized|token/iu.test(normalizedCode)) {
    return new Error('OpenAI image generation authentication expired or was rejected. Sign in to the OpenAI provider again, then retry.');
  }
  if (status === 429 || /rate|quota|usage_limit/iu.test(normalizedCode)) {
    return new Error('OpenAI image generation is temporarily rate-limited or has reached its usage limit. Try again later.');
  }
  const detail = normalizedMessage || normalizedCode;
  return new Error(detail ? `OpenAI image generation failed: ${detail}` : 'OpenAI image generation failed without an error message.');
}

function extractCodexAccountId(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) throw new Error('Invalid token');
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const auth = isRecord(payload) ? payload['https://api.openai.com/auth'] : undefined;
    const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
    if (typeof accountId !== 'string' || !accountId) throw new Error('Missing account id');
    return accountId;
  } catch {
    throw new Error('The OpenAI Codex sign-in token is not valid for image generation. Sign in again, then retry.');
  }
}

function secureImageBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Image provider base URLs must be valid absolute URLs.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Image provider base URLs must use HTTP or HTTPS.');
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLocaleLowerCase();
  const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
  if (parsed.protocol === 'http:' && !loopback) {
    throw new Error('Image provider credentials require HTTPS. Plain HTTP is allowed only for loopback model servers.');
  }
  return value.replace(/\/+$/u, '');
}

function responsesUrl(baseUrl: string | undefined, codex: boolean): string {
  const fallback = codex ? 'https://chatgpt.com/backend-api' : 'https://api.openai.com/v1';
  const normalized = secureImageBaseUrl(baseUrl?.trim() || fallback);
  if (codex) {
    if (normalized.endsWith('/codex/responses')) return normalized;
    if (normalized.endsWith('/codex')) return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
  }
  return normalized.endsWith('/responses') ? normalized : `${normalized}/responses`;
}

function applyHeaders(target: Headers, source: Record<string, string | null> | undefined): void {
  for (const [name, value] of Object.entries(source ?? {})) {
    if (value === null) target.delete(name);
    else target.set(name, value);
  }
}

function parseSseFrame(frame: string): unknown | undefined {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data || data === '[DONE]') return undefined;
  try {
    return JSON.parse(data);
  } catch {
    throw new Error('OpenAI returned malformed image-generation stream data.');
  }
}

function streamEventError(event: Record<string, unknown>): Error | null {
  if (event.type === 'error') {
    const nested = isRecord(event.error) ? event.error : undefined;
    return imageGenerationError(event.code ?? nested?.code, event.message ?? nested?.message);
  }
  if (event.type !== 'response.failed') return null;
  const response = isRecord(event.response) ? event.response : undefined;
  const error = isRecord(response?.error) ? response.error : undefined;
  return imageGenerationError(error?.code, error?.message);
}

function setStreamImageData(result: ImageStreamResult, data: string): void {
  if (data.length > MAX_BASE64_CHARACTERS) throw new Error('OpenAI generated an image larger than Fate UI can safely display.');
  result.data = data;
}

function consumeImageEvent(event: unknown, result: ImageStreamResult): void {
  if (!isRecord(event)) return;
  const failure = streamEventError(event);
  if (failure) throw failure;
  if (event.type === 'response.image_generation_call.partial_image' && typeof event.partial_image_b64 === 'string') {
    setStreamImageData(result, event.partial_image_b64);
    return;
  }
  if (event.type !== 'response.output_item.done' || !isRecord(event.item) || event.item.type !== 'image_generation_call') return;
  if (typeof event.item.result === 'string') setStreamImageData(result, event.item.result);
  if (typeof event.item.id === 'string') result.imageId = event.item.id.slice(0, 200);
  if (event.item.output_format === 'png' || event.item.output_format === 'jpeg' || event.item.output_format === 'webp') {
    result.outputFormat = event.item.output_format;
  }
  if (typeof event.item.revised_prompt === 'string') result.revisedPrompt = event.item.revised_prompt.slice(0, MAX_IMAGE_PROMPT_CHARACTERS);
}

async function readImageStream(response: Response): Promise<ImageStreamResult> {
  if (!response.body) throw new Error('OpenAI image generation returned no response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const result: ImageStreamResult = { data: '' };
  let buffer = '';
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.value) {
        totalBytes += chunk.value.byteLength;
        if (totalBytes > MAX_IMAGE_RESPONSE_BYTES) throw new Error('OpenAI returned an oversized image-generation stream.');
      }
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      buffer = buffer.replace(/\r\n/gu, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        consumeImageEvent(parseSseFrame(frame), result);
        boundary = buffer.indexOf('\n\n');
      }
      if (chunk.done) break;
    }
    if (buffer.trim()) consumeImageEvent(parseSseFrame(buffer), result);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!result.data) throw new Error('OpenAI completed the request without returning an image.');
  return result;
}

async function readResponseTextLimited(response: Response, maximumBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      const remaining = maximumBytes - totalBytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(Buffer.from(value.subarray(0, remaining)));
          totalBytes += remaining;
        }
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(Buffer.from(value));
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks, totalBytes).toString('utf8'), truncated };
}

async function responseFailure(response: Response): Promise<Error> {
  const { text: raw, truncated } = await readResponseTextLimited(response, MAX_ERROR_BYTES);
  if (!truncated) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
      return imageGenerationError(error?.code ?? error?.type, error?.message, response.status);
    } catch {
      // Fall through to the bounded plain-text error.
    }
  }
  return imageGenerationError(undefined, `${raw}${truncated ? '…' : ''}` || response.statusText, response.status);
}

function requestSignal(signal: AbortSignal | undefined): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timeoutReached = false;
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, IMAGE_GENERATION_TIMEOUT_MS);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    },
  };
}

export function createOpenAIImageGenerator(fetchImage: typeof fetch = fetch, imageModel = 'gpt-image-2'): RasterImageGenerator {
  return async ({ prompt, size, quality, outputFormat, signal, context }) => {
    const model = context.model;
    if (!model || (model.api !== 'openai-codex-responses' && model.api !== 'openai-responses')) {
      throw new Error('Image generation requires an active OpenAI Responses or OpenAI Codex model. Select a supported OpenAI model, then retry.');
    }
    const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`OpenAI image generation is unavailable: ${auth.error}`);
    if (!auth.apiKey) throw new Error('OpenAI image generation requires an authenticated OpenAI account. Sign in, then retry.');

    const codex = model.api === 'openai-codex-responses';
    const headers = new Headers();
    applyHeaders(headers, model.headers);
    applyHeaders(headers, auth.headers);
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${auth.apiKey}`);
    headers.set('Accept', 'text/event-stream');
    headers.set('Content-Type', 'application/json');
    const requestId = randomUUID();
    if (codex) {
      headers.set('chatgpt-account-id', extractCodexAccountId(auth.apiKey));
      headers.set('originator', 'pi');
      headers.set('OpenAI-Beta', 'responses=experimental');
      headers.set('session-id', requestId);
      headers.set('x-client-request-id', requestId);
    }

    const combined = requestSignal(signal);
    try {
      const response = await fetchImage(responsesUrl(model.baseUrl, codex), {
        method: 'POST',
        headers,
        redirect: 'error',
        body: JSON.stringify({
          model: model.id,
          store: false,
          stream: true,
          instructions: 'Generate the requested raster image with the hosted OpenAI image generation tool. Do not return SVG, HTML, code, or a text-only description.',
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
          tools: [{
            type: 'image_generation',
            action: 'generate',
            model: imageModel,
            moderation: 'auto',
            output_compression: 100,
            size,
            quality,
            output_format: outputFormat,
          }],
          tool_choice: { type: 'image_generation' },
          parallel_tool_calls: false,
        }),
        signal: combined.signal,
      });
      if (!response.ok) throw await responseFailure(response);
      const streamed = await readImageStream(response);
      return {
        data: streamed.data,
        mimeType: mimeTypeFor(streamed.outputFormat ?? outputFormat),
        ...(streamed.revisedPrompt ? { revisedPrompt: streamed.revisedPrompt } : {}),
        provider: model.provider,
        model: model.id,
        imageModel,
        ...(streamed.imageId ? { imageId: streamed.imageId } : {}),
        requestId: response.headers.get('x-request-id') ?? requestId,
      };
    } catch (error) {
      if (signal?.aborted) throw new Error('Image generation was cancelled.');
      if (combined.timedOut()) throw new Error('OpenAI image generation timed out after 3 minutes. Try a lower quality or smaller image.');
      throw error;
    } finally {
      combined.dispose();
    }
  };
}

interface ResolvedImageProvider {
  source: Exclude<ImageGenerationProviderId, 'auto'>;
  providerId: string;
  imageModel: string;
  driver: ImageDriverModel;
}

function resolveImageProvider(settings: ImageGenerationSettings, context: ImageToolContext): ResolvedImageProvider {
  const available = context.modelRegistry.getAvailable();
  let source = settings.provider;
  if (source === 'auto') {
    source = (['openai-codex', 'openai', 'google', 'openrouter'] as const)
      .find((candidate) => available.some((model) => model.provider === candidate))
      ?? 'openai-codex';
  }
  const preset = imageGenerationPreset(source);
  const providerId = source === 'custom' ? settings.customProvider : preset?.providerId;
  if (!providerId) throw new Error('Choose a Pi provider for custom image generation in Settings → Agent.');
  const providerModels = available.filter((model) => model.provider === providerId);
  if (source === 'custom' && providerModels.length > 0 && !providerModels.some((model) => isOpenAICompatibleImageApi(model.api))) {
    throw new Error(`Pi provider ${providerId} is not configured with an OpenAI-compatible API. Use openai-completions or openai-responses in ~/.pi/agent/models.json.`);
  }
  const compatibleDriver = (model: ImageDriverModel) => source !== 'custom' || isOpenAICompatibleImageApi(model.api);
  const driver = (context.model?.provider === providerId && compatibleDriver(context.model) ? context.model : undefined)
    ?? providerModels.find(compatibleDriver);
  if (!driver) {
    throw new Error(`Image generation needs an authenticated ${providerId} provider in Pi. Sign in with Pi /login or configure it in ~/.pi/agent/models.json, then retry.`);
  }
  const requestedModel = settings.provider === source ? settings.model : null;
  const imageModel = source === 'custom'
    ? requestedModel
    : preset?.models.some((model) => model.id === requestedModel)
      ? requestedModel
      : defaultImageGenerationModel(source);
  if (!imageModel) throw new Error('Choose an image model in Settings → Agent, then retry.');
  return { source, providerId, imageModel, driver };
}

function imageBaseUrl(selection: ResolvedImageProvider, context: ImageToolContext): string {
  const providerBaseUrl = context.modelRegistry.getProvider(selection.providerId)?.baseUrl;
  const fallback = selection.source === 'openai-codex'
    ? 'https://chatgpt.com/backend-api'
    : selection.source === 'openai'
      ? 'https://api.openai.com/v1'
      : selection.source === 'google'
        ? 'https://generativelanguage.googleapis.com/v1beta'
        : selection.source === 'openrouter'
          ? 'https://openrouter.ai/api/v1'
          : undefined;
  const value = selection.driver.baseUrl?.trim() || providerBaseUrl?.trim() || fallback;
  if (!value) throw new Error(`Pi provider ${selection.providerId} does not define a base URL.`);
  return secureImageBaseUrl(value);
}

function endpointUrl(baseUrl: string, suffix: string): string {
  const normalizedSuffix = suffix.replace(/^\/+|\/+$/gu, '');
  return baseUrl.endsWith(`/${normalizedSuffix}`) ? baseUrl : `${baseUrl}/${normalizedSuffix}`;
}

async function resolvedProviderHeaders(selection: ResolvedImageProvider, context: ImageToolContext): Promise<{ headers: Headers; apiKey?: string }> {
  const auth = await context.modelRegistry.getApiKeyAndHeaders(selection.driver);
  if (!auth.ok) throw new Error(`${selection.providerId} image generation is unavailable: ${auth.error}`);
  if (!auth.apiKey && selection.source !== 'custom') {
    throw new Error(`${selection.providerId} image generation is not authenticated in Pi. Sign in with Pi /login, then retry.`);
  }
  const headers = new Headers();
  applyHeaders(headers, selection.driver.headers);
  applyHeaders(headers, auth.headers);
  headers.set('Accept', 'application/json');
  headers.set('Content-Type', 'application/json');
  return { headers, ...(auth.apiKey ? { apiKey: auth.apiKey } : {}) };
}

async function providerFailure(response: Response, provider: string): Promise<Error> {
  const { text: raw, truncated } = await readResponseTextLimited(response, MAX_ERROR_BYTES);
  if (!truncated) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
      const detail = typeof error?.message === 'string' ? error.message : raw;
      return new Error(`${provider} image generation failed (${response.status}): ${detail || response.statusText}`);
    } catch {
      // Fall through to the bounded plain-text error.
    }
  }
  const detail = `${raw}${truncated ? '…' : ''}` || response.statusText || 'Request failed';
  return new Error(`${provider} image generation failed (${response.status}): ${detail}`);
}

async function imageJson(response: Response, provider: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw await providerFailure(response, provider);
  const { text: raw, truncated } = await readResponseTextLimited(response, MAX_IMAGE_RESPONSE_BYTES);
  if (truncated) throw new Error(`${provider} returned an oversized image response.`);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new Error(`${provider} returned malformed image-generation JSON.`);
  }
}

function responseRasterMime(value: unknown, fallback: ImageOutputFormat): RasterMimeType {
  if (value === 'image/png') return 'image/png';
  if (value === 'image/jpeg' || value === 'image/jpg') return 'image/jpeg';
  if (value === 'image/webp') return 'image/webp';
  if (typeof value === 'string' && value.startsWith('image/')) throw new Error(`The image provider returned unsupported raster type ${value}.`);
  return mimeTypeFor(fallback);
}

function rasterMimeFromBase64(data: string, declared: unknown, fallback: ImageOutputFormat): RasterMimeType {
  const prefix = Buffer.from(data.slice(0, 32), 'base64');
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg';
  if (prefix.length >= 12 && prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return responseRasterMime(declared, fallback);
}

function firstImageData(body: Record<string, unknown>): { data: string; mimeType?: unknown; revisedPrompt?: string } {
  const data = Array.isArray(body.data) ? body.data : [];
  const first = data.find((item) => isRecord(item) && typeof item.b64_json === 'string');
  if (!isRecord(first) || typeof first.b64_json !== 'string') throw new Error('The image provider completed without returning base64 image data.');
  return {
    data: first.b64_json,
    mimeType: first.mime_type ?? first.media_type,
    ...(typeof first.revised_prompt === 'string' ? { revisedPrompt: first.revised_prompt.slice(0, MAX_IMAGE_PROMPT_CHARACTERS) } : {}),
  };
}

function openRouterImageData(body: Record<string, unknown>): { data: string; mimeType: RasterMimeType } {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice) || !isRecord(choice.message) || !Array.isArray(choice.message.images)) continue;
    for (const image of choice.message.images) {
      if (!isRecord(image)) continue;
      const imageUrl = typeof image.image_url === 'string'
        ? image.image_url
        : isRecord(image.image_url) && typeof image.image_url.url === 'string'
          ? image.image_url.url
          : undefined;
      if (!imageUrl?.startsWith('data:')) continue;
      const match = /^data:([^;,]+);base64,(.+)$/u.exec(imageUrl);
      if (!match?.[1] || !match[2]) continue;
      if (match[2].length > MAX_BASE64_CHARACTERS) throw new Error('OpenRouter generated an image larger than Fate UI can safely display.');
      return { data: match[2], mimeType: responseRasterMime(match[1], 'png') };
    }
  }
  throw new Error('OpenRouter completed without returning an image.');
}

function googleImageData(body: Record<string, unknown>): { data: string; mimeType?: unknown } {
  const candidates: Record<string, unknown>[] = [];
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 3 || candidates.length > 100) return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === 'image' && typeof value.data === 'string') candidates.push(value);
    for (const key of ['outputs', 'content', 'parts']) collect(value[key], depth + 1);
  };
  collect(body.output_image);
  collect(body.outputs);
  const image = candidates.at(-1);
  if (!image || typeof image.data !== 'string') throw new Error('Google Gemini completed without returning an image.');
  return { data: image.data, mimeType: image.mime_type };
}

async function withProviderTimeout(
  request: ImageGenerationRequest,
  provider: string,
  operation: (signal: AbortSignal) => Promise<GeneratedRasterImage>,
): Promise<GeneratedRasterImage> {
  const combined = requestSignal(request.signal);
  try {
    return await operation(combined.signal);
  } catch (error) {
    if (request.signal?.aborted) throw new Error('Image generation was cancelled.');
    if (combined.timedOut()) throw new Error(`${provider} image generation timed out after 3 minutes. Try a lower quality or smaller image.`);
    throw error;
  } finally {
    combined.dispose();
  }
}

function googleAspectRatio(size: ImageSize): string | undefined {
  if (size === '1024x1024') return '1:1';
  if (size === '1536x1024') return '3:2';
  if (size === '1024x1536') return '2:3';
  return undefined;
}

function googleImageSize(quality: ImageQuality, maxResolution: '1K' | '2K' | '4K' | undefined): string | undefined {
  if (quality === 'auto') return undefined;
  const requested = quality === 'high' ? '4K' : quality === 'medium' ? '2K' : '1K';
  const ranks = { '1K': 1, '2K': 2, '4K': 3 } as const;
  return maxResolution && ranks[requested] > ranks[maxResolution] ? maxResolution : requested;
}

export function createConfiguredImageGenerator(
  getSettings: ImageGenerationSettingsResolver = () => defaultImageGenerationSettings,
  fetchImage: typeof fetch = fetch,
): RasterImageGenerator {
  return async (request) => {
    const settings = getSettings();
    const selection = resolveImageProvider(settings, request.context);
    if (selection.source === 'openai-codex') {
      return createOpenAIImageGenerator(fetchImage, selection.imageModel)({
        ...request,
        context: { ...request.context, model: selection.driver },
      });
    }
    const { headers, apiKey } = await resolvedProviderHeaders(selection, request.context);
    const baseUrl = imageBaseUrl(selection, request.context);
    if (selection.source === 'google') {
      if (apiKey && !headers.has('x-goog-api-key')) headers.set('x-goog-api-key', apiKey);
      const presetModel = imageGenerationPreset('google')?.models.find((model) => model.id === selection.imageModel);
      return withProviderTimeout(request, 'Google Gemini', async (signal) => {
        const response = await fetchImage(endpointUrl(baseUrl, 'interactions'), {
          method: 'POST', headers, signal, redirect: 'error',
          body: JSON.stringify({
            model: selection.imageModel,
            input: [{ type: 'text', text: request.prompt }],
            response_format: {
              type: 'image',
              mime_type: mimeTypeFor(request.outputFormat),
              ...(googleAspectRatio(request.size) ? { aspect_ratio: googleAspectRatio(request.size) } : {}),
              ...(googleImageSize(request.quality, presetModel?.maxResolution) ? { image_size: googleImageSize(request.quality, presetModel?.maxResolution) } : {}),
            },
          }),
        });
        const body = await imageJson(response, 'Google Gemini');
        const image = googleImageData(body);
        return {
          data: image.data,
          mimeType: rasterMimeFromBase64(image.data, image.mimeType, request.outputFormat),
          provider: selection.providerId,
          model: selection.imageModel,
          imageModel: selection.imageModel,
          ...(typeof body.id === 'string' ? { imageId: body.id.slice(0, 200) } : {}),
          ...(response.headers.get('x-request-id') ? { requestId: response.headers.get('x-request-id')! } : {}),
        };
      });
    }
    if (apiKey && selection.source !== 'custom' && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${apiKey}`);
    if (selection.source === 'openrouter') {
      return withProviderTimeout(request, 'OpenRouter', async (signal) => {
        const response = await fetchImage(endpointUrl(baseUrl, 'chat/completions'), {
          method: 'POST', headers, signal, redirect: 'error',
          body: JSON.stringify({
            model: selection.imageModel,
            messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
            stream: false,
            modalities: ['image'],
          }),
        });
        const responseBody = await imageJson(response, 'OpenRouter');
        const image = openRouterImageData(responseBody);
        return {
          data: image.data,
          mimeType: rasterMimeFromBase64(image.data, image.mimeType, request.outputFormat),
          provider: selection.providerId,
          model: selection.imageModel,
          imageModel: selection.imageModel,
          ...(typeof responseBody.id === 'string' ? { imageId: responseBody.id.slice(0, 200) } : {}),
          ...(response.headers.get('x-request-id') ? { requestId: response.headers.get('x-request-id')! } : {}),
        };
      });
    }
    const providerName = selection.source === 'openai' ? 'OpenAI' : selection.providerId;
    const requestBody = selection.source === 'custom'
      ? {
        model: selection.imageModel,
        prompt: request.prompt,
        n: 1,
        response_format: 'b64_json',
        ...(request.size !== 'auto' ? { size: request.size } : {}),
        ...(request.quality !== 'auto' ? { quality: request.quality } : {}),
        output_format: request.outputFormat,
      }
      : {
        model: selection.imageModel,
        prompt: request.prompt,
        n: 1,
        size: request.size,
        quality: request.quality,
        output_format: request.outputFormat,
      };
    return withProviderTimeout(request, providerName, async (signal) => {
      const response = await fetchImage(endpointUrl(baseUrl, 'images/generations'), {
        method: 'POST', headers, signal, redirect: 'error',
        body: JSON.stringify(requestBody),
      });
      const responseBody = await imageJson(response, providerName);
      const image = firstImageData(responseBody);
      return {
        data: image.data,
        mimeType: rasterMimeFromBase64(image.data, image.mimeType, request.outputFormat),
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
        provider: selection.providerId,
        model: selection.imageModel,
        imageModel: selection.imageModel,
        ...(typeof responseBody.id === 'string' ? { imageId: responseBody.id.slice(0, 200) } : {}),
        ...(response.headers.get('x-request-id') ? { requestId: response.headers.get('x-request-id')! } : {}),
      };
    });
  };
}

export function createGenerateImageTool(
  generator: RasterImageGenerator = createConfiguredImageGenerator(),
  store: GeneratedImageStore = saveGeneratedImage,
) {
  return defineTool({
    name: 'generate_image',
    label: 'Generate image',
    description: 'Generate a real raster image with the image provider configured in Fate UI and return it directly in chat. Uses Pi-managed authentication and produces PNG, JPEG, or WebP—not SVG or code.',
    promptSnippet: 'Generate a real PNG, JPEG, or WebP image with the configured Pi-authenticated image provider',
    promptGuidelines: [
      'When the user directly asks for an image, call generate_image immediately instead of searching skills, websites, browsers, or MCP tools.',
      'Never substitute SVG, HTML, CSS, ASCII art, a browser screenshot, or a text-only description for generate_image.',
      'Use one generation per user request unless the user explicitly asks for multiple variants.',
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: MAX_IMAGE_PROMPT_CHARACTERS, description: 'Detailed natural-language description of the image to generate.' }),
      size: Type.Optional(Type.Union([
        Type.Literal('auto'), Type.Literal('1024x1024'), Type.Literal('1536x1024'), Type.Literal('1024x1536'),
      ], { description: 'Output dimensions. Use auto unless the user requests square, landscape, or portrait.' })),
      quality: Type.Optional(Type.Union([
        Type.Literal('auto'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'),
      ], { description: 'Rendering quality. Use auto unless the user requests a draft or high quality.' })),
      outputFormat: Type.Optional(Type.Union([
        Type.Literal('png'), Type.Literal('jpeg'), Type.Literal('webp'),
      ], { description: 'Raster output format. PNG is the default.' })),
      alt: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Concise accessible description of the generated image.' })),
    }),
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (signal?.aborted) throw new Error('Image generation was cancelled.');
      const size = params.size ?? 'auto';
      const quality = params.quality ?? 'auto';
      const outputFormat = params.outputFormat ?? 'png';
      const generated = await generator({
        prompt: params.prompt,
        size,
        quality,
        outputFormat,
        signal,
        context,
      });
      if (signal?.aborted) throw new Error('Image generation was cancelled.');
      if (!generated.data || generated.data.length > MAX_BASE64_CHARACTERS) throw new Error('Generated image output is empty or exceeds 10 MB.');
      const image = Buffer.from(generated.data, 'base64');
      const dimensions = encodedImageSize(image, generated.mimeType);
      if (
        !dimensions
        || image.length === 0
        || image.length > MAX_PROMPT_IMAGE_BYTES
        || dimensions.width <= 0
        || dimensions.height <= 0
        || dimensions.width > MAX_PROMPT_IMAGE_DIMENSION
        || dimensions.height > MAX_PROMPT_IMAGE_DIMENSION
        || dimensions.width * dimensions.height > MAX_PROMPT_IMAGE_TOTAL_PIXELS
      ) {
        throw new Error('The image provider returned a malformed, unsupported, or oversized raster image.');
      }
      let displayedImage: Buffer = image;
      let savedPath: string | null = null;
      let metadataPath: string | null = null;
      let saveWarning: string | null = null;
      try {
        const stored = await store({
          image,
          dimensions,
          generated,
          prompt: params.prompt,
          size,
          quality,
          outputFormat,
          sessionId: context.sessionManager.getSessionId(),
        });
        displayedImage = stored.image;
        savedPath = stored.savedPath;
        metadataPath = stored.metadataPath;
        saveWarning = stored.warning;
      } catch {
        saveWarning = 'Image generated, but Fate UI could not save it under Pi\'s generated-images directory.';
      }
      const alt = params.alt?.trim();
      const summary = alt ? `Generated image: ${alt}` : 'Generated image';
      const text = [
        summary,
        savedPath ? `Saved to: ${savedPath}` : undefined,
        saveWarning ? `Save warning: ${saveWarning}` : undefined,
      ].filter((line): line is string => Boolean(line)).join('\n');
      return {
        content: [
          { type: 'text', text },
          { type: 'image', data: displayedImage.toString('base64'), mimeType: generated.mimeType },
        ],
        details: {
          width: dimensions.width,
          height: dimensions.height,
          bytes: displayedImage.length,
          mimeType: generated.mimeType,
          alt: alt || null,
          provider: generated.provider,
          model: generated.model,
          imageModel: generated.imageModel ?? 'gpt-image-2',
          revisedPrompt: generated.revisedPrompt ?? null,
          requestId: generated.requestId ?? null,
          savedPath,
          metadataPath,
          saveWarning,
        },
      };
    },
  });
}
