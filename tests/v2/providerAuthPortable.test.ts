import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFateCore } from '../../src/core/createFateCore';
import { FatePaths } from '../../src/core/FatePaths';
import type { ProviderAuthUrlPort } from '../../src/core/ports';
import { FakePiSdkAdapter } from './helpers/fakePi';
import { privateTestRoot } from './helpers/isolatedEnvironment';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function login(url: string, presenter?: ProviderAuthUrlPort) {
  const root = await mkdtemp(path.join(privateTestRoot(), 'core-auth-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const paths = new FatePaths({ dataRoot: path.join(root, 'data'), piAgentDir: path.join(root, 'agent'), sessionsRoot: path.join(root, 'agent/sessions'), attachmentRoot: path.join(root, 'attachments'), lockRoot: path.join(root, 'locks'), profileId: 'auth-fixture' });
  const adapter = new FakePiSdkAdapter();
  const modelRuntime = await adapter.createModelRuntime();
  let interaction: Parameters<typeof modelRuntime.login>[2] | undefined;
  // Only provider interaction is faked: the actual core, multi-owner and Pi login state run.
  modelRuntime.login = async (_provider, _method, hostInteraction) => {
    interaction = hostInteraction;
    hostInteraction.notify({ type: 'auth_url', url });
    await hostInteraction.prompt({ type: 'manual_code', message: 'Fixture manual code' });
    throw new Error('Fixture has no real credentials');
  };
  const core = await createFateCore({ paths, adapter, ...(presenter ? { providerAuthUrlPresenter: presenter } : {}) });
  const service = core.runtime.asRouter();
  cleanup.push(async () => { service.cancelProviderLogin(); await core.dispose(); await adapter.dispose(); });
  await service.startProviderLogin({ providerId: 'openai-codex', method: 'oauth' });
  await vi.waitFor(() => expect(service.getState(false).providerLogin?.prompt?.type).toBe('manual_code'));
  return { service, emit: (event: Parameters<NonNullable<typeof interaction>['notify']>[0]) => {
    if (!interaction) throw new Error('No fixture login interaction');
    interaction.notify(event);
  } };
}

describe('portable provider auth URL presentation', () => {
  it('exposes the complete HTTPS URL without Electron or a claim that a browser opened', async () => {
    const url = 'https://provider.invalid/authorize?state=fixture';
    const { service, emit } = await login(url);
    expect(service.getState(false).providerLogin).toMatchObject({ status: 'working', message: url, prompt: { type: 'manual_code' } });
    emit({ type: 'progress', message: 'Waiting for provider callback' });
    expect(service.getState(false).providerLogin?.message).toBe(url);
    service.cancelProviderLogin();
    expect(service.getState(false).providerLogin).toMatchObject({ status: 'idle', message: null });
  });

  it('forwards the trusted presenter through MultiProjectPiRuntime and tolerates presentation failure', async () => {
    const present = vi.fn(async () => { throw new Error('desktop browser unavailable'); });
    const url = 'https://provider.invalid/authorize';
    const { service, emit } = await login(url, { present });
    expect(present).toHaveBeenCalledExactlyOnceWith(url);
    expect(service.getState(false).providerLogin?.message).toBe(url);
    emit({ type: 'device_code', verificationUri: 'https://provider.invalid/device', userCode: 'FIXTURE-CODE' });
    expect(present).toHaveBeenLastCalledWith('https://provider.invalid/device');
    expect(service.getState(false).providerLogin?.deviceCode).toMatchObject({ verificationUri: 'https://provider.invalid/device', userCode: 'FIXTURE-CODE' });
    service.cancelProviderLogin();
    emit({ type: 'auth_url', url: 'https://provider.invalid/late' });
    expect(present).toHaveBeenCalledTimes(2);
  });

  it.each(['http://provider.invalid/', 'javascript:alert(1)', 'file:///tmp/auth', 'not a URL', 'https://user:password@provider.invalid/', `https://provider.invalid/${'x'.repeat(2000)}`])('does not present or advertise invalid auth URL %s', async (url) => {
    const present = vi.fn();
    const { service } = await login(url, { present });
    expect(present).not.toHaveBeenCalled();
    expect(service.getState(false).providerLogin?.message).toBe('The provider supplied an invalid or unsupported sign-in URL.');
    expect(service.getState(false).providerLogin?.deviceCode).toBeNull();
  });
});
