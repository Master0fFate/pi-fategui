// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createConfiguredImageGenerator, createGenerateImageTool, createOpenAIImageGenerator } from './PiImageTool';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function codexContext() {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
  })).toString('base64url');
  return {
    cwd: '/project',
    sessionManager: { getSessionId: () => 'session-1' },
    model: {
      provider: 'openai-codex',
      id: 'gpt-5.6-sol',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      headers: {},
    },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: `e30.${payload}.signature`, headers: {} })),
      getProviderAuth: vi.fn(async () => ({ auth: { apiKey: `e30.${payload}.signature` }, source: 'OAuth' })),
    },
  };
}

function sse(...events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 });
}

function oversizedStreamResponse() {
  let pulls = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024).fill(0x61);
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 200 });
  return { response, pulls: () => pulls, cancelled: () => cancelled };
}

function providerContext(provider: string, baseUrl: string, apiKey = 'provider-key', api = 'openai-responses') {
  const driver = { provider, id: 'driver-model', api, baseUrl, headers: {} };
  return {
    cwd: '/project',
    sessionManager: { getSessionId: () => 'session-1' },
    model: { provider: 'anthropic', id: 'claude', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', headers: {} },
    modelRegistry: {
      getAvailable: vi.fn(() => [driver]),
      getProvider: vi.fn(() => ({ id: provider, name: provider, baseUrl, headers: {} })),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey, headers: {} })),
      getProviderAuth: vi.fn(async () => ({ auth: { apiKey, baseUrl, headers: {} as Record<string, string> }, source: 'Pi credential' })),
    },
  };
}

describe('generate_image tool', () => {
  it('asks a raster generator for an image and returns a typed PNG block', async () => {
    const generator = vi.fn(async () => ({
      data: png,
      mimeType: 'image/png' as const,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      revisedPrompt: 'A polished moonlit fox',
    }));
    const store = vi.fn(async ({ image }: { image: Buffer }) => ({
      image,
      savedPath: 'C:\\Users\\fate\\.pi\\agent\\generated-images\\session-1\\fox.png',
      metadataPath: 'C:\\Users\\fate\\.pi\\agent\\generated-images\\session-1\\fox.json',
      warning: null,
    }));
    const tool = createGenerateImageTool(generator, store);
    const context = codexContext();
    const result = await tool.execute('image-1', { prompt: 'A moonlit fox', alt: 'Moonlit fox' }, undefined, undefined, context as never);

    expect(generator).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'A moonlit fox', size: 'auto', quality: 'auto', outputFormat: 'png', context,
    }));
    expect(store).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', prompt: 'A moonlit fox' }));
    expect(result.content).toEqual([
      { type: 'text', text: 'Generated image: Moonlit fox\nSaved to: C:\\Users\\fate\\.pi\\agent\\generated-images\\session-1\\fox.png' },
      { type: 'image', data: png, mimeType: 'image/png' },
    ]);
    expect(result.details).toMatchObject({
      width: 1,
      height: 1,
      mimeType: 'image/png',
      provider: 'openai-codex',
      imageModel: 'gpt-image-2',
      savedPath: 'C:\\Users\\fate\\.pi\\agent\\generated-images\\session-1\\fox.png',
    });
    expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('prompt');
    expect((tool.parameters as { properties: Record<string, unknown> }).properties).not.toHaveProperty('svg');
  });

  it('calls the hosted OpenAI image_generation tool with active Codex OAuth', async () => {
    let requestedUrl: string | URL | Request | undefined;
    let requestedInit: RequestInit | undefined;
    const fetchImage = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = input;
      requestedInit = init;
      return sse(
        { type: 'response.output_item.done', item: { id: 'ig_1', type: 'image_generation_call', status: 'generating', result: png, output_format: 'png', revised_prompt: 'A moonlit fox' } },
        { type: 'response.completed', response: { status: 'completed', output: [] } },
      );
    });
    const generator = createOpenAIImageGenerator(fetchImage as unknown as typeof fetch);
    const context = codexContext();
    const generated = await generator({
      prompt: 'A moonlit fox', size: '1024x1024', quality: 'low', outputFormat: 'png', signal: undefined, context: context as never,
    });

    expect(generated).toMatchObject({ data: png, mimeType: 'image/png', imageId: 'ig_1', revisedPrompt: 'A moonlit fox' });
    expect(requestedUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(requestedInit?.redirect).toBe('error');
    const headers = new Headers(requestedInit?.headers);
    expect(headers.get('authorization')).toMatch(/^Bearer /u);
    expect(headers.get('chatgpt-account-id')).toBe('account-1');
    const body = JSON.parse(String(requestedInit?.body));
    expect(body.tools).toEqual([{
      type: 'image_generation',
      action: 'generate',
      model: 'gpt-image-2',
      moderation: 'auto',
      output_compression: 100,
      size: '1024x1024',
      quality: 'low',
      output_format: 'png',
    }]);
    expect(body.tool_choice).toEqual({ type: 'image_generation' });
  });

  it('uses ChatGPT OAuth from Pi even when the active chat model is not OpenAI', async () => {
    const payload = Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' },
    })).toString('base64url');
    let requestedUrl = '';
    const fetchImage = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return sse({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: png, output_format: 'png' } });
    });
    const generator = createConfiguredImageGenerator(
      () => ({ provider: 'openai-codex', model: 'gpt-image-2', customProvider: null }),
      fetchImage as unknown as typeof fetch,
    );
    const context = providerContext('openai-codex', 'https://chatgpt.com/backend-api', `e30.${payload}.signature`, 'openai-codex-responses');

    const generated = await generator({ prompt: 'A fox', size: 'auto', quality: 'auto', outputFormat: 'png', signal: undefined, context: context as never });

    expect(requestedUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(generated).toMatchObject({ provider: 'openai-codex', imageModel: 'gpt-image-2', data: png });
  });

  it('keeps automatic image routing on its fixed provider priority instead of following the chat model', async () => {
    const openAI = { provider: 'openai', id: 'gpt-5.6', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', headers: {} };
    const openRouter = { provider: 'openrouter', id: 'openrouter-chat', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', headers: {} };
    let requestedUrl = '';
    const fetchImage = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200 });
    });
    const generator = createConfiguredImageGenerator(
      () => ({ provider: 'auto', model: null, customProvider: null }),
      fetchImage as unknown as typeof fetch,
    );
    const context = {
      cwd: '/project',
      sessionManager: { getSessionId: () => 'session-1' },
      model: openRouter,
      modelRegistry: {
        getAvailable: vi.fn(() => [openRouter, openAI]),
        getProvider: vi.fn((provider: string) => ({ id: provider, name: provider, baseUrl: provider === 'openai' ? openAI.baseUrl : openRouter.baseUrl, headers: {} })),
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: 'provider-key', headers: {} })),
        getProviderAuth: vi.fn(async (provider: string) => ({ auth: { apiKey: 'provider-key', baseUrl: provider === 'openai' ? openAI.baseUrl : openRouter.baseUrl }, source: 'Pi credential' })),
      },
    };

    const generated = await generator({ prompt: 'A fox', size: 'auto', quality: 'auto', outputFormat: 'png', signal: undefined, context: context as never });

    expect(requestedUrl).toBe('https://api.openai.com/v1/images/generations');
    expect(generated).toMatchObject({ provider: 'openai', imageModel: 'gpt-image-2' });
  });

  it('routes Gemini generation through the authenticated Pi provider instead of the active chat model', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const fetchImage = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({ id: 'interaction-1', outputs: [{ type: 'image', data: png, mime_type: 'image/png' }] }), { status: 200 });
    });
    const generator = createConfiguredImageGenerator(
      () => ({ provider: 'google', model: 'gemini-3.1-flash-image', customProvider: null }),
      fetchImage as unknown as typeof fetch,
    );
    const context = providerContext('google', 'https://generativelanguage.googleapis.com/v1beta');

    const generated = await generator({ prompt: 'A fox', size: '1536x1024', quality: 'high', outputFormat: 'png', signal: undefined, context: context as never });

    expect(requestedUrl).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(requestedInit?.redirect).toBe('error');
    expect(new Headers(requestedInit?.headers).get('x-goog-api-key')).toBe('provider-key');
    expect(JSON.parse(String(requestedInit?.body))).toMatchObject({
      model: 'gemini-3.1-flash-image',
      response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: '3:2', image_size: '4K' },
    });
    expect(generated).toMatchObject({ provider: 'google', model: 'gemini-3.1-flash-image', imageModel: 'gemini-3.1-flash-image', data: png });
  });

  it('uses a custom Pi provider base URL with a minimal vLLM-compatible Images request', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const fetchImage = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200 });
    });
    const generator = createConfiguredImageGenerator(
      () => ({ provider: 'custom', model: 'local-image-model', customProvider: 'local-images' }),
      fetchImage as unknown as typeof fetch,
    );
    const context = providerContext('local-images', 'http://127.0.0.1:8000/v1', 'local');

    const generated = await generator({ prompt: 'A fox', size: 'auto', quality: 'high', outputFormat: 'jpeg', signal: undefined, context: context as never });

    expect(requestedUrl).toBe('http://127.0.0.1:8000/v1/images/generations');
    expect(requestedInit?.redirect).toBe('error');
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      model: 'local-image-model', prompt: 'A fox', n: 1, response_format: 'b64_json', quality: 'high', output_format: 'jpeg',
    });
    expect(new Headers(requestedInit?.headers).has('authorization')).toBe(false);
    expect(generated).toMatchObject({ provider: 'local-images', model: 'local-image-model', mimeType: 'image/png', data: png });
  });

  it('preserves Pi-composed custom authentication headers without inventing Bearer auth', async () => {
    let requestedHeaders: Headers | undefined;
    const fetchImage = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200 });
    });
    const generator = createConfiguredImageGenerator(
      () => ({ provider: 'custom', model: 'private-image', customProvider: 'private-images' }),
      fetchImage as unknown as typeof fetch,
    );
    const context = providerContext('private-images', 'https://images.example/v1', 'secret');
    context.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
      ok: true as const,
      apiKey: 'secret',
      headers: { 'x-api-key': 'secret' },
    });

    await generator({ prompt: 'A fox', size: 'auto', quality: 'auto', outputFormat: 'png', signal: undefined, context: context as never });

    expect(requestedHeaders?.get('x-api-key')).toBe('secret');
    expect(requestedHeaders?.has('authorization')).toBe(false);
    expect(context.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(expect.objectContaining({ id: 'driver-model' }));
    expect(context.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
  });

  it('selects an OpenAI-compatible model when the active model on the custom provider uses another API', async () => {
    const incompatible = { provider: 'mixed', id: 'chat', api: 'anthropic-messages', baseUrl: 'https://mixed.example/v1', headers: {} };
    const compatible = { provider: 'mixed', id: 'image-driver', api: 'openai-responses', baseUrl: 'https://mixed.example/v1', headers: {} };
    const fetchImage = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200 }));
    const generator = createConfiguredImageGenerator(
      () => ({ provider: 'custom', model: 'deployed-image', customProvider: 'mixed' }),
      fetchImage as unknown as typeof fetch,
    );
    const context = providerContext('mixed', 'https://mixed.example/v1');
    context.model = incompatible;
    context.modelRegistry.getAvailable.mockReturnValue([incompatible, compatible]);

    const generated = await generator({ prompt: 'A fox', size: 'auto', quality: 'auto', outputFormat: 'png', signal: undefined, context: context as never });

    expect(generated).toMatchObject({ provider: 'mixed', model: 'deployed-image' });
    expect(context.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(compatible);
    expect(context.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
  });

  it('rejects credentialed plain HTTP image providers outside loopback before network egress', async () => {
    const fetchImage = vi.fn();
    const generator = createConfiguredImageGenerator(
      () => ({ provider: 'custom', model: 'remote-image', customProvider: 'remote-images' }),
      fetchImage as unknown as typeof fetch,
    );
    const context = providerContext('remote-images', 'http://images.example/v1', 'secret');

    await expect(generator({ prompt: 'A fox', size: 'auto', quality: 'auto', outputFormat: 'png', signal: undefined, context: context as never }))
      .rejects.toThrow(/require HTTPS/iu);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('rejects a custom provider that is not configured with an OpenAI-compatible API before network egress', async () => {
    const fetchImage = vi.fn();
    const generator = createConfiguredImageGenerator(
      () => ({ provider: 'custom', model: 'not-an-image-model', customProvider: 'anthropic' }),
      fetchImage as unknown as typeof fetch,
    );
    const context = providerContext('anthropic', 'https://api.anthropic.com', 'anthropic-key', 'anthropic-messages');

    await expect(generator({ prompt: 'A fox', size: 'auto', quality: 'auto', outputFormat: 'png', signal: undefined, context: context as never }))
      .rejects.toThrow(/not configured with an OpenAI-compatible API/iu);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('uses OpenRouter’s chat-completions image contract and parses returned data URLs', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const fetchImage = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({
        id: 'generation-1',
        choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }],
      }), { status: 200 });
    });
    const generator = createConfiguredImageGenerator(
      () => ({ provider: 'openrouter', model: 'openai/gpt-image-2', customProvider: null }),
      fetchImage as unknown as typeof fetch,
    );
    const context = providerContext('openrouter', 'https://openrouter.ai/api/v1', 'oauth-minted-key');

    const generated = await generator({ prompt: 'A fox', size: '1024x1024', quality: 'medium', outputFormat: 'png', signal: undefined, context: context as never });

    expect(requestedUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(requestedInit?.redirect).toBe('error');
    expect(new Headers(requestedInit?.headers).get('authorization')).toBe('Bearer oauth-minted-key');
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      model: 'openai/gpt-image-2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'A fox' }] }],
      stream: false,
      modalities: ['image'],
    });
    expect(generated).toMatchObject({ data: png, mimeType: 'image/png', imageId: 'generation-1' });
  });

  it('preserves Pi-composed authorization on a built-in image route', async () => {
    let requestedHeaders: Headers | undefined;
    const fetchImage = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        choices: [{ message: { images: [{ image_url: `data:image/png;base64,${png}` }] } }],
      }), { status: 200 });
    });
    const generator = createConfiguredImageGenerator(
      () => ({ provider: 'openrouter', model: 'openai/gpt-image-2', customProvider: null }),
      fetchImage as unknown as typeof fetch,
    );
    const context = providerContext('openrouter', 'https://openrouter.ai/api/v1', 'fallback-key');
    context.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
      ok: true as const,
      apiKey: 'fallback-key',
      headers: { Authorization: 'Api-Key pi-composed' },
    });

    await generator({ prompt: 'A fox', size: 'auto', quality: 'auto', outputFormat: 'png', signal: undefined, context: context as never });

    expect(requestedHeaders?.get('authorization')).toBe('Api-Key pi-composed');
  });

  it('rejects a cleartext non-loopback Codex base URL before sending credentials', async () => {
    const fetchImage = vi.fn();
    const context = codexContext();
    context.model.baseUrl = 'http://chatgpt.example/backend-api';
    const generator = createOpenAIImageGenerator(fetchImage as unknown as typeof fetch);

    await expect(generator({
      prompt: 'A fox', size: 'auto', quality: 'auto', outputFormat: 'png', signal: undefined, context: context as never,
    })).rejects.toThrow(/require HTTPS/iu);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('cancels an oversized OpenAI SSE response before buffering the full stream', async () => {
    const oversized = oversizedStreamResponse();
    const fetchImage = vi.fn(async () => oversized.response);
    const generator = createOpenAIImageGenerator(fetchImage as unknown as typeof fetch);

    await expect(generator({
      prompt: 'A fox', size: '1024x1024', quality: 'low', outputFormat: 'png', signal: undefined, context: codexContext() as never,
    })).rejects.toThrow(/oversized image-generation stream/iu);

    expect(oversized.cancelled()).toBe(true);
    expect(oversized.pulls()).toBeLessThan(32);
  });

  it('cancels an oversized JSON image response before reading the full provider body', async () => {
    const oversized = oversizedStreamResponse();
    const fetchImage = vi.fn(async () => oversized.response);
    const generator = createConfiguredImageGenerator(
      () => ({ provider: 'custom', model: 'local-image-model', customProvider: 'local-images' }),
      fetchImage as unknown as typeof fetch,
    );

    await expect(generator({
      prompt: 'A fox', size: 'auto', quality: 'auto', outputFormat: 'png', signal: undefined,
      context: providerContext('local-images', 'http://127.0.0.1:8000/v1') as never,
    })).rejects.toThrow(/oversized image response/iu);

    expect(oversized.cancelled()).toBe(true);
    expect(oversized.pulls()).toBeLessThan(32);
  });

  it('keeps a valid inline image when the optional disk copy cannot be saved', async () => {
    const generator = vi.fn(async () => ({ data: png, mimeType: 'image/png' as const, provider: 'openai-codex', model: 'gpt-5.6-sol' }));
    const store = vi.fn(async () => { throw new Error('disk full'); });
    const tool = createGenerateImageTool(generator, store);
    const result = await tool.execute('image-fallback', { prompt: 'A fox' }, undefined, undefined, codexContext() as never);

    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('could not save') },
      { type: 'image', data: png, mimeType: 'image/png' },
    ]);
    expect(result.details).toMatchObject({ savedPath: null, saveWarning: expect.stringContaining('could not save') });
  });

  it('rejects mislabeled SVG or malformed bytes instead of displaying them as raster output', async () => {
    const generator = vi.fn(async () => ({
      data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64'),
      mimeType: 'image/png' as const,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    }));
    const tool = createGenerateImageTool(generator);
    await expect(tool.execute('image-2', { prompt: 'Not SVG' }, undefined, undefined, codexContext() as never)).rejects.toThrow(/malformed|unsupported/iu);
  });

  it('honors cancellation before a billable generation begins', async () => {
    const generator = vi.fn(async () => ({ data: png, mimeType: 'image/png' as const, provider: 'openai', model: 'gpt-5.6' }));
    const tool = createGenerateImageTool(generator);
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute('image-3', { prompt: 'A fox' }, controller.signal, undefined, codexContext() as never)).rejects.toThrow('cancelled');
    expect(generator).not.toHaveBeenCalled();
  });
});
