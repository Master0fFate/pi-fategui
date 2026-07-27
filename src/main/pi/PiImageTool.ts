import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defineTool, getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_DIMENSION,
  MAX_PROMPT_IMAGE_TOTAL_PIXELS,
  encodedImageSize,
} from './PiPromptImages';

const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
const MAX_IMAGE_PROMPT_CHARACTERS = 32_000;
const MAX_ERROR_CHARACTERS = 8_000;
const MAX_BASE64_CHARACTERS = Math.ceil(MAX_PROMPT_IMAGE_BYTES / 3) * 4 + 4;

type RasterMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
type ImageOutputFormat = 'png' | 'jpeg' | 'webp';
type ImageQuality = 'auto' | 'low' | 'medium' | 'high';
type ImageSize = 'auto' | '1024x1024' | '1536x1024' | '1024x1536';
type ImageToolContext = Pick<ExtensionContext, 'cwd' | 'model' | 'modelRegistry' | 'sessionManager'>;

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
  const persistedImage = await fs.readFile(savedPath);
  const metadataPath = savedPath.replace(/\.[^.]+$/u, '.json');
  const metadata = {
    createdAt: new Date().toISOString(),
    prompt,
    provider: generated.provider,
    responseModel: generated.model,
    imageModel: 'gpt-image-2',
    imageId,
    savedPath,
    mimeType: generated.mimeType,
    width: dimensions.width,
    height: dimensions.height,
    size,
    quality,
    outputFormat,
    ...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
    ...(generated.requestId ? { requestId: generated.requestId } : {}),
  };
  try {
    await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return { image: persistedImage, savedPath, metadataPath, warning: null };
  } catch {
    return {
      image: persistedImage,
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

function responsesUrl(baseUrl: string | undefined, codex: boolean): string {
  const fallback = codex ? 'https://chatgpt.com/backend-api' : 'https://api.openai.com/v1';
  const normalized = (baseUrl?.trim() || fallback).replace(/\/+$/u, '');
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

function consumeImageEvent(event: unknown, result: ImageStreamResult): void {
  if (!isRecord(event)) return;
  const failure = streamEventError(event);
  if (failure) throw failure;
  if (event.type === 'response.image_generation_call.partial_image' && typeof event.partial_image_b64 === 'string') {
    result.data = event.partial_image_b64;
    return;
  }
  if (event.type !== 'response.output_item.done' || !isRecord(event.item) || event.item.type !== 'image_generation_call') return;
  if (typeof event.item.result === 'string') result.data = event.item.result;
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
  try {
    while (true) {
      const chunk = await reader.read();
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
  } finally {
    reader.releaseLock();
  }
  if (!result.data) throw new Error('OpenAI completed the request without returning an image.');
  if (result.data.length > MAX_BASE64_CHARACTERS) throw new Error('OpenAI generated an image larger than Fate UI can safely display.');
  return result;
}

async function responseFailure(response: Response): Promise<Error> {
  const raw = (await response.text()).slice(0, MAX_ERROR_CHARACTERS);
  try {
    const parsed: unknown = JSON.parse(raw);
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
    return imageGenerationError(error?.code ?? error?.type, error?.message, response.status);
  } catch {
    return imageGenerationError(undefined, raw || response.statusText, response.status);
  }
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

export function createOpenAIImageGenerator(fetchImage: typeof fetch = fetch): RasterImageGenerator {
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
    headers.set('Authorization', `Bearer ${auth.apiKey}`);
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
        body: JSON.stringify({
          model: model.id,
          store: false,
          stream: true,
          instructions: 'Generate the requested raster image with the hosted OpenAI image generation tool. Do not return SVG, HTML, code, or a text-only description.',
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
          tools: [{
            type: 'image_generation',
            action: 'generate',
            model: 'gpt-image-2',
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

export function createGenerateImageTool(
  generator: RasterImageGenerator = createOpenAIImageGenerator(),
  store: GeneratedImageStore = saveGeneratedImage,
) {
  return defineTool({
    name: 'generate_image',
    label: 'Generate image',
    description: 'Generate a real raster image with OpenAI GPT Image and return it directly in chat. Use this for requests to create, draw, render, or generate an image. This tool produces PNG, JPEG, or WebP—not SVG or code.',
    promptSnippet: 'Generate a real PNG, JPEG, or WebP image with OpenAI GPT Image',
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
        throw new Error('OpenAI returned a malformed, unsupported, or oversized raster image.');
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
          imageModel: 'gpt-image-2',
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
