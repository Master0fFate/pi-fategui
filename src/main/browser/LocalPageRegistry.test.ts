import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_PAGE_CONTENT_SECURITY_POLICY, LocalPageRegistry } from './LocalPageRegistry';

vi.mock('electron', () => ({
  net: { fetch: vi.fn(async () => new Response('fixture', { status: 200, headers: { 'content-type': 'text/html' } })) },
}));

const temporaryRoots: string[] = [];

async function temporaryProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'fate-local-pages-'));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'preview'), { recursive: true });
  await writeFile(path.join(root, 'preview/index.html'), '<!doctype html><title>Preview</title>');
  await writeFile(path.join(root, 'preview/asset.js'), 'globalThis.preview = true;');
  await writeFile(path.join(root, 'preview/private.txt'), 'not an executable preview asset');
  await writeFile(path.join(root, 'private.txt'), 'not part of the preview');
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalPageRegistry capabilities', () => {
  it('binds a local capability to one tab and the entry file directory', async () => {
    const root = await temporaryProject();
    const registry = new LocalPageRegistry(root);
    const entry = path.join(root, 'preview/index.html');

    const location = await registry.open('tab-1', entry, 'agent');

    const canonicalEntry = await realpath(entry);
    expect(location.internalUrl).toMatch(/^fate-local:\/\/[a-f0-9]{48}\/index\.html$/u);
    expect(location.origin).toMatch(/^fate-local:\/\/[a-f0-9]{48}$/u);
    expect(location.entryPath).toBe(canonicalEntry);
    expect(registry.displayUrl(location.internalUrl, 'tab-1')).toBe(pathToFileURL(canonicalEntry).href);
    expect(registry.displayUrl(location.internalUrl, 'tab-2')).toBeNull();

    const siblingAttempt = new URL(location.internalUrl);
    siblingAttempt.pathname = '/private.txt';
    const canonicalSibling = await realpath(path.join(root, 'preview/private.txt'));
    expect(registry.displayUrl(siblingAttempt.href, 'tab-1')).toBe(pathToFileURL(canonicalSibling).href);
  });

  it('isolates local documents from outbound content and requires same-capability resource referrers', async () => {
    const root = await temporaryProject();
    const registry = new LocalPageRegistry(root);
    const location = await registry.open('tab-1', path.join(root, 'preview/index.html'), 'agent');
    const handle = (registry as unknown as { handle(request: Request): Promise<Response> }).handle.bind(registry);

    const entryResponse = await handle({
      method: 'GET', url: location.internalUrl, referrer: '', headers: new Headers(),
    } as Request);
    expect(entryResponse.status).toBe(200);
    expect(entryResponse.headers.get('content-security-policy')).toBe(LOCAL_PAGE_CONTENT_SECURITY_POLICY);
    expect(entryResponse.headers.get('x-dns-prefetch-control')).toBe('off');

    const assetUrl = new URL('asset.js', location.internalUrl).href;
    await expect(handle({ method: 'GET', url: assetUrl, referrer: '', headers: new Headers() } as Request))
      .resolves.toMatchObject({ status: 200 });
    const privateUrl = new URL('private.txt', location.internalUrl).href;
    await expect(handle({ method: 'GET', url: privateUrl, referrer: '', headers: new Headers() } as Request))
      .resolves.toMatchObject({ status: 403 });
    await expect(handle({ method: 'GET', url: assetUrl, referrer: location.internalUrl, headers: new Headers() } as Request))
      .resolves.toMatchObject({ status: 200 });
    await expect(handle({
      method: 'GET', url: assetUrl, referrer: '', headers: new Headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'script' }),
    } as Request)).resolves.toMatchObject({ status: 200 });
  });

  it('revokes a local capability after its tab commits a different top-level document', async () => {
    const root = await temporaryProject();
    const registry = new LocalPageRegistry(root);
    const location = await registry.open('tab-1', path.join(root, 'preview/index.html'), 'agent');

    registry.retainForNavigation('tab-1', 'https://example.test/');

    expect(registry.displayUrl(location.internalUrl, 'tab-1')).toBeNull();
  });

  it('blocks agent-opened files outside the trusted project while allowing an explicit user open', async () => {
    const project = await temporaryProject();
    const external = await mkdtemp(path.join(tmpdir(), 'fate-local-external-'));
    temporaryRoots.push(external);
    const entry = path.join(external, 'index.html');
    await writeFile(entry, '<!doctype html><title>External</title>');
    const registry = new LocalPageRegistry(project);

    await expect(registry.open('tab-1', entry, 'agent')).rejects.toThrow(/trusted project/iu);
    const canonicalEntry = await realpath(entry);
    await expect(registry.open('tab-1', entry, 'user')).resolves.toMatchObject({
      displayUrl: pathToFileURL(canonicalEntry).href,
      entryPath: canonicalEntry,
    });
  });
});
