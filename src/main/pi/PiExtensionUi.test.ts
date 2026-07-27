import { describe, expect, it, vi } from 'vitest';
import { cleanExtensionNotice, createPiExtensionUi } from './PiExtensionUi';

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
});
