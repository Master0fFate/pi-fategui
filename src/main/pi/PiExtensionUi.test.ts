import { describe, expect, it, vi } from 'vitest';
import { extensionUiStateSchema } from '../../shared/contracts/ipc';
import { cleanExtensionNotice, createPiExtensionUi, createPiExtensionUiBridge } from './PiExtensionUi';

describe('Pi extension UI bridge', () => {
  it('turns extension notifications into bounded plain GUI notices', () => {
    const notify = vi.fn();
    const ui = createPiExtensionUi({ notify });
    ui.notify('\u001b[31mParallax active\u001b[0m\u0000', 'warning');
    expect(notify).toHaveBeenCalledWith('Parallax active', 'warning');
    expect(cleanExtensionNotice('x'.repeat(70_000))).toContain('extension output truncated');
  });

  it('fails closed for unsupported interactive TUI requests', async () => {
    const ui = createPiExtensionUi({ notify: vi.fn() });
    await expect(ui.select('Choose', ['one'])).resolves.toBeUndefined();
    await expect(ui.confirm('Confirm', 'Continue?')).resolves.toBe(false);
    await expect(ui.input('Value')).resolves.toBeUndefined();
    expect(ui.setTheme('dark')).toMatchObject({ success: false });
  });

  it('captures bounded keyed text state and clears or replaces entries in place', () => {
    const changed = vi.fn();
    const bridge = createPiExtensionUiBridge({ notify: vi.fn(), onStateChange: changed });
    bridge.context.setStatus('build', '\u001b[32mReady\u001b[0m\nnow');
    bridge.context.setStatus('build', 'Done');
    for (let index = 0; index < 20; index += 1) bridge.context.setStatus(`key-${index}`, 'x'.repeat(800));
    bridge.context.setWidget('plan', Array.from({ length: 40 }, (_, index) => `\u001b[31mline ${index}\u001b[0m`));
    bridge.context.setWorkingMessage('\u001b]0;bad\u0007 Working\u0000');
    bridge.context.setTitle('\u001b[34mProject title\u001b[0m');

    const state = bridge.getState();
    expect(state.statuses).toHaveLength(16);
    expect(state.statuses[0]).toEqual({ key: 'build', text: 'Done' });
    expect(state.statuses.every((status) => status.text.length <= 500)).toBe(true);
    expect(state.widgets).toEqual([{ key: 'plan', lines: expect.arrayContaining(['line 0', 'line 31']) }]);
    expect(state.widgets[0]?.lines).toHaveLength(32);
    expect(state).toMatchObject({ working: 'Working', title: 'Project title' });

    bridge.context.setStatus('build', undefined);
    bridge.context.setWidget('plan', undefined);
    bridge.context.setWorkingMessage();
    expect(bridge.getState()).toMatchObject({ working: null, statuses: expect.not.arrayContaining([expect.objectContaining({ key: 'build' })]), widgets: [] });
    expect(changed).toHaveBeenCalled();
  });

  it('strips unterminated and C1 controls while respecting serialized UTF-16 limits', () => {
    const bridge = createPiExtensionUiBridge({ notify: vi.fn() });
    bridge.context.setStatus('🔑'.repeat(100), `Visible\u009dhidden\u009c ${'😀'.repeat(400)}`);
    bridge.context.setWidget('unsafe', ['Before\u001b]52;clipboard-secret']);
    bridge.context.setWorkingMessage('😀'.repeat(400));
    bridge.context.setTitle('😀'.repeat(400));

    const state = extensionUiStateSchema.parse(bridge.getState());
    expect(state.statuses[0]?.key.length).toBeLessThanOrEqual(100);
    expect(state.statuses[0]?.text).toMatch(/^Visible /u);
    expect(state.statuses[0]?.text).not.toContain('hidden');
    expect(state.statuses[0]?.text.length).toBeLessThanOrEqual(500);
    expect(state.widgets[0]?.lines).toEqual(['Before']);
    expect(state.working?.length).toBeLessThanOrEqual(300);
    expect(state.title?.length).toBeLessThanOrEqual(300);
  });

  it('keeps extension state isolated between session bridges', () => {
    const first = createPiExtensionUiBridge({ notify: vi.fn() });
    const second = createPiExtensionUiBridge({ notify: vi.fn() });
    first.context.setStatus('owner', 'first');
    first.context.setWidget('details', ['one']);

    expect(first.getState().statuses).toEqual([{ key: 'owner', text: 'first' }]);
    expect(second.getState()).toEqual({ statuses: [], widgets: [], working: null, title: null });
  });
});
