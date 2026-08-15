import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi, ProviderLoginState } from '../../../shared/contracts/ipc';
import { ProviderLoginDialog } from './ProviderLoginDialog';

function loginState(overrides: Partial<ProviderLoginState>): ProviderLoginState {
  return {
    status: 'working', providers: [], providerId: 'openai-codex', providerName: 'OpenAI (ChatGPT Plus/Pro)',
    method: 'oauth', prompt: null, message: null, deviceCode: null, ...overrides,
  };
}

function mockDesktop(startProviderLogin?: (input: { providerId: string; method: string }) => Promise<ProviderLoginState>) {
  const respondProviderLogin = vi.fn(async () => loginState({}));
  const start = startProviderLogin ?? (vi.fn(async () => loginState({ status: 'idle' })) as unknown as typeof startProviderLogin);
  Object.defineProperty(window, 'piDesktop', {
    configurable: true,
    value: {
      startProviderLogin: start,
      respondProviderLogin,
      cancelProviderLogin: vi.fn(async () => loginState({})),
    } as unknown as PiDesktopApi,
  });
  return { respondProviderLogin, start };
}

describe('ProviderLoginDialog', () => {
  it('shows browser progress with an optional manual code fallback instead of a blocking form', async () => {
    const user = userEvent.setup();
    const { respondProviderLogin } = mockDesktop();
    render(
      <ProviderLoginDialog
        open
        state={loginState({
          status: 'working',
          message: 'A secure browser window opened. Complete sign-in there, then return to Fate UI.',
          prompt: {
            id: '0b1a2c3d-0000-4000-8000-000000000001',
            type: 'manual_code',
            message: 'Complete login in your browser, or paste the authorization code / redirect URL here:',
            placeholder: 'http://localhost:1455/auth/callback',
          },
        })}
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.getByText('OpenAI (ChatGPT Plus/Pro) sign-in')).toBeVisible();
    expect(screen.getByText('A secure browser window opened. Complete sign-in there, then return to Fate UI.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();

    const fallback = screen.getByText('Browser sign-in did not finish automatically');
    await user.click(fallback);
    const input = screen.getByPlaceholderText('http://localhost:1455/auth/callback');
    await user.type(input, 'http://localhost:1455/auth/callback?code=abc&state=s');
    await user.click(screen.getByRole('button', { name: 'Submit code' }));

    expect(respondProviderLogin).toHaveBeenCalledWith({
      promptId: '0b1a2c3d-0000-4000-8000-000000000001',
      value: 'http://localhost:1455/auth/callback?code=abc&state=s',
    });
  });

  it('renders select prompts as blocking forms', () => {
    mockDesktop();
    render(
      <ProviderLoginDialog
        open
        state={loginState({
          status: 'awaiting-input',
          prompt: { id: '0b1a2c3d-0000-4000-8000-000000000002', type: 'select', message: 'Select OpenAI Codex login method:', options: [{ id: 'browser', label: 'Browser login (default)' }] },
        })}
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.getByText('Select OpenAI Codex login method:')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.queryByText('Browser sign-in did not finish automatically')).not.toBeInTheDocument();
  });

  it('filters the provider list by name or id and clears the search', async () => {
    const user = userEvent.setup();
    mockDesktop();
    const providers = [
      { id: 'anthropic', name: 'Anthropic', methods: ['oauth' as const], configured: false },
      { id: 'openai-codex', name: 'OpenAI (ChatGPT Plus/Pro)', methods: ['oauth' as const], configured: false },
      { id: 'google', name: 'Google Gemini', methods: ['oauth' as const], configured: false },
      { id: 'xai', name: 'xAI Grok', methods: ['api_key' as const], configured: false },
      { id: 'openrouter', name: 'OpenRouter', methods: ['api_key' as const], configured: false },
      { id: 'groq', name: 'Groq', methods: ['api_key' as const], configured: false },
      { id: 'mistral', name: 'Mistral', methods: ['api_key' as const], configured: false },
    ];
    render(
      <ProviderLoginDialog
        open
        state={loginState({ status: 'idle', providers, providerId: null, providerName: null, method: null })}
        onOpenChange={() => undefined}
      />,
    );

    const search = screen.getByRole('textbox', { name: 'Search providers' });
    expect(search).toHaveAttribute('placeholder', 'Search 7 providers…');
    expect(screen.getByText('Anthropic')).toBeVisible();

    await user.type(search, 'codex');
    expect(screen.queryByText('Anthropic')).not.toBeInTheDocument();
    expect(screen.getByText('OpenAI (ChatGPT Plus/Pro)')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Anthropic')).toBeVisible();

    await user.type(search, 'no-match-xyz');
    expect(screen.getByText('No providers match “no-match-xyz”.')).toBeVisible();
  });

  it('hides the search bar when only a few providers exist', () => {
    mockDesktop();
    render(
      <ProviderLoginDialog
        open
        state={loginState({
          status: 'idle',
          providerId: null, providerName: null, method: null,
          providers: [
            { id: 'anthropic', name: 'Anthropic', methods: ['oauth' as const], configured: false },
            { id: 'openai-codex', name: 'OpenAI (ChatGPT Plus/Pro)', methods: ['oauth' as const], configured: false },
            { id: 'google', name: 'Google Gemini', methods: ['oauth' as const], configured: false },
          ],
        })}
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.getByText('Anthropic')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Search providers' })).not.toBeInTheDocument();
  });

  it('does not self-close on the stale idle snapshot after clicking sign-in; closes only after the flow settles', async () => {
    const user = userEvent.setup();
    // The IPC promise stays pending, mirroring the round-trip before the main
    // process reports `working` — the exact window where the stale-close bug hit.
    let resolveStart: ((state: ProviderLoginState) => void) | undefined;
    mockDesktop(() => new Promise<ProviderLoginState>((resolve) => { resolveStart = resolve; }));
    const onOpenChange = vi.fn();
    const configuredProvider = { id: 'openai-codex', name: 'OpenAI (ChatGPT Plus/Pro)', methods: ['oauth' as const], configured: true };
    const idleConfigured = loginState({
      status: 'idle', providers: [configuredProvider], providerId: null, providerName: null, method: null, message: null,
    });
    const props = { open: true, onOpenChange } as const;
    const { rerender } = render(<ProviderLoginDialog {...props} state={idleConfigured} />);

    await user.click(screen.getByRole('button', { name: /OpenAI \(ChatGPT Plus\/Pro\)/ }));
    await user.click(screen.getByRole('button', { name: /Sign in in browser/i }));

    // Stale idle + configured provider must NOT close the dialog.
    expect(onOpenChange).not.toHaveBeenCalled();
    // The optimistic bridge shows progress immediately instead of the provider list.
    expect(screen.getByText('OpenAI (ChatGPT Plus/Pro) sign-in')).toBeVisible();
    expect(screen.getByText('Starting secure provider sign-in…')).toBeVisible();

    // The flow goes active (SDK method chooser arrives).
    rerender(<ProviderLoginDialog {...props} state={loginState({
      status: 'awaiting-input',
      providers: [configuredProvider],
      prompt: { id: '0b1a2c3d-0000-4000-8000-000000000003', type: 'select', message: 'Select OpenAI Codex login method:', options: [{ id: 'browser', label: 'Browser login (default)' }, { id: 'device_code', label: 'Device code login (headless)' }] },
      message: null,
    })} />);
    expect(screen.getByText('Select OpenAI Codex login method:')).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();

    // Flow finishes: back to idle with the provider configured — now it closes.
    rerender(<ProviderLoginDialog {...props} state={idleConfigured} />);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(resolveStart).toBeTypeOf('function');
  });

  it('surfaces a failed sign-in start as an inline error', async () => {
    const user = userEvent.setup();
    mockDesktop(() => Promise.reject(new Error('Wait for the active Pi operation to finish before signing in.')));
    render(
      <ProviderLoginDialog
        open
        state={loginState({
          status: 'idle', providerId: null, providerName: null, method: null, message: null,
          providers: [{ id: 'openai-codex', name: 'OpenAI (ChatGPT Plus/Pro)', methods: ['oauth' as const], configured: false }],
        })}
        onOpenChange={() => undefined}
      />,
    );

    await user.click(screen.getByRole('button', { name: /OpenAI \(ChatGPT Plus\/Pro\)/ }));
    await user.click(screen.getByRole('button', { name: /Sign in in browser/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Wait for the active Pi operation to finish before signing in.');
    expect(screen.getByText('OpenAI (ChatGPT Plus/Pro)')).toBeVisible();
  });
});
