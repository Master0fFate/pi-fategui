import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { launch } = vi.hoisted(() => ({ launch: vi.fn(async () => ({})) }));
vi.mock('@playwright/test', () => ({ _electron: { launch } }));
vi.mock('@earendil-works/pi-coding-agent', () => ({ SessionManager: {} }));
import { launchApp } from './gui-fork-delete-smoke.mjs';

afterEach(() => vi.unstubAllEnvs());

describe('manual fork smoke isolation', () => {
  it('does not launch on import and uses only its fixture Chromium profile', async () => {
    expect(launch).not.toHaveBeenCalled();
    vi.stubEnv('PI_SESSION_ID', 'protected-session');
    vi.stubEnv('PI_SESSION_FILE', 'protected-session.jsonl');
    vi.stubEnv('TRANSCRIBE_LIBRARY', 'protected-installed-library');
    const data = path.resolve('fixture-data');
    const agent = path.resolve('fixture-agent');
    await launchApp(agent, data);
    const options = launch.mock.calls[0][0];
    expect(options.args).toContain(`--user-data-dir=${path.join(data, 'chromium')}`);
    expect(options.env.FATE_GUI_DATA_DIR).toBe(data);
    expect(options.env.PI_CODING_AGENT_DIR).toBe(agent);
    expect(options.env.FATE_NEW_INSTANCE).toBe('1');
    expect(options.env.PI_SESSION_ID).toBeUndefined();
    expect(options.env.PI_SESSION_FILE).toBeUndefined();
    expect(options.env.TRANSCRIBE_LIBRARY).toBeUndefined();
  });
});
