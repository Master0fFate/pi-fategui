import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * The native global keyboard hook (uiohook-napi) runs in its own process.
 *
 * Its start has a defect: it can block the calling thread for good. In the main process that
 * froze the whole application. In a helper process the worst case is a helper that never reports
 * ready; it is then stopped and push-to-talk is reported as unavailable. The helper also sends
 * only the two facts that push-to-talk needs (the chosen combination went down or up), so no
 * stream of keystrokes crosses a process boundary.
 */
export interface KeyCombo { keycode: number; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }

export interface KeyboardHook {
  /** Key names to key codes, as the hook library defines them. */
  readonly keys: Readonly<Record<string, number>>;
  setCombo(combo: KeyCombo | null): void;
  stop(): void;
}

export interface KeyboardHookOptions {
  /** The hook module to load in the helper. Defaults to the installed uiohook-napi. */
  readonly modulePath?: string;
  readonly readyTimeoutMs?: number;
  readonly attempts?: number;
}

// Plain CommonJS for `node -e`. It exits when the application goes away, so no hook is left behind.
const HELPER = `
const { uIOhook, UiohookKey } = require(process.argv[1]);
let combo = null;
const matches = (e) => combo && e.keycode === combo.keycode && !!e.ctrlKey === combo.ctrl && !!e.altKey === combo.alt
  && !!e.shiftKey === combo.shift && !!e.metaKey === combo.meta;
uIOhook.on('keydown', (e) => { if (matches(e)) process.send({ type: 'down' }); });
uIOhook.on('keyup', (e) => { if (combo && e.keycode === combo.keycode) process.send({ type: 'up' }); });
process.on('message', (message) => { if (message && message.type === 'combo') combo = message.combo; });
process.on('disconnect', () => process.exit(0));
process.send({ type: 'keys', keys: UiohookKey });
uIOhook.start();
process.send({ type: 'ready' });
`;

function stopHelper(child: ChildProcess): void {
  child.removeAllListeners();
  // The helper may be blocked inside the native start; only a forced stop is certain.
  try { child.kill('SIGKILL'); } catch { /* It already exited. */ }
}

function startOnce(listener: (event: 'down' | 'up') => void, modulePath: string, readyTimeoutMs: number): Promise<KeyboardHook | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ['-e', HELPER, modulePath], {
        // Electron runs this as plain Node; a Node host ignores the variable.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      });
    } catch { resolve(null); return; }
    let keys: Record<string, number> | null = null;
    let settled = false;
    const fail = (): void => { if (settled) return; settled = true; clearTimeout(timer); stopHelper(child); resolve(null); };
    const timer = setTimeout(fail, readyTimeoutMs);
    child.once('error', fail);
    child.once('exit', fail);
    child.on('message', (message: { type?: string; keys?: Record<string, number> }) => {
      if (message.type === 'keys' && message.keys) keys = message.keys;
      else if (message.type === 'ready' && keys && !settled) {
        settled = true;
        clearTimeout(timer);
        child.removeAllListeners('exit');
        child.removeAllListeners('error');
        child.on('error', () => undefined);
        const send = (combo: KeyCombo | null): void => { if (child.connected) child.send({ type: 'combo', combo }, () => undefined); };
        resolve({ keys, setCombo: send, stop: () => stopHelper(child) });
      } else if (settled && (message.type === 'down' || message.type === 'up')) listener(message.type);
    });
  });
}

/** Start the hook helper. Resolves null when the hook cannot start on this system. */
export async function startKeyboardHookProcess(listener: (event: 'down' | 'up') => void, options: KeyboardHookOptions = {}): Promise<KeyboardHook | null> {
  let modulePath: string;
  try { modulePath = options.modulePath ?? createRequire(import.meta.url).resolve('uiohook-napi'); }
  catch { return null; }
  for (let attempt = 0; attempt < (options.attempts ?? 2); attempt += 1) {
    const hook = await startOnce(listener, modulePath, options.readyTimeoutMs ?? 8_000);
    if (hook) return hook;
  }
  return null;
}
