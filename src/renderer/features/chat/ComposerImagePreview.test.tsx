import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi, RuntimeState } from '../../../shared/contracts/ipc';
import { hasBlockingBrowserOverlay } from '../../app/App';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { clearComposerSessionDrafts, Composer } from './Composer';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const runtime: RuntimeState = {
  status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
  streaming: false, model: { provider: 'test', id: 'model', name: 'Model', reasoning: false, contextWindow: 100_000, supportsImages: true },
  models: [], thinkingLevel: 'off', permissionLevel: 'edit', messages: [], commands: [], error: null,
};

describe('composer image preview browser overlay', () => {
  beforeEach(() => {
    clearComposerSessionDrafts();
    useRuntimeStore.getState().setRuntime(runtime);
    useUiStore.setState({ selectedAgent: null, composerDraftRequest: null, goalEditorOpen: false, sendMessageWithModifier: false, toast: null });
  });

  afterEach(() => {
    clearComposerSessionDrafts();
    Reflect.deleteProperty(window, 'piDesktop');
  });

  it.each(['escape', 'backdrop', 'canvas', 'close'] as const)('blocks for the real attachment preview and releases on %s without losing the draft', async (dismissal) => {
    const prompt = vi.fn(async () => ({ accepted: true, runId: 'unexpected-send' }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: { prompt } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    const { container } = render(<Composer onOpenProject={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Message Pi' });
    await user.type(input, 'Keep this draft and attachment');
    const image = new File([Uint8Array.from(atob(png), (character) => character.charCodeAt(0))], 'attachment.png', { type: 'image/png' });
    fireEvent.paste(input, { clipboardData: { files: [image] } });
    const trigger = await screen.findByRole('button', { name: 'Expand image: attachment.png' });
    expect(hasBlockingBrowserOverlay()).toBe(false);

    await user.click(trigger);
    const viewer = screen.getByRole('dialog', { name: 'attachment.png' });
    expect(container).not.toContainElement(viewer);
    expect(viewer).toHaveAttribute('aria-modal', 'true');
    expect(hasBlockingBrowserOverlay()).toBe(true);
    const close = within(viewer).getByRole('button', { name: 'Close image viewer' });
    expect(close).toHaveFocus();
    const preview = within(viewer).getByRole('img', { name: 'attachment.png' });
    expect(preview).toHaveAttribute('src', `data:image/png;base64,${png}`);
    await user.click(preview);
    expect(viewer).toBeInTheDocument();
    expect(hasBlockingBrowserOverlay()).toBe(true);

    if (dismissal === 'escape') await user.keyboard('{Escape}');
    else if (dismissal === 'backdrop') await user.click(document.querySelector<HTMLElement>('.cinematic-image-overlay')!);
    else if (dismissal === 'canvas') await user.click(viewer);
    else await user.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'attachment.png' })).not.toBeInTheDocument());
    expect(hasBlockingBrowserOverlay()).toBe(false);
    expect(input).toHaveValue('Keep this draft and attachment');
    expect(trigger).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove attachment.png' })).toBeInTheDocument();
    expect(prompt).not.toHaveBeenCalled();
  });
});
