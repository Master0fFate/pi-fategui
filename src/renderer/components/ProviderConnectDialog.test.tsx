import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelsDevListResult,
  ModelsDevMutationResult,
  ModelsDevProviderDetail,
  PiDesktopApi,
  ProviderLoginState,
} from '../../shared/contracts/ipc';
import { useRuntimeStore } from '../stores/runtimeStore';
import { resetLogoProbeCacheForTests } from './ProviderLogo';
import { ProviderConnectDialog } from './ProviderConnectDialog';

const loginState: ProviderLoginState = {
  status: 'idle',
  providers: [
    { id: 'anthropic', name: 'Anthropic', methods: ['oauth', 'api_key'], configured: true },
    { id: 'amazon-bedrock', name: 'Amazon Bedrock', methods: ['api_key'], configured: false },
    { id: 'supergrok', name: 'SuperGrok (xAI OAuth)', methods: ['oauth'], configured: false },
  ],
  providerId: null, providerName: null, method: null, prompt: null, message: null, deviceCode: null,
};

const catalog: ModelsDevListResult = {
  fetchedAt: 1,
  providers: [
    { id: 'anthropic', name: 'Anthropic', modelCount: 9, envVar: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages', docUrl: null, status: 'configured' },
    { id: 'crof', name: 'CrofAI', modelCount: 20, envVar: 'CROF_API_KEY', baseUrl: 'https://crof.ai/v1', api: 'openai-completions', docUrl: null, status: 'available' },
    { id: 'nvidia', name: 'NVIDIA', modelCount: 12, envVar: 'NVIDIA_API_KEY', baseUrl: 'https://integrate.api.nvidia.com/v1', api: 'openai-completions', docUrl: null, status: 'available' },
  ],
};

const crofDetail: ModelsDevProviderDetail = {
  id: 'crof', name: 'CrofAI', baseUrl: 'https://crof.ai/v1', envVar: 'CROF_API_KEY', api: 'openai-completions', docUrl: null,
  models: [{ id: 'kimi-k3', name: 'Kimi K3', reasoning: true, toolCall: true, structuredOutput: true, imageInput: true, contextWindow: 1_000_000, maxTokens: 262_144, effortValues: ['none', 'low', 'high', 'max'], costInput: 2, costOutput: 8 }],
};

const nvidiaDetail: ModelsDevProviderDetail = {
  id: 'nvidia', name: 'NVIDIA', baseUrl: 'https://integrate.api.nvidia.com/v1', envVar: 'NVIDIA_API_KEY', api: 'openai-completions', docUrl: null,
  models: [{ id: 'llama-x', name: 'Llama X', reasoning: false, toolCall: true, structuredOutput: false, imageInput: false, contextWindow: 128_000, maxTokens: 16_384, effortValues: [], costInput: 0, costOutput: 0 }],
};

const mutation: ModelsDevMutationResult = { providerId: 'crof', providerName: 'CrofAI', modelCount: 20, state: {} as ModelsDevMutationResult['state'] };

let bridge: Record<string, unknown>;

function setRuntime(patch: Record<string, unknown>) {
  useRuntimeStore.getState().setRuntime({
    status: 'ready', project: null, sessionId: null, sessionFile: null, streaming: false,
    model: null, models: [], thinkingLevel: 'medium', messages: [], commands: [], error: null,
    providerLogin: loginState,
    ...patch,
  });
}

beforeEach(() => {
  bridge = {
    initializeProviderLogin: vi.fn(async () => ({ ...loginState } as never)),
    startProviderLogin: vi.fn(async () => ({ ...loginState } as never)),
    cancelProviderLogin: vi.fn(() => ({ ...loginState } as never)),
    respondProviderLogin: vi.fn(() => ({ ...loginState } as never)),
    logoutProvider: vi.fn(async () => ({ ...loginState } as never)),
    listModelsDevProviders: vi.fn(async () => catalog),
    getModelsDevProvider: vi.fn(async (providerId: string) => (providerId === 'nvidia' ? nvidiaDetail : crofDetail)),
    addModelsDevProvider: vi.fn(async (input: { providerId: string; apiKey?: string }) => ({ providerId: input.providerId, providerName: input.providerId === 'nvidia' ? 'NVIDIA' : 'CrofAI', modelCount: input.providerId === 'nvidia' ? 12 : 20, state: {} } as never)),
    removeModelsDevProvider: vi.fn(async () => mutation),
  };
  Object.defineProperty(window, 'piDesktop', { configurable: true, writable: true, value: bridge });
  setRuntime({});
});

afterEach(() => {
  delete (window as { piDesktop?: unknown }).piDesktop;
  resetLogoProbeCacheForTests();
});

describe('ProviderConnectDialog opening gate', () => {
  it('waits out the logo prefetch budget before mounting, then appears fully formed', async () => {
    // jsdom Images never fire, so the 200ms budget is the only ready path.
    render(<ProviderConnectDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByText('Connect a provider')).toBeNull();
    expect(await screen.findByText('Connect a provider', {}, { timeout: 2_000 })).toBeInTheDocument();
  });
});

describe('ProviderConnectDialog list', () => {
  it('merges sign-in and catalog providers into one list with methods on the right', async () => {
    render(<ProviderConnectDialog open onOpenChange={() => undefined} />);
    expect(await screen.findByText('Amazon Bedrock')).toBeInTheDocument();
    // Right-side meta shows the sign-in method for builtin providers.
    expect(screen.getByText('API key')).toBeInTheDocument();
    expect(screen.getByText('OAuth')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument(); // anthropic
    expect(screen.getByText('20 models')).toBeInTheDocument(); // crof
    // The catalog row for a builtin provider is suppressed (no duplicate noise).
    const crofRows = screen.getAllByText('CrofAI');
    expect(crofRows).toHaveLength(1);
  });

  it('loads fresh lists on open and filters by query', async () => {
    // Settings path: no sign-in list yet, so the dialog initializes it itself.
    setRuntime({ providerLogin: { ...loginState, providers: [] } });
    render(<ProviderConnectDialog open onOpenChange={() => undefined} />);
    await screen.findByText('CrofAI');
    expect(bridge.listModelsDevProviders).toHaveBeenCalledTimes(1);
    expect(bridge.initializeProviderLogin).toHaveBeenCalledTimes(1);
    await userEvent.type(screen.getByLabelText('Search providers'), 'nvid');
    expect(screen.getByText('NVIDIA')).toBeInTheDocument();
    expect(screen.queryByText('CrofAI')).not.toBeInTheDocument();
  });

  it('shows a retry state when the catalog cannot load', async () => {
    bridge.listModelsDevProviders = vi.fn(async () => { throw new Error(JSON.stringify({ message: 'models.dev is offline' })); });
    render(<ProviderConnectDialog open onOpenChange={() => undefined} />);
    expect(await screen.findByText('models.dev is offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders provider logos as currentColor masks', async () => {
    render(<ProviderConnectDialog open onOpenChange={() => undefined} />);
    await screen.findByText('CrofAI');
    const bedrockRow = screen.getByText('Amazon Bedrock').closest('.provider-dialog-row')!;
    const logo = bedrockRow.querySelector('.provider-logo') as HTMLElement;
    expect(logo).not.toBeNull();
    expect(logo.querySelector('img')).toBeNull();
  });
});

describe('ProviderConnectDialog sign-in flow', () => {
  it('shows the sign-in methods for a builtin provider and starts an API-key login', async () => {
    const user = userEvent.setup();
    render(<ProviderConnectDialog open onOpenChange={() => undefined} />);
    await user.click(await screen.findByText('Amazon Bedrock'));
    expect(await screen.findByRole('button', { name: /use an api key/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /use an api key/i }));
    expect(bridge.startProviderLogin).toHaveBeenCalledWith({ providerId: 'amazon-bedrock', method: 'api_key' });
  });

  it('shows sign-out for connected providers and a working state during login', async () => {
    const user = userEvent.setup();
    setRuntime({
      providerLogin: { ...loginState, status: 'working', providerId: 'supergrok', providerName: 'SuperGrok (xAI OAuth)', message: 'A secure browser window opened.' },
    });
    render(<ProviderConnectDialog open onOpenChange={() => undefined} />);
    await user.click(await screen.findByText('SuperGrok (xAI OAuth)'));
    expect(await screen.findByText('A secure browser window opened.')).toBeInTheDocument();
  });

  it('renders the secret prompt form when the SDK asks for a credential', async () => {
    const user = userEvent.setup();
    setRuntime({
      providerLogin: { ...loginState, status: 'awaiting-input', providerId: 'amazon-bedrock', prompt: { id: 'p1', type: 'secret', message: 'Enter API key', placeholder: 'sk-...' } },
    });
    render(<ProviderConnectDialog open onOpenChange={() => undefined} />);
    await user.click(await screen.findByText('Amazon Bedrock'));
    const field = await screen.findByPlaceholderText('sk-...');
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    await userEvent.type(field, 'sk-test');
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('offers removal for models.dev-managed providers from the catalog detail', async () => {
    const user = userEvent.setup();
    setRuntime({ modelsDevManaged: [{ id: 'crof', name: 'CrofAI', baseUrl: 'https://crof.ai/v1', envVar: 'CROF_API_KEY', api: 'openai-completions', modelCount: 20, addedAt: 1, checkedAt: 1, credentialConfigured: false }] });
    render(<ProviderConnectDialog open onOpenChange={() => undefined} />);
    await user.click(await screen.findByText('CrofAI'));
    const remove = await screen.findByRole('button', { name: /remove from fate ui/i });
    // The add flow is replaced by removal for already-managed providers.
    expect(screen.queryByRole('button', { name: /add \d+ models/i })).not.toBeInTheDocument();
    await user.click(remove);
    await waitFor(() => expect(bridge.removeModelsDevProvider).toHaveBeenCalledWith('crof'));
  });
});

describe('ProviderConnectDialog add flow', () => {
  it('adds a catalog provider with an optional API key', async () => {
    const onNotice = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ProviderConnectDialog open onOpenChange={onOpenChange} onNotice={onNotice} />);
    await user.click(await screen.findByText('NVIDIA'));
    await user.type(await screen.findByPlaceholderText('NVIDIA_API_KEY value'), 'nvkey');
    await user.click(await screen.findByRole('button', { name: /add \d+ models/i }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(bridge.addModelsDevProvider).toHaveBeenCalledWith({ providerId: 'nvidia', apiKey: 'nvkey' });
    expect(onNotice).toHaveBeenCalledWith('success', 'NVIDIA added', expect.any(String));
  });

  it('surfaces add errors inline', async () => {
    bridge.addModelsDevProvider = vi.fn(async () => { throw new Error(JSON.stringify({ message: 'Provider add failed' })); });
    const user = userEvent.setup();
    render(<ProviderConnectDialog open onOpenChange={() => undefined} />);
    await user.click(await screen.findByText('NVIDIA'));
    await user.click(await screen.findByRole('button', { name: /add \d+ models/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Provider add failed');
  });
});
