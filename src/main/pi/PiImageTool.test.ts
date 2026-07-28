// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGenerateImageTool, createOpenAIImageGenerator } from './PiImageTool';

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
    },
  };
}

function sse(...events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 });
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
