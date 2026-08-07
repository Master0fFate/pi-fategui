import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiDesktopApi, RuntimeState } from '../../../shared/contracts/ipc';
import { AppToast } from '../../components/AppToast';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { clearComposerSessionDrafts, Composer } from './Composer';

const runtime: RuntimeState = {
  status: 'ready', project: { path: '/project', name: 'project', trusted: true }, sessionId: 's1', sessionFile: null,
  streaming: false, model: { provider: 'test', id: 'model', name: 'Model', reasoning: false, contextWindow: 100_000 },
  models: [], thinkingLevel: 'off', permissionLevel: 'edit', messages: [], commands: [], error: null,
};
class FakeRecorder extends EventTarget {
  state: RecordingState = 'inactive';
  readonly mimeType = 'audio/webm';
  constructor(readonly stream: MediaStream) { super(); }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    const data = new Event('dataavailable');
    Object.defineProperty(data, 'data', { value: new Blob(['audio'], { type: this.mimeType }) });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event('stop'));
  }
}

describe('Composer voice input', () => {
  beforeEach(() => {
    useRuntimeStore.getState().setRuntime(runtime);
    useUiStore.setState({ speech: { enabled: true, modelId: 'mini', language: 'auto', inputDeviceId: null }, speechDownload: null, toast: null });
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) } });
    Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value: async () => new ArrayBuffer(8) });
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeRecorder });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class {
      decodeAudioData = async () => ({ length: 4, numberOfChannels: 1, sampleRate: 16_000, duration: 0.001, getChannelData: () => new Float32Array([0, 0.25, -0.25, 0]) });
      close = async () => undefined;
    } });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {
      ensureSpeechModel: vi.fn(async () => undefined),
      cancelSpeechModelDownload: vi.fn(async () => false),
      transcribeSpeech: vi.fn(async () => ({ text: 'review the current changes', language: 'en', backend: 'Test GPU', accelerated: true })),
      cancelSpeechTranscription: vi.fn(async () => false),
      onSpeechDownload: vi.fn(() => () => undefined),
    } as unknown as PiDesktopApi });
  });

  afterEach(() => {
    clearComposerSessionDrafts();
    Reflect.deleteProperty(window, 'piDesktop');
    Reflect.deleteProperty(navigator, 'mediaDevices');
    Reflect.deleteProperty(globalThis, 'MediaRecorder');
    Reflect.deleteProperty(globalThis, 'AudioContext');
    useUiStore.setState({ toast: null });
  });

  it('records, transcribes locally, and inserts at the active cursor without sending', async () => {
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);
    const textarea = screen.getByRole('textbox', { name: 'Message Pi' });
    fireEvent.change(textarea, { target: { value: 'Please' } });
    await user.click(screen.getByRole('button', { name: 'Start voice recording' }));
    const recordingButton = await screen.findByRole('button', { name: 'Stop voice recording' });
    expect(recordingButton.querySelector('.lucide-mic')).toBeInTheDocument();
    expect(recordingButton.querySelector('.lucide-square')).not.toBeInTheDocument();
    await user.click(recordingButton);

    await waitFor(() => expect(textarea).toHaveValue('Please review the current changes'));
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    expect(window.piDesktop.ensureSpeechModel).toHaveBeenCalledWith('mini');
    expect(window.piDesktop.transcribeSpeech).toHaveBeenCalledWith('mini', expect.any(ArrayBuffer), undefined);
  });

  it('inserts at the initiation selection and restores its scroll viewport after asynchronous transcription', async () => {
    let resolveTranscript: ((value: { text: string; language: string; backend: string; accelerated: boolean }) => void) | undefined;
    const transcribeSpeech = vi.fn(() => new Promise<{ text: string; language: string; backend: string; accelerated: boolean }>((resolve) => { resolveTranscript = resolve; }));
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {
      ensureSpeechModel: vi.fn(async () => undefined),
      transcribeSpeech,
      cancelSpeechTranscription: vi.fn(async () => false),
    } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    render(<Composer onOpenProject={vi.fn()} />);
    const textarea = screen.getByRole('textbox', { name: 'Message Pi' }) as HTMLTextAreaElement;
    const original = `prefix TARGET remainder\n${Array.from({ length: 80 }, (_, index) => `long line ${index}`).join('\n')}`;
    fireEvent.change(textarea, { target: { value: original } });
    const start = original.indexOf('TARGET');
    textarea.setSelectionRange(start, start + 'TARGET'.length);
    textarea.scrollTop = 120;

    await user.click(screen.getByRole('button', { name: 'Start voice recording' }));
    expect(await screen.findByRole('button', { name: 'Stop voice recording' })).toBeInTheDocument();

    const latest = `${original}\nmanual edit while recording`;
    fireEvent.change(textarea, { target: { value: latest } });
    textarea.setSelectionRange(latest.length, latest.length);
    textarea.scrollTop = 640;
    await user.click(screen.getByRole('button', { name: 'Stop voice recording' }));
    await waitFor(() => expect(transcribeSpeech).toHaveBeenCalledOnce());
    await act(async () => {
      resolveTranscript?.({ text: 'spoken replacement', language: 'en', backend: 'Test GPU', accelerated: true });
      await Promise.resolve();
    });

    const expected = latest.replace('TARGET', 'spoken replacement');
    await waitFor(() => expect(textarea).toHaveValue(expected));
    await waitFor(() => expect(textarea.scrollTop).toBe(120));
    expect(textarea.selectionStart).toBe(start + 'spoken replacement'.length);
    expect(transcribeSpeech).toHaveBeenCalledOnce();
  });

  it('falls back to the system microphone with a transient toast instead of persistent composer text', async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(new DOMException('Missing device', 'NotFoundError'))
      .mockResolvedValueOnce({ getTracks: () => [{ stop }] });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    useUiStore.setState({ speech: { enabled: true, modelId: 'mini', language: 'auto', inputDeviceId: 'missing-device' } });

    const { container } = render(<><Composer onOpenProject={vi.fn()} /><AppToast /></>);
    await user.click(screen.getByRole('button', { name: 'Start voice recording' }));

    expect(await screen.findByRole('button', { name: 'Stop voice recording' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Using the system microphone');
    expect(screen.getByRole('alert')).toHaveTextContent('this recording uses the system default');
    expect(container.querySelector('.composer-error')).toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('does not open a microphone or transcribe when unmounted during async model preparation', async () => {
    let finishPreparation: (() => void) | undefined;
    const ensureSpeechModel = vi.fn(() => new Promise<void>((resolve) => { finishPreparation = resolve; }));
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    Object.defineProperty(window, 'piDesktop', { configurable: true, value: {
      ensureSpeechModel,
      transcribeSpeech: vi.fn(),
      cancelSpeechTranscription: vi.fn(async () => false),
    } as unknown as PiDesktopApi });
    const user = userEvent.setup();
    const view = render(<Composer onOpenProject={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Start voice recording' }));
    await waitFor(() => expect(ensureSpeechModel).toHaveBeenCalledOnce());
    view.unmount();
    finishPreparation?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(window.piDesktop.transcribeSpeech).not.toHaveBeenCalled();
    expect(window.piDesktop.cancelSpeechTranscription).toHaveBeenCalledOnce();
  });

  it('releases an active recording without decoding or transcribing after unmount', async () => {
    const user = userEvent.setup();
    const view = render(<Composer onOpenProject={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Start voice recording' }));
    expect(await screen.findByRole('button', { name: 'Stop voice recording' })).toBeInTheDocument();

    view.unmount();
    await Promise.resolve();

    expect(window.piDesktop.cancelSpeechTranscription).toHaveBeenCalledOnce();
    expect(window.piDesktop.transcribeSpeech).not.toHaveBeenCalled();
  });
});
