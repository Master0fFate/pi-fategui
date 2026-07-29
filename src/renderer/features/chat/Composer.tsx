import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { ArrowUp, AtSign, ChevronDown, ChevronUp, CornerUpLeft, Ellipsis, FileText, FolderOpen, GitFork, ImagePlus, LoaderCircle, Mic, Pencil, Plug, Shield, ShieldCheck, Sparkles, Trash2, TriangleAlert, X, Zap } from 'lucide-react';
import { type ChangeEvent, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
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
const SEND_HOLD_TO_ABORT_MS = 2_000;
const afterNextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
type VoiceState = 'idle' | 'preparing' | 'downloading' | 'recording' | 'transcribing';
type VoiceInsertionTarget = { start: number; end: number; scrollTop: number; sessionId: string | null; projectPath: string | null };
type ActiveRecording = { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; timeout: number; cancelled: boolean; insertion: VoiceInsertionTarget; attempt: number };
type SendHoldGesture = {
  pointerId: number;
  timeout: number;
  startedAt: number;
  aborted: boolean;
  target: HTMLButtonElement;
  detachListeners: () => void;
};
type SendClickOutcome = 'submit-follow-up' | 'cancel';
const thinkingLabel = (level: string) => level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1);
const normalizedPointerId = (pointerId: number) => Number.isFinite(pointerId) ? pointerId : 1;

export function clampComposerInputHeight(contentHeight: number, maximum: number): number {
  return Math.min(Math.max(MIN_COMPOSER_INPUT_HEIGHT, maximum), Math.max(MIN_COMPOSER_INPUT_HEIGHT, Math.ceil(contentHeight)));
}

function compactModelName(name: string): string {
  const characters = Array.from(name);
  if (characters.length <= MODEL_NAME_MAX_LENGTH) return name;
  return `${characters.slice(0, MODEL_NAME_MAX_LENGTH - 1).join('').trimEnd()}…`;
}

export function uniqueAttachmentName(name: string, existingNames: readonly string[]): string {
  const fallbackName = name || 'pasted-image.png';
  if (!existingNames.includes(fallbackName)) return fallbackName;
  const extensionIndex = fallbackName.lastIndexOf('.');
  const base = extensionIndex > 0 ? fallbackName.slice(0, extensionIndex) : fallbackName;
  const extension = extensionIndex > 0 ? fallbackName.slice(extensionIndex) : '';
  let suffix = 1;
  let candidate = `${base}-${suffix}${extension}`;
  while (existingNames.includes(candidate)) candidate = `${base}-${++suffix}${extension}`;
  return candidate;
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
  const [previewImage, setPreviewImage] = useState<Attachment | null>(null);
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
  const draftRef = useRef(draft);
  const imagesRef = useRef(images);
  const draftRevision = useRef(0);
  const imagesRevision = useRef(0);
  const submittingRef = useRef(false);
  const queueBusyRef = useRef(false);
  const modelBusyRef = useRef(false);
  const permissionBusyRef = useRef(false);
  const forkingRef = useRef(false);
  const sendHoldGesture = useRef<SendHoldGesture | null>(null);
  const sendClickOutcome = useRef<SendClickOutcome | null>(null);
  const voiceRestoreFrames = useRef(new Set<number>());
  const voiceAttempt = useRef(0);
  const voiceStateRef = useRef<VoiceState>('idle');
  const voiceSelectionKey = useRef<string | null>(null);
  const mounted = useRef(true);
  const runtime = useRuntimeStore(useShallow((state) => ({
    status: state.runtime.status,
    project: state.runtime.project,
    sessionId: state.runtime.sessionId,
    streaming: state.runtime.streaming,
    activeSessionRunning: state.runtime.activeSessionRunning,
    model: state.runtime.model,
    pendingModel: state.runtime.pendingModel,
    models: state.runtime.models,
    thinkingLevel: state.runtime.thinkingLevel,
    pendingThinkingLevel: state.runtime.pendingThinkingLevel,
    permissionLevel: state.runtime.permissionLevel,
    commands: state.runtime.commands,
    contextUsage: state.runtime.contextUsage,
    forkPoints: state.runtime.forkPoints,
    sessionCapabilities: state.runtime.sessionCapabilities,
    sessionOperation: state.runtime.sessionOperation,
  })));
  const queue = useRuntimeStore((state) => state.queue);
  const queuedItems = queue.items ?? [];
  const sendMessageWithModifier = useUiStore((state) => state.sendMessageWithModifier);
  const composerDraftRequest = useUiStore((state) => state.composerDraftRequest);
  const clearComposerDraftRequest = useUiStore((state) => state.clearComposerDraftRequest);
  const showToast = useUiStore((state) => state.showToast);
  const speech = useUiStore((state) => state.speech);
  const speechDownload = useUiStore((state) => state.speechDownload);
  const connected = runtime.status === 'ready';
  const nextModel = runtime.pendingModel ?? runtime.model;
  const nextThinkingLevel = runtime.pendingThinkingLevel ?? runtime.thinkingLevel;
  const imageCapable = connected && nextModel?.supportsImages === true;
  const reasoningCapable = connected && nextModel?.reasoning === true;
  const permissionLevel = runtime.permissionLevel ?? 'edit';
  const permissionLabel = permissionLevel === 'read-only' ? 'Read only' : permissionLevel === 'full-access' ? 'Full access' : 'Edit files';
  const PermissionIcon = permissionLevel === 'read-only' ? Shield : permissionLevel === 'full-access' ? Zap : ShieldCheck;
  const forkPoint = runtime.forkPoints?.at(-1);
  const activeSessionRunning = runtime.activeSessionRunning ?? runtime.streaming;
  const canFork = Boolean(runtime.sessionCapabilities?.fork && forkPoint && !activeSessionRunning && !runtime.sessionOperation);
  const forkTooltip = forking
    ? 'Creating the new session…'
    : runtime.sessionOperation
      ? 'Wait for the current session operation to finish'
      : activeSessionRunning
        ? 'Wait for this session to finish before branching'
        : 'Branch into a new session from the latest user message';
  const currentModelName = runtime.model?.name ?? 'No model';
  const nextModelName = nextModel?.name ?? 'No model';
  const modelLabel = compactModelName(nextModelName);
  const modelTooltip = `Current: ${currentModelName}\nNext: ${nextModelName}`;
  const voiceDownloadProgress = speechDownload?.modelId === speech.modelId
    ? speechDownload.state === 'verifying' ? 100 : Math.min(100, Math.round(speechDownload.downloadedBytes / speechDownload.totalBytes * 100))
    : 0;

  const updateDraft = useCallback((next: string) => {
    draftRef.current = next;
    draftRevision.current += 1;
    setDraft(next);
  }, []);
  const updateImages = useCallback((update: Attachment[] | ((current: Attachment[]) => Attachment[])) => {
    const current = imagesRef.current;
    const next = typeof update === 'function' ? update(current) : update;
    if (next === current) return;
    imagesRef.current = next;
    imagesRevision.current += 1;
    setImages(next);
  }, []);
  const updateVoiceState = useCallback((next: VoiceState) => {
    voiceStateRef.current = next;
    if (mounted.current) setVoiceState(next);
  }, []);
  const isCurrentVoiceAttempt = useCallback((attempt: number) => mounted.current && voiceAttempt.current === attempt, []);
  const clearSendHoldGesture = useCallback((pointerId?: number) => {
    const gesture = sendHoldGesture.current;
    if (!gesture || (pointerId !== undefined && gesture.pointerId !== pointerId)) return null;
    sendHoldGesture.current = null;
    window.clearTimeout(gesture.timeout);
    gesture.detachListeners();
    try {
      if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
    } catch { /* Capture may already have been released by the browser. */ }
    return gesture;
  }, []);

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
    updateDraft(composerDraftRequest.text);
    updateImages([]);
    setForkNotice(composerDraftRequest.notice ?? null);
    setCaretPosition(composerDraftRequest.selectAll ? 0 : composerDraftRequest.text.length);
    clearComposerDraftRequest(composerDraftRequest.id);
    requestAnimationFrame(() => {
      textarea.current?.focus({ preventScroll: true });
      const end = composerDraftRequest.text.length;
      textarea.current?.setSelectionRange(composerDraftRequest.selectAll ? 0 : end, end);
    });
  }, [clearComposerDraftRequest, composerDraftRequest, updateDraft, updateImages]);

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

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      voiceAttempt.current += 1;
      voiceStateRef.current = 'idle';
      resizeCleanup.current?.();
      clearSendHoldGesture();
      sendClickOutcome.current = null;
      submittingRef.current = false;
      queueBusyRef.current = false;
      modelBusyRef.current = false;
      permissionBusyRef.current = false;
      forkingRef.current = false;
      for (const frame of voiceRestoreFrames.current) cancelAnimationFrame(frame);
      voiceRestoreFrames.current.clear();
      const recording = activeRecording.current;
      if (recording) {
        recording.cancelled = true;
        window.clearTimeout(recording.timeout);
        recording.stream.getTracks().forEach((track) => track.stop());
        if (recording.recorder.state !== 'inactive') recording.recorder.stop();
        recording.chunks.length = 0;
        activeRecording.current = null;
      }
      if ('piDesktop' in window && typeof window.piDesktop.cancelSpeechTranscription === 'function') {
        void window.piDesktop.cancelSpeechTranscription().catch(() => undefined);
      }
    };
  }, [clearSendHoldGesture]);

  useEffect(() => {
    if (runtime.streaming) return;
    if (clearSendHoldGesture()) sendClickOutcome.current = 'cancel';
  }, [clearSendHoldGesture, runtime.streaming]);

  useEffect(() => {
    const selectionKey = `${runtime.project?.path ?? ''}\u0000${runtime.sessionId ?? ''}`;
    if (voiceSelectionKey.current === null) {
      voiceSelectionKey.current = selectionKey;
      return;
    }
    if (voiceSelectionKey.current === selectionKey) return;
    voiceSelectionKey.current = selectionKey;
    if (voiceStateRef.current === 'idle') return;
    voiceAttempt.current += 1;
    const recording = activeRecording.current;
    if (recording) {
      recording.cancelled = true;
      window.clearTimeout(recording.timeout);
      recording.stream.getTracks().forEach((track) => track.stop());
      activeRecording.current = null;
      if (recording.recorder.state !== 'inactive') recording.recorder.stop();
      recording.chunks.length = 0;
    }
    updateVoiceState('idle');
    if ('piDesktop' in window && typeof window.piDesktop.cancelSpeechTranscription === 'function') {
      void window.piDesktop.cancelSpeechTranscription().catch(() => undefined);
    }
  }, [runtime.project?.path, runtime.sessionId, updateVoiceState]);

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
    const runtimeNow = useRuntimeStore.getState().runtime;
    const originSessionId = runtimeNow.sessionId;
    const originProjectPath = runtimeNow.project?.path ?? null;
    const submittedDraft = draftRef.current;
    const submittedDraftRevision = draftRevision.current;
    const submittedImages = imagesRef.current;
    const submittedImagesRevision = imagesRevision.current;
    const text = submittedDraft.trim();
    if (!text || runtimeNow.status !== 'ready' || submittingRef.current || !('piDesktop' in window)) return;
    submittingRef.current = true;
    if (mounted.current) {
      setSubmitting(true);
      setComposerError(null);
    }
    try {
      const promptImages = submittedImages.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
      const acceptance = await window.piDesktop.prompt({ text, behavior, ...(promptImages.length ? { images: promptImages } : {}) });
      if (!acceptance.accepted || !mounted.current) return;
      const currentRuntime = useRuntimeStore.getState().runtime;
      if (currentRuntime.sessionId !== originSessionId || (currentRuntime.project?.path ?? null) !== originProjectPath) return;

      if (draftRevision.current === submittedDraftRevision) {
        updateDraft('');
        setForkNotice(null);
      }
      if (imagesRevision.current === submittedImagesRevision) {
        updateImages([]);
      } else if (submittedImages.length > 0) {
        const submitted = new Set(submittedImages);
        updateImages((current) => {
          const remaining = current.filter((image) => !submitted.has(image));
          return remaining.length === current.length ? current : remaining;
        });
      }
    } catch (error) {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'Pi could not accept this message.');
    } finally {
      submittingRef.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const abortSendGesture = (gesture: SendHoldGesture) => {
    if (gesture.aborted || sendHoldGesture.current !== gesture) return gesture.aborted;
    const runtimeNow = useRuntimeStore.getState().runtime;
    if (runtimeNow.status !== 'ready' || !runtimeNow.streaming || !('piDesktop' in window)) return false;
    gesture.aborted = true;
    void window.piDesktop.abort().catch((error: unknown) => {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'Pi could not be stopped.');
    });
    return true;
  };

  const finishSendHold = (pointerId: number) => {
    const gesture = sendHoldGesture.current;
    if (!gesture || gesture.pointerId !== pointerId) return;
    if (!gesture.aborted && performance.now() - gesture.startedAt >= SEND_HOLD_TO_ABORT_MS) abortSendGesture(gesture);
    const runtimeNow = useRuntimeStore.getState().runtime;
    const outcome: SendClickOutcome = !gesture.aborted && runtimeNow.status === 'ready' && runtimeNow.streaming
      ? 'submit-follow-up'
      : 'cancel';
    clearSendHoldGesture(pointerId);
    sendClickOutcome.current = outcome;
  };

  const cancelSendHold = (pointerId: number) => {
    if (!clearSendHoldGesture(pointerId)) return;
    sendClickOutcome.current = 'cancel';
  };

  const startSendHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    sendClickOutcome.current = null;
    // JSDOM/legacy MouseEvent fallbacks expose no pointerType and report a
    // meaningless false isPrimary; real touch/pen pointers must be primary.
    if ((Number.isFinite(event.button) && event.button !== 0) || (event.pointerType && event.isPrimary === false) || sendHoldGesture.current) return;
    const runtimeNow = useRuntimeStore.getState().runtime;
    if (runtimeNow.status !== 'ready' || !runtimeNow.streaming) return;

    const pointerId = normalizedPointerId(event.pointerId);
    const target = event.currentTarget;
    const onWindowPointerUp = (pointerEvent: globalThis.PointerEvent) => {
      if (normalizedPointerId(pointerEvent.pointerId) !== pointerId) return;
      const pointerTarget = pointerEvent.target;
      if (pointerTarget instanceof Node && target.contains(pointerTarget)) finishSendHold(pointerId);
      else cancelSendHold(pointerId);
    };
    const onWindowPointerCancel = (pointerEvent: globalThis.PointerEvent) => cancelSendHold(normalizedPointerId(pointerEvent.pointerId));
    const gesture: SendHoldGesture = {
      pointerId,
      timeout: 0,
      startedAt: performance.now(),
      aborted: false,
      target,
      detachListeners: () => {
        window.removeEventListener('pointerup', onWindowPointerUp);
        window.removeEventListener('pointercancel', onWindowPointerCancel);
      },
    };
    sendHoldGesture.current = gesture;
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerCancel);
    try { target.setPointerCapture(pointerId); } catch { /* Window listeners preserve release handling when capture is unavailable. */ }
    gesture.timeout = window.setTimeout(() => {
      if (sendHoldGesture.current !== gesture || gesture.aborted) return;
      if (!abortSendGesture(gesture)) cancelSendHold(pointerId);
    }, SEND_HOLD_TO_ABORT_MS);
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
    updateDraft(nextDraft);
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
      if (!relativePath || !mounted.current) return;
      const reference = relativePath.includes(' ') ? `@"${relativePath}"` : `@${relativePath}`;
      const currentDraft = draftRef.current;
      const start = Math.min(currentDraft.length, input.selectionStart);
      const end = Math.min(currentDraft.length, Math.max(start, input.selectionEnd));
      const leadingSpace = start > 0 && !/\s/.test(currentDraft[start - 1] ?? '') ? ' ' : '';
      const trailingSpace = end < currentDraft.length && !/\s/.test(currentDraft[end] ?? '') ? ' ' : '';
      const insertion = `${leadingSpace}${reference}${trailingSpace}`;
      updateDraft(`${currentDraft.slice(0, start)}${insertion}${currentDraft.slice(end)}`);
      requestAnimationFrame(() => {
        if (!mounted.current) return;
        input.focus({ preventScroll: true });
        const cursor = start + insertion.length;
        input.setSelectionRange(cursor, cursor);
      });
    } catch (error) {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'Could not reference that project file.');
    }
  };

  const addImageFiles = useCallback((incoming: readonly File[]) => {
    if (!imageCapable) {
      setComposerError('The model selected for the next message does not support image attachments.');
      return;
    }
    const currentImages = imagesRef.current;
    const files = [...incoming].slice(0, Math.max(0, 4 - currentImages.length));
    let pendingBytes = 0;
    const existingBytes = currentImages.reduce((total, image) => total + image.bytes, 0);
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
          if (!mounted.current) return;
          let pixels = 0;
          if (typeof createImageBitmap === 'function') {
            try {
              const bitmap = await createImageBitmap(file);
              if (!mounted.current) { bitmap.close(); return; }
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
              if (mounted.current) setComposerError(`${file.name || 'Image'} could not be decoded safely.`);
              return;
            }
          }
          if (!mounted.current) return;
          const result = typeof reader.result === 'string' ? reader.result : '';
          const data = result.slice(result.indexOf(',') + 1);
          const sourceName = file.name || `pasted-image.${file.type.split('/')[1] ?? 'png'}`;
          updateImages((current) => {
            const totalBytes = current.reduce((total, image) => total + image.bytes, 0);
            const totalPixels = current.reduce((total, image) => total + image.pixels, 0);
            if (current.length >= 4 || totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES || totalPixels + pixels > MAX_TOTAL_ATTACHMENT_PIXELS) {
              queueMicrotask(() => { if (mounted.current) setComposerError('Image attachments exceed the combined size or pixel budget.'); });
              return current;
            }
            const name = uniqueAttachmentName(sourceName, current.map((image) => image.name));
            return [...current, { name, mimeType: file.type as Attachment['mimeType'], data, bytes: file.size, pixels }];
          });
        })();
      };
      reader.onerror = () => { if (mounted.current) setComposerError(`Could not read ${file.name || 'that image'}.`); };
      reader.readAsDataURL(file);
    }
  }, [imageCapable, updateImages]);

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

  const insertTranscript = (transcript: string, target: VoiceInsertionTarget) => {
    const text = transcript.trim();
    if (!text) throw new Error('No speech was detected. Try again closer to the microphone.');
    const current = draftRef.current;
    const selectionStart = Number.isFinite(target.start) ? Math.max(0, target.start) : current.length;
    const selectionEnd = Number.isFinite(target.end) ? Math.max(selectionStart, target.end) : selectionStart;
    const start = Math.min(current.length, selectionStart);
    const end = Math.min(current.length, Math.max(start, selectionEnd));
    const before = current.slice(0, start);
    const after = current.slice(end);
    const leading = before && !/\s$/u.test(before) ? ' ' : '';
    const trailing = after && !/^\s/u.test(after) ? ' ' : '';
    const insertion = `${leading}${text}${trailing}`;
    const nextCaret = start + insertion.length;
    const nextDraft = `${before}${insertion}${after}`;
    updateDraft(nextDraft);
    setCaretPosition(nextCaret);

    const scheduleRestore = (callback: () => void) => {
      let frame = 0;
      frame = requestAnimationFrame(() => {
        voiceRestoreFrames.current.delete(frame);
        callback();
      });
      voiceRestoreFrames.current.add(frame);
    };
    const restoreViewport = () => {
      const input = textarea.current;
      if (!input || !mounted.current) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(nextCaret, nextCaret);
      input.scrollTop = Math.max(0, target.scrollTop);
      syncInputFades();
    };
    scheduleRestore(() => {
      restoreViewport();
      // Auto-sizing and focus can each adjust the textarea viewport. A second
      // paint deterministically restores the viewport after both layout passes.
      scheduleRestore(restoreViewport);
    });
  };

  const finishVoiceRecording = async (recording: ActiveRecording) => {
    window.clearTimeout(recording.timeout);
    recording.stream.getTracks().forEach((track) => track.stop());
    if (activeRecording.current === recording) activeRecording.current = null;
    const targetSelectionIsCurrent = () => {
      const current = useRuntimeStore.getState().runtime;
      return current.sessionId === recording.insertion.sessionId
        && (current.project?.path ?? null) === recording.insertion.projectPath;
    };
    if (recording.cancelled || !isCurrentVoiceAttempt(recording.attempt)) {
      recording.chunks.length = 0;
      return;
    }
    if (!targetSelectionIsCurrent()) {
      recording.chunks.length = 0;
      updateVoiceState('idle');
      return;
    }
    updateVoiceState('transcribing');
    try {
      const blob = new Blob(recording.chunks, { type: recording.chunks[0]?.type || recording.recorder.mimeType });
      recording.chunks.length = 0;
      if (blob.size === 0) throw new Error('The microphone did not capture any audio.');
      const context = new AudioContext();
      let decoded: AudioBuffer;
      try {
        const encoded = await blob.arrayBuffer();
        if (!isCurrentVoiceAttempt(recording.attempt)) return;
        decoded = await context.decodeAudioData(encoded);
      } finally {
        await context.close();
      }
      if (!isCurrentVoiceAttempt(recording.attempt)) return;
      if (decoded.duration > MAX_VOICE_DURATION_MS / 1_000 + 1) throw new Error('Voice recordings are limited to three minutes.');
      const pcm = await resampleVoiceAudioOptimized(decoded);
      if (!isCurrentVoiceAttempt(recording.attempt) || !targetSelectionIsCurrent()) return;
      const audio = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
      if (!('piDesktop' in window) || typeof window.piDesktop.transcribeSpeech !== 'function') throw new Error('Voice transcription is unavailable.');
      const result = await window.piDesktop.transcribeSpeech(speech.modelId, audio, speech.language === 'auto' ? undefined : speech.language);
      if (recording.cancelled || !isCurrentVoiceAttempt(recording.attempt) || !targetSelectionIsCurrent()) return;
      insertTranscript(result.text, recording.insertion);
    } catch (error) {
      if (!recording.cancelled && isCurrentVoiceAttempt(recording.attempt)) {
        setComposerError(error instanceof Error ? error.message : 'Voice transcription failed.');
      }
    } finally {
      if (isCurrentVoiceAttempt(recording.attempt)) updateVoiceState('idle');
    }
  };

  const stopVoiceRecording = () => {
    const recording = activeRecording.current;
    if (!recording || recording.recorder.state === 'inactive') return;
    updateVoiceState('transcribing');
    recording.recorder.stop();
  };

  const startVoiceRecording = async () => {
    const runtimeNow = useRuntimeStore.getState().runtime;
    if (!speech.enabled || speechDownload || voiceStateRef.current !== 'idle' || runtimeNow.status !== 'ready' || !('piDesktop' in window)) return;
    const attempt = voiceAttempt.current + 1;
    voiceAttempt.current = attempt;
    const input = textarea.current;
    const selectionStart = input?.selectionStart ?? draftRef.current.length;
    const insertion: VoiceInsertionTarget = {
      start: selectionStart,
      end: input?.selectionEnd ?? selectionStart,
      scrollTop: Math.max(0, input?.scrollTop ?? 0),
      sessionId: runtimeNow.sessionId,
      projectPath: runtimeNow.project?.path ?? null,
    };
    updateVoiceState('preparing');
    setComposerError(null);
    let acquiredStream: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Microphone recording is not supported on this system.');
      if (typeof window.piDesktop.ensureSpeechModel !== 'function') throw new Error('Restart Fate UI to activate voice model preparation.');
      // Paint the pressed state before native/filesystem work without delaying by an arbitrary timeout.
      await afterNextPaint();
      if (!isCurrentVoiceAttempt(attempt)) return;
      updateVoiceState('downloading');
      await window.piDesktop.ensureSpeechModel(speech.modelId);
      if (!isCurrentVoiceAttempt(attempt)) return;
      updateVoiceState('preparing');
      // Keep the device's native format so capture does not reconfigure shared audio hardware.
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
        if (!isCurrentVoiceAttempt(attempt)) throw error;
        if (!speech.inputDeviceId || !(error instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        if (isCurrentVoiceAttempt(attempt)) {
          showToast({
            kind: 'warning',
            title: 'Using the system microphone',
            message: 'The selected microphone is unavailable, so this recording uses the system default.',
          });
        }
      }
      acquiredStream = stream;
      if (!isCurrentVoiceAttempt(attempt)) {
        stream.getTracks().forEach((track) => track.stop());
        acquiredStream = null;
        return;
      }
      const recorder = new MediaRecorder(stream);
      const recording: ActiveRecording = { recorder, stream, chunks: [], timeout: 0, cancelled: false, insertion, attempt };
      recorder.addEventListener('dataavailable', (event) => {
        if (!recording.cancelled && isCurrentVoiceAttempt(attempt) && event.data.size > 0) recording.chunks.push(event.data);
      });
      recorder.addEventListener('stop', () => { void finishVoiceRecording(recording); }, { once: true });
      recorder.addEventListener('error', () => {
        if (recording.cancelled) return;
        recording.cancelled = true;
        window.clearTimeout(recording.timeout);
        recording.chunks.length = 0;
        recording.stream.getTracks().forEach((track) => track.stop());
        if (activeRecording.current === recording) activeRecording.current = null;
        if (isCurrentVoiceAttempt(attempt)) {
          setComposerError('The microphone stopped unexpectedly.');
          updateVoiceState('idle');
        }
      }, { once: true });
      recording.timeout = window.setTimeout(() => {
        if (isCurrentVoiceAttempt(attempt) && recorder.state !== 'inactive') recorder.stop();
      }, MAX_VOICE_DURATION_MS);
      activeRecording.current = recording;
      recorder.start(1_000);
      acquiredStream = null;
      updateVoiceState('recording');
    } catch (error) {
      acquiredStream?.getTracks().forEach((track) => track.stop());
      const recording = activeRecording.current;
      if (recording?.attempt === attempt) {
        recording.cancelled = true;
        window.clearTimeout(recording.timeout);
        recording.stream.getTracks().forEach((track) => track.stop());
        recording.chunks.length = 0;
        activeRecording.current = null;
      }
      if (isCurrentVoiceAttempt(attempt)) {
        setComposerError(error instanceof Error ? error.message : 'Could not start voice transcription.');
        updateVoiceState('idle');
      }
    }
  };

  const mutateQueuedMessage = async (id: string, action: QueueMutationInput['action']) => {
    if (!('piDesktop' in window) || queueBusyRef.current) return;
    if (action === 'edit' && (draftRef.current.trim() || imagesRef.current.length > 0)) {
      setComposerError('Finish or clear the current draft before editing a queued message.');
      textarea.current?.focus({ preventScroll: true });
      return;
    }
    if (typeof window.piDesktop.mutateQueuedMessage !== 'function') {
      setComposerError('Restart Fate UI to edit queued messages.');
      return;
    }
    const originRuntime = useRuntimeStore.getState().runtime;
    const originSessionId = originRuntime.sessionId;
    const originProjectPath = originRuntime.project?.path;
    queueBusyRef.current = true;
    setQueueBusyId(id);
    setComposerError(null);
    try {
      const result = await window.piDesktop.mutateQueuedMessage({ id, action });
      if (!mounted.current) return;
      const current = useRuntimeStore.getState().runtime;
      const selectionIsOrigin = current.sessionId === originSessionId && current.project?.path === originProjectPath;
      const resultIsCurrent = current.sessionId === result.state.sessionId && current.project?.path === result.state.project?.path;
      if (!selectionIsOrigin && !resultIsCurrent) return;
      useRuntimeStore.getState().setRuntime(result.state);
      if (result.restored) {
        updateDraft(result.restored.text);
        updateImages((result.restored.images ?? []).map((image) => ({
          ...image,
          bytes: Math.floor(image.data.length * 3 / 4),
          pixels: 0,
        })));
        requestAnimationFrame(() => {
          if (!mounted.current) return;
          textarea.current?.focus({ preventScroll: true });
          const end = result.restored?.text.length ?? 0;
          textarea.current?.setSelectionRange(end, end);
        });
      }
    } catch (error) {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'The queued message could not be changed.');
    } finally {
      queueBusyRef.current = false;
      if (mounted.current) setQueueBusyId(null);
    }
  };

  const forkConversation = async () => {
    if (!('piDesktop' in window) || forkingRef.current) return;
    const origin = useRuntimeStore.getState().runtime;
    const point = origin.forkPoints?.at(-1);
    const running = origin.activeSessionRunning ?? origin.streaming;
    if (!point || !origin.sessionCapabilities?.fork || running || origin.sessionOperation) return;
    forkingRef.current = true;
    setForking(true);
    setComposerError(null);
    try {
      const result = await window.piDesktop.forkSession(point.entryId);
      if (!mounted.current) return;
      const current = useRuntimeStore.getState().runtime;
      const selectionIsOrigin = current.sessionId === origin.sessionId && current.project?.path === origin.project?.path;
      const resultIsCurrent = current.sessionId === result.state.sessionId && current.project?.path === result.state.project?.path;
      if (!selectionIsOrigin && !resultIsCurrent) return;
      useRuntimeStore.getState().setRuntime(result.state);
      updateDraft(result.selectedText ?? point.text);
      setForkNotice('This is a new session branched from the latest user message. Edit the selected prompt, then send it to continue.');
      showToast({ kind: 'success', title: 'Fork ready', message: 'A new session is active. Edit the selected prompt and send when ready.' });
      textarea.current?.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        if (mounted.current) textarea.current?.setSelectionRange(0, textarea.current.value.length);
      });
    } catch (error) {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'The conversation could not be forked.');
    } finally {
      forkingRef.current = false;
      if (mounted.current) setForking(false);
    }
  };

  const changeModel = async (value: string) => {
    if (!('piDesktop' in window) || modelBusyRef.current) return;
    const origin = useRuntimeStore.getState().runtime;
    const model = origin.models.find((candidate) => `${candidate.provider}/${candidate.id}` === value);
    if (!model) return;
    modelBusyRef.current = true;
    setModelBusy(true);
    setComposerError(null);
    try {
      const state = await window.piDesktop.setModel(model.provider, model.id);
      if (!mounted.current) return;
      const current = useRuntimeStore.getState().runtime;
      const selectionIsOrigin = current.sessionId === origin.sessionId && current.project?.path === origin.project?.path;
      const resultIsCurrent = current.sessionId === state.sessionId && current.project?.path === state.project?.path;
      if (selectionIsOrigin || resultIsCurrent) useRuntimeStore.getState().setRuntime(state);
    } catch (error) {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'The model could not be changed.');
    } finally {
      modelBusyRef.current = false;
      if (mounted.current) setModelBusy(false);
    }
  };

  const changeThinking = async (level: typeof thinkingLevels[number]) => {
    if (!('piDesktop' in window) || modelBusyRef.current) return;
    const origin = useRuntimeStore.getState().runtime;
    const selectedModel = origin.pendingModel ?? origin.model;
    if (!selectedModel?.reasoning && level !== 'off') return;
    modelBusyRef.current = true;
    setModelBusy(true);
    setComposerError(null);
    try {
      const state = await window.piDesktop.setThinkingLevel(level);
      if (!mounted.current) return;
      const current = useRuntimeStore.getState().runtime;
      const selectionIsOrigin = current.sessionId === origin.sessionId && current.project?.path === origin.project?.path;
      const resultIsCurrent = current.sessionId === state.sessionId && current.project?.path === state.project?.path;
      if (selectionIsOrigin || resultIsCurrent) useRuntimeStore.getState().setRuntime(state);
    } catch (error) {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'The reasoning level could not be changed.');
    } finally {
      modelBusyRef.current = false;
      if (mounted.current) setModelBusy(false);
    }
  };

  const changePermissionLevel = async (level: 'read-only' | 'edit' | 'full-access') => {
    if (!('piDesktop' in window) || permissionBusyRef.current) return;
    const origin = useRuntimeStore.getState().runtime;
    const originLevel = origin.permissionLevel ?? 'edit';
    if (origin.status !== 'ready' || origin.streaming || origin.sessionOperation) return;
    if (level === originLevel) {
      setPermissionMenuOpen(false);
      setConfirmFullAccess(false);
      return;
    }
    if (typeof window.piDesktop.setPermissionLevel !== 'function') {
      setComposerError('Restart Fate UI to activate permission controls.');
      return;
    }
    permissionBusyRef.current = true;
    setPermissionBusy(true);
    setComposerError(null);
    try {
      const state = await window.piDesktop.setPermissionLevel(level);
      if (!mounted.current) return;
      const current = useRuntimeStore.getState().runtime;
      const selectionIsOrigin = current.sessionId === origin.sessionId && current.project?.path === origin.project?.path;
      const resultIsCurrent = current.sessionId === state.sessionId && current.project?.path === state.project?.path;
      if (!selectionIsOrigin && !resultIsCurrent) return;
      useRuntimeStore.getState().setRuntime(state);
      setPermissionMenuOpen(false);
      setConfirmFullAccess(false);
    } catch (error) {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'The permission level could not be changed.');
    } finally {
      permissionBusyRef.current = false;
      if (mounted.current) setPermissionBusy(false);
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
                  <span className="slash-suggestion-copy icon-label">
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
                <AppTooltip content={item.text}><span className="queued-message-preview icon-label">{item.text}</span></AppTooltip>
                <div className="queued-message-actions">
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
                        <button type="button" onClick={() => void mutateQueuedMessage(item.id, 'edit')}><Pencil size={13} aria-hidden="true" /><span className="icon-label">Edit message</span></button>
                        {item.behavior === 'steer' && <button type="button" onClick={() => void mutateQueuedMessage(item.id, 'followUp')}><CornerUpLeft size={13} aria-hidden="true" /><span className="icon-label">Move to follow-up</span></button>}
                        <button className="queued-message-menu-danger" type="button" onClick={() => void mutateQueuedMessage(item.id, 'cancel')}><Trash2 size={13} aria-hidden="true" /><span className="icon-label">Cancel message</span></button>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                </div>
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
        onSubmit={(event) => { event.preventDefault(); void submit(runtime.streaming ? 'followUp' : 'prompt'); }}
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
          <span key={`${image.name}-${index}`}><button type="button" className="composer-attachment-preview" aria-label={`Expand image: ${image.name}`} onClick={() => setPreviewImage(image)}><img alt="" src={`data:${image.mimeType};base64,${image.data}`} /></button><em>{image.name}</em><button type="button" aria-label={`Remove ${image.name}`} onClick={() => updateImages((current) => current.filter((_item, itemIndex) => itemIndex !== index))}><X size={12} /></button></span>
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
              updateDraft(event.target.value);
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
                          <FolderOpen size={14} aria-hidden="true" /><span className="icon-label">{runtime.project?.name ?? 'Open project'}</span>
                        </button>
                      </AppTooltip>
                      <button type="button" aria-label="Add file reference" disabled={!connected} onClick={() => { setUtilityMenuOpen(false); void addReference(); }}>
                        <AtSign size={14} aria-hidden="true" /><span className="icon-label">File reference</span>
                      </button>
                      <button type="button" aria-label="Attach image" disabled={!imageCapable || images.length >= 4} onClick={() => { setUtilityMenuOpen(false); fileInput.current?.click(); }}>
                        <ImagePlus size={14} aria-hidden="true" /><span className="icon-label">Attach image</span>
                      </button>
                      {runtime.sessionCapabilities?.fork && forkPoint && (
                        <button type="button" aria-label="Create new session from latest prompt" title={forkTooltip} disabled={!canFork || forking} onClick={() => { setUtilityMenuOpen(false); void forkConversation(); }}>
                          {forking ? <LoaderCircle className="tool-spinner" size={14} /> : <GitFork size={14} aria-hidden="true" />}<span className="icon-label">New session from prompt</span>
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
                <AppTooltip content="Insert a project-relative file reference" wrapTrigger><button type="button" aria-label="Add file reference" disabled={!connected} onClick={() => void addReference()}><AtSign size={15} /><span className="icon-label">File</span></button></AppTooltip>
                <AppTooltip content={imageCapable ? 'Attach up to four images' : 'The model selected for the next message does not support images'} wrapTrigger><button type="button" aria-label="Attach image" disabled={!imageCapable || images.length >= 4} onClick={() => fileInput.current?.click()}><ImagePlus size={15} /><span className="icon-label">Image</span></button></AppTooltip>
                {runtime.sessionCapabilities?.fork && forkPoint && <AppTooltip content={forkTooltip} wrapTrigger><button type="button" aria-label="Create new session from latest prompt" disabled={!canFork || forking} onClick={() => void forkConversation()}>{forking ? <LoaderCircle className="tool-spinner" size={15} /> : <GitFork size={15} />}<span className="icon-label">New from prompt</span></button></AppTooltip>}
              </>
            )}
          </div>
          <div className="composer-toolbar-trailing">
              <div className="composer-model-context">
                <Popover.Root open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
                  <AppTooltip content={modelTooltip}>
                    <Popover.Trigger asChild>
                      <button className="model-pill" type="button" aria-label="Model and reasoning settings" disabled={!connected || modelBusy}>
                        {modelBusy && <LoaderCircle className="tool-spinner" size={14} />}
                        <strong className="icon-label">{modelLabel}</strong>
                        <span className="icon-label">{reasoningCapable ? thinkingLabel(nextThinkingLevel) : 'No reasoning'}</span>
                        <ChevronDown size={12} />
                      </button>
                    </Popover.Trigger>
                  </AppTooltip>
                  <Popover.Portal>
                    <Popover.Content className="model-popover" role="dialog" aria-label="Model settings" side="top" align="end" sideOffset={10} collisionPadding={12}>
                      <div className="model-popover-heading">
                        <div><strong>Model settings</strong><span>Choose settings for upcoming prompts</span></div>
                        {modelBusy && <LoaderCircle className="tool-spinner" size={14} aria-label="Applying settings" />}
                      </div>
                      <div className="model-transition-copy" aria-label={`Current model: ${currentModelName}. Next model: ${nextModelName}.`}>
                        <span><b>Current</b>{currentModelName}</span>
                        <span><b>Next</b>{nextModelName}</span>
                      </div>
                      <div className="model-setting">
                        <div><strong>Model</strong><span>{runtime.streaming ? 'Stages for your next message' : 'Used for your next message'}</span></div>
                        <SelectControl
                          label="Model"
                          disabled={!connected || modelBusy}
                          value={nextModel ? `${nextModel.provider}/${nextModel.id}` : ''}
                          options={nextModel
                            ? runtime.models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name, detail: model.provider }))
                            : [{ value: '', label: 'Not connected' }]}
                          onValueChange={(value) => void changeModel(value)}
                        />
                      </div>
                      <div className="model-setting">
                        <div><strong>Reasoning</strong><span>{reasoningCapable ? runtime.streaming ? 'Stages for your next user message' : 'Used for your next user message' : 'Not supported by the next model'}</span></div>
                        <SelectControl
                          label="Reasoning level"
                          disabled={!reasoningCapable || modelBusy}
                          value={reasoningCapable ? nextThinkingLevel : 'off'}
                          options={(reasoningCapable ? thinkingLevels : ['off'] as const).map((level) => ({ value: level, label: reasoningCapable ? thinkingLabel(level) : 'Not supported' }))}
                          onValueChange={(value) => void changeThinking(value as typeof thinkingLevels[number])}
                        />
                      </div>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
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
                    aria-busy={voiceState === 'preparing' || voiceState === 'downloading' || voiceState === 'transcribing'}
                  >
                    <Mic size={17} />
                  </button>
                </AppTooltip>
              )}
              {runtime.streaming && <span id="streaming-send-instructions" className="visually-hidden">Hold continuously for two seconds to stop Pi without queuing the draft.</span>}
              <AppTooltip content={runtime.streaming ? 'Click sends or queues the message · Hold for 2 seconds to stop Pi' : sendMessageWithModifier ? 'Send · Ctrl/⌘ Enter' : 'Send · Enter'}>
                <span className="send-tooltip-trigger">
                  <button
                    className="send-button"
                    type="submit"
                    aria-label={runtime.streaming ? 'Queue follow-up message' : 'Send message'}
                    aria-describedby={runtime.streaming ? 'streaming-send-instructions' : undefined}
                    aria-busy={submitting}
                    disabled={!connected || (!runtime.streaming && (!draft.trim() || submitting))}
                    onPointerDown={startSendHold}
                    onPointerUp={(event) => finishSendHold(normalizedPointerId(event.pointerId))}
                    onPointerCancel={(event) => cancelSendHold(normalizedPointerId(event.pointerId))}
                    onLostPointerCapture={(event) => cancelSendHold(normalizedPointerId(event.pointerId))}
                    onContextMenu={(event) => { if (runtime.streaming) event.preventDefault(); }}
                    onClick={(event) => {
                      const outcome = sendClickOutcome.current;
                      if (!outcome) return;
                      sendClickOutcome.current = null;
                      event.preventDefault();
                      if (outcome === 'submit-follow-up') void submit('followUp');
                    }}
                  >
                    {submitting && !runtime.streaming ? <LoaderCircle className="tool-spinner" size={16} /> : <ArrowUp size={18} />}
                  </button>
                </span>
              </AppTooltip>
          </div>
        </div>
      </form>
      {composerError && <p className="composer-error" role="alert">{composerError}</p>}
      <Dialog.Root open={Boolean(previewImage)} onOpenChange={(open) => { if (!open) setPreviewImage(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="cinematic-image-overlay" />
          {previewImage && <Dialog.Content className="cinematic-image-viewer" aria-describedby={undefined} onClick={(event) => { if (event.target === event.currentTarget) setPreviewImage(null); }}>
            <Dialog.Title className="visually-hidden">{previewImage.name}</Dialog.Title>
            <img src={`data:${previewImage.mimeType};base64,${previewImage.data}`} alt={previewImage.name} />
            <footer><span>{previewImage.name}</span><small>Click outside or press Esc to close</small></footer>
            <Dialog.Close className="cinematic-image-close" aria-label="Close image viewer"><X size={18} /></Dialog.Close>
          </Dialog.Content>}
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
