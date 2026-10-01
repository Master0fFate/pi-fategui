import type { HostSignals } from './foreground';
import { setTimeout as delay } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';
import type { ProviderLoginState, ProviderLoginStartInput } from '../shared/contracts/ipc';
import type { HostAdminClient } from './adminClient';
export interface ProviderLoginIo {
  readonly interactive: boolean;
  write(text: string): void;
  readPrivate(message: string, signal: AbortSignal): Promise<string>;
}
const operatorMessages = {
  interactive: 'Provider login requires an interactive host terminal. Run it on the execution host, or use Pi-supported host settings.',
  noProviders: 'This Pi SDK has no supported provider login methods. Configure providers on the execution host.',
  unsupportedProvider: 'Provider login is unavailable in this Pi SDK. Use supported host configuration.',
  unsupportedMethod: 'This login method is unavailable. Use Pi-supported host configuration.',
  failed: 'Provider login failed. Check the provider page and supported host configuration.',
  incomplete: 'Provider login did not complete. Check authorization on the execution host.',
  cancelled: 'Provider login canceled. The host retains SDK ownership until cancellation settles.',
  inputLimit: 'Provider response exceeds the input limit.',
} as const;
/** Only fixed operator guidance may cross the CLI error boundary, never SDK text. */
export class ProviderLoginOperatorError extends Error {
  constructor(readonly code: keyof typeof operatorMessages) { super(operatorMessages[code]); }
  get operatorMessage(): string { return operatorMessages[this.code]; }
}
const cancelled = (): Error => new ProviderLoginOperatorError('cancelled');
/** Hidden terminal input. No raw-mode response reaches stdout or an ordinary log. */
export function createProviderLoginIo(): ProviderLoginIo {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && typeof process.stdin.setRawMode === 'function';
  return {
    interactive,
    write(text) { if (!interactive) throw new ProviderLoginOperatorError('interactive'); process.stdout.write(text); },
    readPrivate(message, signal) {
      if (!interactive) return Promise.reject(new ProviderLoginOperatorError('interactive'));
      if (signal.aborted) return Promise.reject(cancelled());
      process.stdout.write(`${message}\nInput is hidden. Press Enter to continue, or Ctrl+C to cancel.\n`);
      return new Promise<string>((resolve, reject) => {
        const previousRaw = process.stdin.isRaw;
        const previouslyFlowing = process.stdin.readableFlowing === true;
        const decoder = new StringDecoder('utf8');
        let value = '';
        const cleanup = () => {
          process.stdin.off('data', onData); process.stdin.off('end', onEnd); signal.removeEventListener('abort', onAbort);
          process.stdin.setRawMode(previousRaw); if (!previouslyFlowing) process.stdin.pause();
          process.stdout.write('\n');
        };
        const onAbort = () => { cleanup(); reject(cancelled()); };
        const onEnd = () => { cleanup(); reject(cancelled()); };
        const onData = (data: Buffer | string) => {
          for (const character of typeof data === 'string' ? data : decoder.write(data)) {
            if (character === '\u0003') { onAbort(); return; }
            if (character === '\r' || character === '\n') { cleanup(); resolve(value); return; }
            if (character === '\u007f' || character === '\b') { value = [...value].slice(0, -1).join(''); continue; }
            if (character < ' ' || character === '\u007f') continue;
            value += character;
            if (value.length > 20_000) { cleanup(); reject(new ProviderLoginOperatorError('inputLimit')); return; }
          }
        };
        process.stdin.setRawMode(true); process.stdin.resume();
        process.stdin.on('data', onData); process.stdin.once('end', onEnd); signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
function providerResult(response: Awaited<ReturnType<HostAdminClient['execute']>>): ProviderLoginState {
  if (!response.method.startsWith('provider.') || !('status' in response.result)) throw new Error('Provider response is invalid.');
  return response.result;
}
function terminalText(text: string): string { return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' '); }
function showChallenge(io: ProviderLoginIo, state: ProviderLoginState): void {
  if (state.deviceCode) {
    const url = new URL(state.deviceCode.verificationUri);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      io.write(`Open this provider page: ${url.href}\nDevice code: ${terminalText(state.deviceCode.userCode)}\n`);
    }
  } else if (state.message?.startsWith('https://')) {
    const url = new URL(state.message);
    if (url.protocol === 'https:' && !url.username && !url.password) io.write(`Open this provider page: ${url.href}\n`);
  }
}
/** Uses only existing SDK prompts and responses. It invents no OAuth exchange. */
export async function runProviderLogin(client: HostAdminClient, requested: { readonly providerId?: string; readonly method?: 'api_key' | 'oauth' },
  io: ProviderLoginIo = createProviderLoginIo(), options: { readonly signal?: AbortSignal; readonly pollMs?: number; readonly deadlineMs?: number; readonly signals?: HostSignals } = {}): Promise<void> {
  if (!io.interactive) throw new ProviderLoginOperatorError('interactive');
  const interrupted = new AbortController(), signals = options.signals ?? process;
  const interrupt = () => interrupted.abort();
  signals.on('SIGINT', interrupt); signals.on('SIGTERM', interrupt);
  try {
    const signal = AbortSignal.any([AbortSignal.timeout(options.deadlineMs ?? 10 * 60_000), interrupted.signal, ...(options.signal ? [options.signal] : [])]);
    const catalog = providerResult(await client.execute({ method: 'provider.initialize', input: {} }));
    if (signal.aborted) throw cancelled();
    let provider = catalog.providers.find((entry) => entry.id === requested.providerId);
    if (!requested.providerId) {
      if (!catalog.providers.length) throw new ProviderLoginOperatorError('noProviders');
      io.write(catalog.providers.map((entry, index) => `${index + 1}. ${terminalText(entry.name)}\n`).join(''));
      const selection = await io.readPrivate('Select the provider number.', signal);
      provider = /^[1-9][0-9]*$/u.test(selection) ? catalog.providers[Number(selection) - 1] : undefined;
    }
    if (!provider) throw new ProviderLoginOperatorError('unsupportedProvider');
    let method = requested.method;
    if (!method) {
      if (provider.methods.length === 1) method = provider.methods[0];
      else {
        io.write(provider.methods.map((entry, index) => `${index + 1}. ${entry}\n`).join(''));
        const selection = await io.readPrivate('Select the login method number.', signal);
        method = /^[1-9][0-9]*$/u.test(selection) ? provider.methods[Number(selection) - 1] : undefined;
      }
    }
    if (!method || !provider.methods.includes(method)) throw new ProviderLoginOperatorError('unsupportedMethod');
    const input: ProviderLoginStartInput = { providerId: provider.id, method };
    let started = false;
    let read: { id: string; controller: AbortController; result: Promise<{ kind: 'input'; value: string }> } | null = null;
    let lastChallenge = '';
    try {
      if (signal.aborted) throw cancelled();
      let state: ProviderLoginState = providerResult(await client.execute({ method: 'provider.start', input }));
      started = true;
      for (;;) {
        if (signal.aborted) throw cancelled();
        if (state.status === 'error') throw new ProviderLoginOperatorError('failed');
        if (state.status === 'idle') {
          if (state.providers.find((entry) => entry.id === provider.id)?.configured !== true) throw new ProviderLoginOperatorError('incomplete');
          io.write('Provider login completed. The SDK reports configured authorization.\n');
          return;
        }
        const challenge = JSON.stringify([state.message, state.deviceCode]);
        if (challenge !== lastChallenge) { showChallenge(io, state); lastChallenge = challenge; }
        if (read && state.prompt?.id !== read.id) { read.controller.abort(); read = null; }
        if (state.prompt && !read) {
          const controller = new AbortController();
          const prompt: NonNullable<ProviderLoginState['prompt']> = state.prompt;
          if (prompt.options) io.write(prompt.options.map((entry) => `${terminalText(entry.id)}: ${terminalText(entry.label)}\n`).join(''));
          const result = io.readPrivate(terminalText(prompt.message), AbortSignal.any([signal, controller.signal]))
            .then((value) => ({ kind: 'input' as const, value }));
          void result.catch(() => undefined);
          read = { id: prompt.id, controller, result };
        }
        const tick = delay(options.pollMs ?? 250, { kind: 'tick' as const }, { signal });
        const event = read ? await Promise.race([read.result, tick]) : await tick;
        if (event.kind === 'input' && read) {
          state = providerResult(await client.execute({ method: 'provider.respond', input: { promptId: read.id, value: event.value } }));
          read = null;
        } else state = providerResult(await client.execute({ method: 'provider.state', input: {} }));
      }
    } catch (error) {
      if (started) {
        try { await client.execute({ method: 'provider.cancel', input: {} }); }
        catch { io.write('Provider cancellation is unconfirmed. Inspect the host server before retry.\n'); }
      }
      if (error instanceof Error && signal.aborted) throw cancelled();
      throw error;
    } finally { read?.controller.abort(); }
  } finally { signals.off('SIGINT', interrupt); signals.off('SIGTERM', interrupt); }
}
