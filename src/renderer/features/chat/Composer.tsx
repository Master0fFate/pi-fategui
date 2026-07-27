import * as Popover from '@radix-ui/react-popover';
import { ArrowUp, AtSign, ChevronDown, ChevronUp, CornerUpLeft, Ellipsis, FileText, FolderOpen, GitFork, ImagePlus, LoaderCircle, Mic, Pencil, Plug, Shield, ShieldCheck, Sparkles, Square, Trash2, TriangleAlert, X, Zap } from 'lucide-react';
import { type ChangeEvent, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PromptInput, QueueMutationInput } from '../../../shared/contracts/ipc';
import { AppTooltip } from '../../components/AppTooltip';
import { SelectControl } from '../../components/SelectControl';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { ContextWheel } from './ContextWheel';
import { findSlashCommands, slashCommandContext, slashCommandDescription, slashCommandLabel, type SlashCommand } from './slashCommands';

interface Attachment {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
  bytes: number;
  pixels: number;
}

const MAX_ATTACHMENT_BYTES = 10_000_000;
const MAX_TOTAL_ATTACHMENT_BYTES = 15_000_000;
const MAX_ATTACHMENT_DIMENSION = 8_192;
const MAX_TOTAL_ATTACHMENT_PIXELS = 24_000_000;
const supportedImageTypes = new Set<Attachment['mimeType']>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const MODEL_NAME_MAX_LENGTH = 28;
const MIN_COMPOSER_INPUT_HEIGHT = 53;
const COMPOSER_RESIZE_STEP = 18;
const MAX_VOICE_DURATION_MS = 180_000;
const afterNextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
type VoiceState = 'idle' | 'preparing' | 'downloading' | 'recording' | 'transcribing';
type ActiveRecording = { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; timeout: number; cancelled: boolean };
const thinkingLabel = (level: string) => level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1);

export function clampComposerInputHeight(contentHeight: number, maximum: number): number {
  return Math.min(Math.max(MIN_COMPOSER_INPUT_HEIGHT, maximum), Math.max(MIN_COMPOSER_INPUT_HEIGHT, Math.ceil(contentHeight)));
}

function compactModelName(name: string): string {
  const characters = Array.from(name);
  if (characters.length <= MODEL_NAME_MAX_LENGTH) return name;
  return `${characters.slice(0, MODEL_NAME_MAX_LENGTH - 1).join('').trimEnd()}…`;
}

export function resampleVoiceAudio(buffer: AudioBuffer, targetRate = 16_000): Float32Array {
  const sourceLength = buffer.length;
  const mono = new Float32Array(sourceLength);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < sourceLength; index += 1) mono[index] = (mono[index] ?? 0) + (data[index] ?? 0) / buffer.numberOfChannels;
  }
  if (buffer.sampleRate === targetRate) return mono;
  const output = new Float32Array(Math.max(1, Math.round(sourceLength * targetRate / buffer.sampleRate)));
  const scale = buffer.sampleRate / targetRate;
  for (let index = 0; index < output.length; index += 1) {
    const position = index * scale;
    const left = Math.min(sourceLength - 1, Math.floor(position));
    const right = Math.min(sourceLength - 1, left + 1);
    const mix = position - left;
    output[index] = (mono[left] ?? 0) * (1 - mix) + (mono[right] ?? 0) * mix;
  }
  return output;
}

export async function resampleVoiceAudioOptimized(buffer: AudioBuffer, targetRate = 16_000): Promise<Float32Array> {
  if (buffer.sampleRate === targetRate || typeof OfflineAudioContext === 'undefined') return resampleVoiceAudio(buffer, targetRate);
  try {
    const outputLength = Math.max(1, Math.round(buffer.length * targetRate / buffer.sampleRate));
    const context = new OfflineAudioContext(1, outputLength, targetRate);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    return rendered.getChannelData(0).slice();
  } catch {
    return resampleVoiceAudio(buffer, targetRate);
  }
}

export function Composer({ onOpenProject }: { onOpenProject: () => void }) {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<Attachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [forking, setForking] = useState(false);
  const [forkNotice, setForkNotice] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [utilityMenuOpen, setUtilityMenuOpen] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const [compactToolbar, setCompactToolbar] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [queueBusyId, setQueueBusyId] = useState<string | null>(null);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [caretPosition, setCaretPosition] = useState(0);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [inputHeight, setInputHeight] = useState(MIN_COMPOSER_INPUT_HEIGHT);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const composer = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const inputShell = useRef<HTMLDivElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const slashList = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const activeRecording = useRef<ActiveRecording | null>(null);
  const runtime = useRuntimeStore((state) => state.runtime);
  const queue = useRuntimeStore((state) => state.queue);
  const queuedItems = queue.items ?? [];
  const sendMessageWithModifier = useUiStore((state) => state.sendMessageWithModifier);
  const composerDraftRequest = useUiStore((state) => state.composerDraftRequest);
  const clearComposerDraftRequest = useUiStore((state) => state.clearComposerDraftRequest);
  const showToast = useUiStore((state) => state.showToast);
  const speech = useUiStore((state) => state.speech);
  const speechDownload = useUiStore((state) => state.speechDownload);
  const connected = runtime.status === 'ready';
  const imageCapable = connected && runtime.model?.supportsImages === true;
  const reasoningCapable = connected && runtime.model?.reasoning === true;
  const permissionLevel = runtime.permissionLevel ?? 'edit';
  const permissionLabel = permissionLevel === 'read-only' ? 'Read only' : permissionLevel === 'full-access' ? 'Full access' : 'Edit files';
  const PermissionIcon = permissionLevel === 'read-only' ? Shield : permissionLevel === 'full-access' ? Zap : ShieldCheck;
  const forkPoint = runtime.forkPoints?.at(-1);
  const canFork = Boolean(runtime.sessionCapabilities?.fork && forkPoint && !runtime.streaming && !runtime.sessionOperation);
  const modelName = runtime.model?.name ?? 'No model';
  const modelLabel = compactModelName(modelName);
  const voiceDownloadProgress = speechDownload?.modelId === speech.modelId
    ? speechDownload.state === 'verifying' ? 100 : Math.min(100, Math.round(speechDownload.downloadedBytes / speechDownload.totalBytes * 100))
    : 0;

  const commandContext = slashCommandContext(draft, caretPosition);
  const commandQuery = commandContext?.query ?? null;
  const commandAtPromptStart = commandContext?.commandPosition ?? false;
  const commandSuggestions = useMemo(
    () => commandQuery === null
      ? []
      : findSlashCommands(runtime.commands ?? [], commandQuery, { includeExtensions: commandAtPromptStart }),
    [commandAtPromptStart, commandQuery, runtime.commands],
  );
  const slashMenuOpen = commandContext !== null && commandSuggestions.length > 0 && !slashDismissed;
  const activeCommandIndex = commandSuggestions.length > 0
    ? Math.min(selectedCommandIndex, commandSuggestions.length - 1)
    : 0;
  const selectedCommand = commandSuggestions[activeCommandIndex];

  useEffect(() => {
    if (!composerDraftRequest) return;
    setDraft(composerDraftRequest.text);
    setImages([]);
    setForkNotice(composerDraftRequest.notice ?? null);
    setCaretPosition(composerDraftRequest.selectAll ? 0 : composerDraftRequest.text.length);
    clearComposerDraftRequest(composerDraftRequest.id);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      const end = composerDraftRequest.text.length;
      textarea.current?.setSelectionRange(composerDraftRequest.selectAll ? 0 : end, end);
    });
  }, [clearComposerDraftRequest, composerDraftRequest]);

  useLayoutEffect(() => {
    const element = composer.current;
    if (!element) return;
    const update = (width: number) => {
      if (width > 0) setCompactToolbar(width < 640);
    };
    update(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const form = composer.current;
    const wrap = form?.closest<HTMLElement>('.composer-wrap');
    const workspace = form?.closest<HTMLElement>('.welcome');
    if (!wrap || !workspace) return;
    const update = () => workspace.style.setProperty('--composer-overlay-space', `${Math.ceil(wrap.getBoundingClientRect().height) + 40}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrap);
    return () => {
      observer.disconnect();
      workspace.style.removeProperty('--composer-overlay-space');
    };
  }, []);

  const maxInputHeight = useCallback(() => {
    const form = composer.current;
    const input = textarea.current;
    const workspace = form?.closest<HTMLElement>('.welcome');
    if (!form || !input) return MIN_COMPOSER_INPUT_HEIGHT;
    const formHeight = form.getBoundingClientRect().height;
    const measuredInputHeight = input.getBoundingClientRect().height || MIN_COMPOSER_INPUT_HEIGHT;
    const fixedHeight = Math.max(71, formHeight - measuredInputHeight);
    const workspaceHeight = workspace?.getBoundingClientRect().height || window.innerHeight;
    return Math.max(MIN_COMPOSER_INPUT_HEIGHT, Math.floor(workspaceHeight * 0.5 - fixedHeight));
  }, []);

  const autoSizeInput = useCallback(() => {
    const input = textarea.current;
    if (!input) return;
    const previousInlineHeight = input.style.height;
    input.style.height = '0px';
    const contentHeight = input.scrollHeight;
    input.style.height = previousInlineHeight;
    setInputHeight((current) => {
      const next = clampComposerInputHeight(contentHeight, maxInputHeight());
      return current === next ? current : next;
    });
  }, [maxInputHeight]);

  const syncInputFades = useCallback(() => {
    const input = textarea.current;
    const shell = inputShell.current;
    if (!input || !shell) return;
    shell.dataset.overflowTop = String(input.scrollTop > 1);
    shell.dataset.overflowBottom = String(input.scrollTop + input.clientHeight < input.scrollHeight - 1);
  }, []);

  useLayoutEffect(() => {
    autoSizeInput();
  }, [autoSizeInput, draft]);

  useLayoutEffect(() => {
    syncInputFades();
  }, [draft, inputHeight, syncInputFades]);

  useEffect(() => {
    const workspace = composer.current?.closest<HTMLElement>('.welcome');
    if (!workspace) return;
    const observer = new ResizeObserver(() => setInputHeight((current) => Math.min(current, maxInputHeight())));
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [maxInputHeight]);

  useEffect(() => () => {
    resizeCleanup.current?.();
    const recording = activeRecording.current;
    if (recording) {
      recording.cancelled = true;
      window.clearTimeout(recording.timeout);
      recording.stream.getTracks().forEach((track) => track.stop());
      if (recording.recorder.state !== 'inactive') recording.recorder.stop();
      recording.chunks.length = 0;
      activeRecording.current = null;
    }
    if ('piDesktop' in window && typeof window.piDesktop.cancelSpeechTranscription === 'function') void window.piDesktop.cancelSpeechTranscription();
  }, []);

  useEffect(() => {
    if (!compactToolbar) setUtilityMenuOpen(false);
  }, [compactToolbar]);

  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [commandContext?.start, commandQuery]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    const activeOption = slashList.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (typeof activeOption?.scrollIntoView === 'function') activeOption.scrollIntoView({ block: 'nearest' });
  }, [activeCommandIndex, slashMenuOpen]);

  const submit = async (behavior: PromptInput['behavior']) => {
    const text = draft.trim();
    if (!text || !connected || !('piDesktop' in window)) return;
    setSubmitting(true);
    setComposerError(null);
    try {
      const promptImages = images.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
      const acceptance = await window.piDesktop.prompt({ text, behavior, ...(promptImages.length ? { images: promptImages } : {}) });
      if (acceptance.accepted) {
        setDraft('');
        setImages([]);
        setForkNotice(null);
      }
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'Pi could not accept this message.');
    } finally {
      setSubmitting(false);
    }
  };

  const selectSlashCommand = (command: SlashCommand) => {
    if (!commandContext) return;
    const replaceStart = commandContext.commandPosition ? 0 : commandContext.start;
    const before = draft.slice(0, replaceStart);
    const after = draft.slice(commandContext.end);
    const commandText = `/${command.name}`;
    const trailingSpace = after.length === 0 || !/^\s/u.test(after) ? ' ' : '';
    const insertion = `${commandText}${trailingSpace}`;
    const nextDraft = `${before}${insertion}${after}`;
    const nextCaret = before.length + insertion.length;
    setDraft(nextDraft);
    setCaretPosition(nextCaret);
    setSlashDismissed(true);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (slashMenuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (commandSuggestions.length > 0) {
          const offset = event.key === 'ArrowDown' ? 1 : -1;
          setSelectedCommandIndex((current) => (current + offset + commandSuggestions.length) % commandSuggestions.length);
        }
        return;
      }
      if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) || event.key === 'Tab') {
        if (selectedCommand) {
          event.preventDefault();
          selectSlashCommand(selectedCommand);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    const modifierPressed = event.metaKey || event.ctrlKey;
    const shouldSend = sendMessageWithModifier
      ? modifierPressed
      : !event.shiftKey && !event.altKey;
    if (event.key === 'Enter' && shouldSend) {
      event.preventDefault();
      void submit(runtime.streaming ? 'followUp' : 'prompt');
    }
  };

  const startComposerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !textarea.current) return;
    event.preventDefault();
    resizeCleanup.current?.();
    const startY = event.clientY;
    const startHeight = textarea.current.getBoundingClientRect().height || inputHeight;
    const maximum = maxInputHeight();
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      setInputHeight(Math.min(maximum, Math.max(MIN_COMPOSER_INPUT_HEIGHT, Math.round(startHeight + startY - moveEvent.clientY))));
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.classList.remove('is-resizing-composer');
      resizeCleanup.current = null;
    };
    resizeCleanup.current = finish;
    document.body.classList.add('is-resizing-composer');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  };

  const resizeComposerWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowUp') next = inputHeight + COMPOSER_RESIZE_STEP;
    else if (event.key === 'ArrowDown') next = inputHeight - COMPOSER_RESIZE_STEP;
    else if (event.key === 'Home') next = MIN_COMPOSER_INPUT_HEIGHT;
    else if (event.key === 'End') next = maxInputHeight();
    if (next === null) return;
    event.preventDefault();
    setInputHeight(Math.min(maxInputHeight(), Math.max(MIN_COMPOSER_INPUT_HEIGHT, next)));
  };

  const addReference = async () => {
    const input = textarea.current;
    if (!input || !('piDesktop' in window)) return;
    setComposerError(null);
    try {
      const relativePath = await window.piDesktop.selectProjectFile();
      if (!relativePath) return;
      const reference = relativePath.includes(' ') ? `@"${relativePath}"` : `@${relativePath}`;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const leadingSpace = start > 0 && !/\s/.test(draft[start - 1] ?? '') ? ' ' : '';
      const trailingSpace = end < draft.length && !/\s/.test(draft[end] ?? '') ? ' ' : '';
      const insertion = `${leadingSpace}${reference}${trailingSpace}`;
      setDraft(`${draft.slice(0, start)}${insertion}${draft.slice(end)}`);
      requestAnimationFrame(() => {
        input.focus();
        const cursor = start + insertion.length;
        input.setSelectionRange(cursor, cursor);
      });
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'Could not reference that project file.');
    }
  };

  const addImageFiles = useCallback((incoming: readonly File[]) => {
    if (!imageCapable) {
      setComposerError('The active model does not support image attachments.');
      return;
    }
    const files = [...incoming].slice(0, Math.max(0, 4 - images.length));
    let pendingBytes = 0;
    const existingBytes = images.reduce((total, image) => total + image.bytes, 0);
    for (const file of files) {
      if (
        !supportedImageTypes.has(file.type as Attachment['mimeType'])
        || file.size > MAX_ATTACHMENT_BYTES
        || existingBytes + pendingBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES
      ) {
        setComposerError(`${file.name || 'Image'} exceeds the supported type, 10 MB per-image, or 15 MB combined limit.`);
        continue;
      }
      pendingBytes += file.size;
      const reader = new FileReader();
      reader.onload = () => {
        void (async () => {
          let pixels = 0;
          if (typeof createImageBitmap === 'function') {
            try {
              const bitmap = await createImageBitmap(file);
              pixels = bitmap.width * bitmap.height;
              const invalid = bitmap.width > MAX_ATTACHMENT_DIMENSION
                || bitmap.height > MAX_ATTACHMENT_DIMENSION
                || pixels > MAX_TOTAL_ATTACHMENT_PIXELS;
              bitmap.close();
              if (invalid) {
                setComposerError(`${file.name || 'Image'} exceeds the 8,192-pixel side or 24-megapixel limit.`);
                return;
              }
            } catch {
              setComposerError(`${file.name || 'Image'} could not be decoded safely.`);
              return;
            }
          }
          const result = typeof reader.result === 'string' ? reader.result : '';
          const data = result.slice(result.indexOf(',') + 1);
          const name = file.name || `pasted-image-${Date.now()}.${file.type.split('/')[1] ?? 'png'}`;
          setImages((current) => {
            const totalBytes = current.reduce((total, image) => total + image.bytes, 0);
            const totalPixels = current.reduce((total, image) => total + image.pixels, 0);
            if (current.length >= 4 || totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES || totalPixels + pixels > MAX_TOTAL_ATTACHMENT_PIXELS) {
              queueMicrotask(() => setComposerError('Image attachments exceed the combined size or pixel budget.'));
              return current;
            }
            return [...current, { name, mimeType: file.type as Attachment['mimeType'], data, bytes: file.size, pixels }];
          });
        })();
      };
      reader.onerror = () => setComposerError(`Could not read ${file.name || 'that image'}.`);
      reader.readAsDataURL(file);
    }
  }, [imageCapable, images]);

  const attachImages = (event: ChangeEvent<HTMLInputElement>) => {
    addImageFiles([...(event.target.files ?? [])]);
    event.target.value = '';
  };

  const pasteImages = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    event.preventDefault();
    addImageFiles(files);
  };

  useEffect(() => {
    const workspace = document.querySelector<HTMLElement>('.workspace');
    if (!workspace) return;
    let depth = 0;
    const containsImages = (transfer: DataTransfer | null) => Boolean(transfer && [...transfer.items].some((item) => item.kind === 'file' && item.type.startsWith('image/')));
    const showDropTarget = (show: boolean) => workspace.classList.toggle('workspace--image-drag', show);
    const onDragEnter = (event: DragEvent) => {
      if (!containsImages(event.dataTransfer) || !workspace.contains(event.target as Node)) return;
      event.preventDefault();
      depth += 1;
      showDropTarget(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!containsImages(event.dataTransfer) || !workspace.contains(event.target as Node)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!workspace.contains(event.target as Node)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) showDropTarget(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!workspace.contains(event.target as Node)) return;
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));
      if (files.length === 0) return;
      event.preventDefault();
      depth = 0;
      showDropTarget(false);
      addImageFiles(files);
      textarea.current?.focus();
    };
    const onWorkspacePaste = (event: globalThis.ClipboardEvent) => {
      if (!workspace.contains(event.target as Node) || event.target === textarea.current) return;
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
      if (files.length === 0) return;
      event.preventDefault();
      addImageFiles(files);
      textarea.current?.focus();
    };
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    document.addEventListener('paste', onWorkspacePaste);
    return () => {
      showDropTarget(false);
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('paste', onWorkspacePaste);
    };
  }, [addImageFiles]);

  const insertTranscript = (transcript: string) => {
    const text = transcript.trim();
    if (!text) throw new Error('No speech was detected. Try again closer to the microphone.');
    const input = textarea.current;
    const selectedStart = input?.selectionStart;
    const selectedEnd = input?.selectionEnd;
    setDraft((current) => {
      const start = selectedStart ?? current.length;
      const end = selectedEnd ?? start;
      const before = current.slice(0, start);
      const after = current.slice(end);
      const leading = before && !/\s$/u.test(before) ? ' ' : '';
      const trailing = after && !/^\s/u.test(after) ? ' ' : '';
      const insertion = `${leading}${text}${trailing}`;
      const nextCaret = start + insertion.length;
      setCaretPosition(nextCaret);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(nextCaret, nextCaret);
      });
      return `${before}${insertion}${after}`;
    });
  };

  const finishVoiceRecording = async (recording: ActiveRecording) => {
    window.clearTimeout(recording.timeout);
    recording.stream.getTracks().forEach((track) => track.stop());
    if (activeRecording.current === recording) activeRecording.current = null;
    if (recording.cancelled) {
      recording.chunks.length = 0;
      return;
    }
    setVoiceState('transcribing');
    try {
      const blob = new Blob(recording.chunks, { type: recording.chunks[0]?.type || recording.recorder.mimeType });
      recording.chunks.length = 0;
      if (blob.size === 0) throw new Error('The microphone did not capture any audio.');
      const context = new AudioContext();
      let decoded: AudioBuffer;
      try {
        decoded = await context.decodeAudioData(await blob.arrayBuffer());
      } finally {
        await context.close();
      }
      if (decoded.duration > MAX_VOICE_DURATION_MS / 1_000 + 1) throw new Error('Voice recordings are limited to three minutes.');
      const pcm = await resampleVoiceAudioOptimized(decoded);
      const audio = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
      if (!('piDesktop' in window)) throw new Error('Voice transcription is unavailable.');
      const result = await window.piDesktop.transcribeSpeech(speech.modelId, audio, speech.language === 'auto' ? undefined : speech.language);
      insertTranscript(result.text);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'Voice transcription failed.');
    } finally {
      setVoiceState('idle');
    }
  };

  const stopVoiceRecording = () => {
    const recording = activeRecording.current;
    if (!recording || recording.recorder.state === 'inactive') return;
    setVoiceState('transcribing');
    recording.recorder.stop();
  };

  const startVoiceRecording = async () => {
    if (!speech.enabled || speechDownload || voiceState !== 'idle' || !connected || !('piDesktop' in window)) return;
    setVoiceState('preparing');
    setComposerError(null);
    let acquiredStream: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Microphone recording is not supported on this system.');
      if (typeof window.piDesktop.ensureSpeechModel !== 'function') throw new Error('Restart Fate UI to activate voice model preparation.');
      // Let the pressed state paint before any native or filesystem work starts. The
      // lightweight ensure route also avoids probing GPU backends on every click.
      await afterNextPaint();
      setVoiceState('downloading');
      await window.piDesktop.ensureSpeechModel(speech.modelId);
      setVoiceState('preparing');
      // Keep the device's native format so opening capture does not reconfigure shared
      // audio hardware and interrupt playback. Decoding is resampled to 16 kHz later.
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(speech.inputDeviceId ? { deviceId: { exact: speech.inputDeviceId } } : {}),
      };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      } catch (error) {
        if (!speech.inputDeviceId || !(error instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        showToast({
          kind: 'warning',
          title: 'Using the system microphone',
          message: 'The selected microphone is unavailable, so this recording uses the system default.',
        });
      }
      acquiredStream = stream;
      const recorder = new MediaRecorder(stream);
      const recording: ActiveRecording = { recorder, stream, chunks: [], timeout: 0, cancelled: false };
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size > 0) recording.chunks.push(event.data); });
      recorder.addEventListener('stop', () => { void finishVoiceRecording(recording); }, { once: true });
      recorder.addEventListener('error', () => {
        if (recording.cancelled) return;
        recording.cancelled = true;
        recording.chunks.length = 0;
        recording.stream.getTracks().forEach((track) => track.stop());
        if (activeRecording.current === recording) activeRecording.current = null;
        setComposerError('The microphone stopped unexpectedly.');
        setVoiceState('idle');
      }, { once: true });
      recording.timeout = window.setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, MAX_VOICE_DURATION_MS);
      activeRecording.current = recording;
      recorder.start(1_000);
      acquiredStream = null;
      setVoiceState('recording');
    } catch (error) {
      acquiredStream?.getTracks().forEach((track) => track.stop());
      const recording = activeRecording.current;
      if (recording) {
        recording.cancelled = true;
        window.clearTimeout(recording.timeout);
        recording.chunks.length = 0;
        activeRecording.current = null;
      }
      setComposerError(error instanceof Error ? error.message : 'Could not start voice transcription.');
      setVoiceState('idle');
    }
  };

  const mutateQueuedMessage = async (id: string, action: QueueMutationInput['action']) => {
    if (!('piDesktop' in window) || queueBusyId) return;
    if (action === 'edit' && (draft.trim() || images.length > 0)) {
      setComposerError('Finish or clear the current draft before editing a queued message.');
      textarea.current?.focus();
      return;
    }
    if (typeof window.piDesktop.mutateQueuedMessage !== 'function') {
      setComposerError('Restart Fate UI to edit queued messages.');
      return;
    }
    setQueueBusyId(id);
    setComposerError(null);
    try {
      const result = await window.piDesktop.mutateQueuedMessage({ id, action });
      useRuntimeStore.getState().setRuntime(result.state);
      if (result.restored) {
        setDraft(result.restored.text);
        setImages((result.restored.images ?? []).map((image) => ({
          ...image,
          bytes: Math.floor(image.data.length * 3 / 4),
          pixels: 0,
        })));
        window.setTimeout(() => {
          textarea.current?.focus();
          const end = result.restored?.text.length ?? 0;
          textarea.current?.setSelectionRange(end, end);
        }, 0);
      }
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'The queued message could not be changed.');
    } finally {
      setQueueBusyId(null);
    }
  };

  const forkConversation = async () => {
    if (!forkPoint || !canFork || !('piDesktop' in window)) return;
    setForking(true);
    setComposerError(null);
    try {
      const result = await window.piDesktop.forkSession(forkPoint.entryId);
      useRuntimeStore.getState().setRuntime(result.state);
      setDraft(result.selectedText ?? forkPoint.text);
      setForkNotice('This is a new session branched from the latest user message. Edit the selected prompt, then send it to continue.');
      showToast({ kind: 'success', title: 'Fork ready', message: 'A new session is active. Edit the selected prompt and send when ready.' });
      textarea.current?.focus();
      requestAnimationFrame(() => {
        textarea.current?.setSelectionRange(0, textarea.current.value.length);
      });
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'The conversation could not be forked.');
    } finally {
      setForking(false);
    }
  };

  const changeModel = async (value: string) => {
    const model = runtime.models.find((candidate) => `${candidate.provider}/${candidate.id}` === value);
    if (!model || !('piDesktop' in window)) return;
    setModelBusy(true);
    setComposerError(null);
    try {
      useRuntimeStore.getState().setRuntime(await window.piDesktop.setModel(model.provider, model.id));
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'The model could not be changed.');
    } finally {
      setModelBusy(false);
    }
  };

  const changeThinking = async (level: typeof thinkingLevels[number]) => {
    if (!('piDesktop' in window) || (!reasoningCapable && level !== 'off')) return;
    setModelBusy(true);
    setComposerError(null);
    try {
      useRuntimeStore.getState().setRuntime(await window.piDesktop.setThinkingLevel(level));
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'The reasoning level could not be changed.');
    } finally {
      setModelBusy(false);
    }
  };

  const changePermissionLevel = async (level: 'read-only' | 'edit' | 'full-access') => {
    if (!connected || runtime.streaming || runtime.sessionOperation || permissionBusy || !('piDesktop' in window)) return;
    if (level === permissionLevel) {
      setPermissionMenuOpen(false);
      setConfirmFullAccess(false);
      return;
    }
    if (typeof window.piDesktop.setPermissionLevel !== 'function') {
      setComposerError('Restart Fate UI to activate permission controls.');
      return;
    }
    setPermissionBusy(true);
    setComposerError(null);
    try {
      useRuntimeStore.getState().setRuntime(await window.piDesktop.setPermissionLevel(level));
      setPermissionMenuOpen(false);
      setConfirmFullAccess(false);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'The permission level could not be changed.');
    } finally {
      setPermissionBusy(false);
    }
  };

  return (
    <div className="composer-wrap">
      {slashMenuOpen && commandContext && (
        <div className="slash-suggestions" role="listbox" aria-label="Skills and commands" id="slash-suggestions">
          <div className="slash-suggestions-heading">
            <span>{commandContext.commandPosition ? 'Skills & commands' : 'Skills & prompts'}</span>
            <code>/{commandQuery}</code>
          </div>
          <div ref={slashList} className="slash-suggestions-list">
            {commandSuggestions.map((command, index) => {
              const source = command.source ?? 'prompt';
              const Icon = source === 'skill' ? Sparkles : source === 'extension' ? Plug : FileText;
              return (
                <button
                  id={`slash-option-${index}`}
                  key={`${source}:${command.name}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeCommandIndex}
                  data-active={index === activeCommandIndex}
                  onMouseEnter={() => setSelectedCommandIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSlashCommand(command)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span className="slash-suggestion-copy">
                    <strong>{slashCommandLabel(command)}</strong>
                    <small>{slashCommandDescription(command)}</small>
                  </span>
                  <em>{source}</em>
                </button>
              );
            })}
          </div>
          <div className="slash-suggestions-hints" aria-hidden="true">
            <span><b>↑↓</b> Navigate</span><span><b>Enter</b> Attach</span><span><b>Esc</b> Close</span>
          </div>
        </div>
      )}
      {queuedItems.length > 0 && (
        <section className="queued-messages" aria-label="Queued messages" aria-live="polite">
          {queuedItems.map((item) => {
            const busy = queueBusyId === item.id;
            return (
              <div className="queued-message" key={item.id} data-behavior={item.behavior}>
                <CornerUpLeft size={13} aria-hidden="true" />
                <AppTooltip content={item.text}><span className="queued-message-preview">{item.text}</span></AppTooltip>
                {item.images?.length ? <span className="queued-message-attachments">{item.images.length} image{item.images.length === 1 ? '' : 's'}</span> : null}
                {item.behavior === 'followUp' ? (
                  <button className="queued-message-steer" type="button" disabled={Boolean(queueBusyId)} onClick={() => void mutateQueuedMessage(item.id, 'steer')}>Steer</button>
                ) : (
                  <span className="queued-message-status">Steering</span>
                )}
                <AppTooltip content="Cancel queued message" wrapTrigger>
                  <button className="queued-message-cancel" type="button" aria-label={`Cancel queued message: ${item.text}`} disabled={Boolean(queueBusyId)} onClick={() => void mutateQueuedMessage(item.id, 'cancel')}>
                    {busy ? <LoaderCircle className="tool-spinner" size={13} /> : <Trash2 size={13} aria-hidden="true" />}
                  </button>
                </AppTooltip>
                <Popover.Root>
                  <Popover.Trigger asChild>
                    <button className="queued-message-more" type="button" aria-label={`More options for queued message: ${item.text}`} disabled={Boolean(queueBusyId)}><Ellipsis size={14} aria-hidden="true" /></button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content className="queued-message-menu" side="top" align="end" sideOffset={7} collisionPadding={12}>
                      <button type="button" onClick={() => void mutateQueuedMessage(item.id, 'edit')}><Pencil size={13} aria-hidden="true" /><span>Edit message</span></button>
                      {item.behavior === 'steer' && <button type="button" onClick={() => void mutateQueuedMessage(item.id, 'followUp')}><CornerUpLeft size={13} aria-hidden="true" /><span>Move to follow-up</span></button>}
                      <button className="queued-message-menu-danger" type="button" onClick={() => void mutateQueuedMessage(item.id, 'cancel')}><Trash2 size={13} aria-hidden="true" /><span>Cancel message</span></button>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              </div>
            );
          })}
        </section>
      )}
      <form
        ref={composer}
        className="composer"
        data-compact-toolbar={compactToolbar ? 'true' : 'false'}
        style={{ '--composer-input-height': `${inputHeight}px` } as CSSProperties}
        onSubmit={(event) => { event.preventDefault(); if (!runtime.streaming) void submit('prompt'); }}
      >
        <AppTooltip content={'Drag upward to enlarge the message input\nUse ↑ or ↓ while focused'}>
          <div
            className="composer-resize-handle"
            role="separator"
            aria-label="Resize message input"
            aria-orientation="horizontal"
            aria-valuemin={MIN_COMPOSER_INPUT_HEIGHT}
            aria-valuemax={maxInputHeight()}
            aria-valuenow={Math.round(inputHeight)}
            tabIndex={0}
            onPointerDown={startComposerResize}
            onKeyDown={resizeComposerWithKeyboard}
          />
        </AppTooltip>
        {forkNotice && (
          <div className="composer-fork-notice" role="status">
            <GitFork size={14} aria-hidden="true" />
            <span><strong>Fork ready</strong><small>{forkNotice}</small></span>
            <button type="button" aria-label="Dismiss fork instructions" onClick={() => setForkNotice(null)}><X size={12} /></button>
          </div>
        )}
        {images.length > 0 && <div className="composer-attachments">{images.map((image, index) => (
          <span key={`${image.name}-${index}`}><img alt="" src={`data:${image.mimeType};base64,${image.data}`} /><em>{image.name}</em><button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages((current) => current.filter((_item, itemIndex) => itemIndex !== index))}><X size={12} /></button></span>
        ))}</div>}
        <div ref={inputShell} className="composer-input-shell" data-overflow-top="false" data-overflow-bottom="false">
          <textarea
            ref={textarea}
            id="pi-composer"
            aria-label="Message Pi"
            aria-controls={slashMenuOpen ? 'slash-suggestions' : undefined}
            aria-expanded={slashMenuOpen}
            aria-autocomplete="list"
            aria-activedescendant={slashMenuOpen && commandSuggestions.length > 0 ? `slash-option-${activeCommandIndex}` : undefined}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setCaretPosition(event.target.selectionStart);
              setSlashDismissed(false);
            }}
            onSelect={(event) => setCaretPosition(event.currentTarget.selectionStart)}
            onScroll={syncInputFades}
            onKeyDown={onKeyDown}
            onPaste={pasteImages}
            placeholder={connected ? runtime.streaming ? 'Ask for follow-up changes…' : 'Ask Pi about your project…' : 'Open and trust a project to begin…'}
            rows={2}
            disabled={!connected}
          />
        </div>
        <div className="composer-toolbar">
          <div className="composer-toolbar-leading">
            {compactToolbar && (
              <Popover.Root
                open={utilityMenuOpen}
                onOpenChange={(nextOpen) => {
                  setUtilityMenuOpen(nextOpen);
                  if (nextOpen) setPermissionMenuOpen(false);
                }}
              >
                <AppTooltip content="Project and attachment tools">
                  <Popover.Trigger asChild>
                    <button className="composer-tools-toggle" type="button" aria-label="Open composer tools">
                      <ChevronUp size={16} aria-hidden="true" />
                    </button>
                  </Popover.Trigger>
                </AppTooltip>
                <Popover.Portal>
                  <Popover.Content className="composer-tools-popover" role="dialog" aria-label="Composer tools" side="top" align="start" sideOffset={9} collisionPadding={12}>
                    <div className="composer-tools-heading">Composer tools</div>
                    <div className="composer-tools-list">
                      <AppTooltip content={runtime.project?.name ?? 'Open project'}>
                        <button type="button" onClick={() => { setUtilityMenuOpen(false); onOpenProject(); }}>
                          <FolderOpen size={14} aria-hidden="true" /><span>{runtime.project?.name ?? 'Open project'}</span>
                        </button>
                      </AppTooltip>
                      <button type="button" aria-label="Add file reference" disabled={!connected} onClick={() => { setUtilityMenuOpen(false); void addReference(); }}>
                        <AtSign size={14} aria-hidden="true" /><span>File reference</span>
                      </button>
                      <button type="button" aria-label="Attach image" disabled={!imageCapable || images.length >= 4} onClick={() => { setUtilityMenuOpen(false); fileInput.current?.click(); }}>
                        <ImagePlus size={14} aria-hidden="true" /><span>Attach image</span>
                      </button>
                      {runtime.sessionCapabilities?.fork && forkPoint && (
                        <button type="button" aria-label="Create new session from latest prompt" disabled={!canFork || forking} onClick={() => { setUtilityMenuOpen(false); void forkConversation(); }}>
                          {forking ? <LoaderCircle className="tool-spinner" size={14} /> : <GitFork size={14} aria-hidden="true" />}<span>New session from prompt</span>
                        </button>
                      )}
                    </div>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            )}
            {!compactToolbar && (
              <>
                <AppTooltip content={runtime.project?.name ?? 'Open project'}><button className="composer-project-button" type="button" onClick={onOpenProject}>{runtime.project?.name ?? 'Project'}</button></AppTooltip>
                <span className="toolbar-divider" />
              </>
            )}
            <Popover.Root
              open={permissionMenuOpen}
              onOpenChange={(nextOpen) => {
                setPermissionMenuOpen(nextOpen);
                if (nextOpen) setUtilityMenuOpen(false);
                if (!nextOpen) setConfirmFullAccess(false);
              }}
            >
              <AppTooltip content={`Permission: ${permissionLabel}`}>
                <Popover.Trigger asChild>
                  <button
                    className="permission-toggle"
                    type="button"
                    data-level={permissionLevel}
                    aria-label={`Permission level: ${permissionLabel}`}
                    aria-haspopup="dialog"
                    disabled={!connected || runtime.streaming || Boolean(runtime.sessionOperation) || permissionBusy}
                  >
                    {permissionBusy ? <LoaderCircle className="tool-spinner" size={16} /> : <PermissionIcon size={16} />}
                  </button>
                </Popover.Trigger>
              </AppTooltip>
              <Popover.Portal>
                <Popover.Content className="permission-popover" role="dialog" aria-label="Permission level" side="top" align="start" sideOffset={9} collisionPadding={12}>
                  {confirmFullAccess ? (
                    <div className="permission-confirm">
                      <TriangleAlert size={17} aria-hidden="true" />
                      <div><strong>Enable Full access?</strong><span>Saved for this session · no sandbox</span></div>
                      <p>Pi can read and modify host files outside this project and run shell commands with your user account.</p>
                      <div className="permission-confirm-actions">
                        <button type="button" onClick={() => setConfirmFullAccess(false)}>Cancel</button>
                        <button type="button" disabled={permissionBusy} onClick={() => void changePermissionLevel('full-access')}>Enable full access</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="permission-popover-heading"><strong>Permission level</strong><span>Saved for this session</span></div>
                      <div className="permission-options">
                        <button type="button" data-active={permissionLevel === 'read-only'} aria-label="Read only" disabled={permissionBusy} onClick={() => void changePermissionLevel('read-only')}>
                          <Shield size={15} aria-hidden="true" /><span><strong>Read only</strong><small>Inspect project files</small></span>
                        </button>
                        <button type="button" data-active={permissionLevel === 'edit'} aria-label="Edit files" disabled={permissionBusy} onClick={() => void changePermissionLevel('edit')}>
                          <ShieldCheck size={15} aria-hidden="true" /><span><strong>Edit files</strong><small>Project-confined read, write, and edit</small></span>
                        </button>
                        <button type="button" className="permission-option--danger" data-active={permissionLevel === 'full-access'} aria-label="Full access" disabled={permissionBusy} onClick={() => permissionLevel === 'full-access' ? void changePermissionLevel('full-access') : setConfirmFullAccess(true)}>
                          <Zap size={15} aria-hidden="true" /><span><strong>Full access</strong><small>Host files and shell · no sandbox</small></span>
                        </button>
                      </div>
                    </>
                  )}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <input ref={fileInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={attachImages} />
            {!compactToolbar && (
              <>
                <AppTooltip content="Insert a project-relative file reference" wrapTrigger><button type="button" aria-label="Add file reference" disabled={!connected} onClick={() => void addReference()}><AtSign size={15} /> File</button></AppTooltip>
                <AppTooltip content={imageCapable ? 'Attach up to four images' : 'The active model does not support images'} wrapTrigger><button type="button" aria-label="Attach image" disabled={!imageCapable || images.length >= 4} onClick={() => fileInput.current?.click()}><ImagePlus size={15} /> Image</button></AppTooltip>
                {runtime.sessionCapabilities?.fork && forkPoint && <AppTooltip content="Branch into a new session from the latest user message" wrapTrigger><button type="button" aria-label="Create new session from latest prompt" disabled={!canFork || forking} onClick={() => void forkConversation()}>{forking ? <LoaderCircle className="tool-spinner" size={15} /> : <GitFork size={15} />} New from prompt</button></AppTooltip>}
              </>
            )}
          </div>
          <div className="composer-toolbar-trailing">
              <div className="composer-model-context">
                {!runtime.streaming && (
                  <Popover.Root open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
                    <AppTooltip content={`Current model: ${modelName}`}>
                      <Popover.Trigger asChild>
                        <button className="model-pill" type="button" aria-label="Model and reasoning settings" disabled={!connected}>
                          {modelBusy && <LoaderCircle className="tool-spinner" size={14} />}
                          <strong>{modelLabel}</strong>
                          <span>{reasoningCapable ? thinkingLabel(runtime.thinkingLevel) : 'No reasoning'}</span>
                          <ChevronDown size={12} />
                        </button>
                      </Popover.Trigger>
                    </AppTooltip>
                    <Popover.Portal>
                      <Popover.Content className="model-popover" role="dialog" aria-label="Model settings" side="top" align="end" sideOffset={10} collisionPadding={12}>
                        <div className="model-popover-heading">
                          <div><strong>Model settings</strong><span>Configure this conversation</span></div>
                          {modelBusy && <LoaderCircle className="tool-spinner" size={14} aria-label="Applying settings" />}
                        </div>
                        <div className="model-setting">
                          <div><strong>Model</strong><span>The model responding to prompts</span></div>
                          <SelectControl
                            label="Model"
                            disabled={!connected || runtime.streaming || modelBusy}
                            value={runtime.model ? `${runtime.model.provider}/${runtime.model.id}` : ''}
                            options={runtime.model
                              ? runtime.models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name, detail: model.provider }))
                              : [{ value: '', label: 'Not connected' }]}
                            onValueChange={(value) => void changeModel(value)}
                          />
                        </div>
                        <div className="model-setting">
                          <div><strong>Reasoning</strong><span>{reasoningCapable ? 'How deeply Pi should think' : 'Not supported by this model'}</span></div>
                          <SelectControl
                            label="Reasoning level"
                            disabled={!reasoningCapable || runtime.streaming || modelBusy}
                            value={reasoningCapable ? runtime.thinkingLevel : 'off'}
                            options={(reasoningCapable ? thinkingLevels : ['off'] as const).map((level) => ({ value: level, label: reasoningCapable ? thinkingLabel(level) : 'Not supported' }))}
                            onValueChange={(value) => void changeThinking(value as typeof thinkingLevels[number])}
                          />
                        </div>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                )}
                {connected && <ContextWheel usage={runtime.contextUsage} {...(runtime.model ? { fallbackWindow: runtime.model.contextWindow } : {})} />}
              </div>
              {speech.enabled && (
                <AppTooltip
                  content={voiceState === 'recording' ? 'Stop and transcribe' : voiceState === 'downloading' ? `Downloading local model… ${voiceDownloadProgress}%` : speechDownload ? 'Wait for the voice model download to finish or cancel it in Settings.' : voiceState === 'preparing' ? 'Preparing microphone…' : voiceState === 'transcribing' ? 'Transcribing locally…' : 'Voice input'}
                  wrapTrigger
                >
                  <button
                    className="voice-button"
                    type="button"
                    data-state={voiceState}
                    aria-label={voiceState === 'recording' ? 'Stop voice recording' : voiceState === 'downloading' || speechDownload ? 'Voice unavailable while a model downloads' : voiceState === 'transcribing' ? 'Transcribing voice' : 'Start voice recording'}
                    aria-pressed={voiceState === 'recording'}
                    disabled={!connected || Boolean(speechDownload) || voiceState === 'preparing' || voiceState === 'downloading' || voiceState === 'transcribing'}
                    onClick={() => voiceState === 'recording' ? stopVoiceRecording() : void startVoiceRecording()}
                  >
                    {voiceState === 'preparing' || voiceState === 'downloading' || voiceState === 'transcribing' ? <LoaderCircle className="tool-spinner" size={16} /> : voiceState === 'recording' ? <Square size={13} fill="currentColor" /> : <Mic size={17} />}
                  </button>
                </AppTooltip>
              )}
              {runtime.streaming ? (
                <button className="send-button stop-button" type="button" aria-label="Stop Pi" onClick={() => { if ('piDesktop' in window) void window.piDesktop.abort(); }}><Square size={14} fill="currentColor" /></button>
              ) : (
                <AppTooltip content={sendMessageWithModifier ? 'Send · Ctrl/⌘ Enter' : 'Send · Enter'}>
                  <span className="send-tooltip-trigger"><button className="send-button" type="submit" aria-label="Send message" disabled={!connected || !draft.trim() || submitting}>{submitting ? <LoaderCircle className="tool-spinner" size={16} /> : <ArrowUp size={18} />}</button></span>
                </AppTooltip>
              )}
          </div>
        </div>
      </form>
      {composerError && <p className="composer-error" role="alert">{composerError}</p>}
    </div>
  );
}
