import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { ArrowUp, AtSign, ChevronDown, ChevronUp, CornerUpLeft, FileText, FolderOpen, GitFork, Globe2, Hash, History, ImagePlus, LoaderCircle, MessageSquarePlus, Mic, Pencil, Plug, Shield, ShieldCheck, Sparkles, Target, Trash2, TriangleAlert, X, Zap } from 'lucide-react';
import { type ChangeEvent, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { BrowserAnnotation, FileEntry, PromptInput, QueueMutationInput, SpeechStreamUpdate } from '../../../shared/contracts/ipc';
import { readSessionReference, type SessionReferenceAttachment } from '../../../shared/sessionReferences';
import { subagentDisplayName, subagentHandle } from '../../../shared/subagentIdentity';
import { AppTooltip } from '../../components/AppTooltip';
import { SelectControl } from '../../components/SelectControl';
import { useRuntimeStore } from '../../stores/runtimeStore';
import { useUiStore } from '../../stores/uiStore';
import { useGoalMaxStore } from '../../stores/goalMaxStore';
import { useBrowserStore } from '../../stores/browserStore';
import { GoalMaxRail } from '../goalmaxxing/GoalMaxRail';
import { GoalMaxTaskStrip } from '../goalmaxxing/GoalMaxTaskStrip';
import { parseGoalMaxCommand } from '../goalmaxxing/parseGoalMaxCommand';
import { ContextWheel } from './ContextWheel';
import { agentMentionContext, findLiveAgentMentions, parseAgentStopCommand, sessionMentionHandle, type LiveAgentMention } from './agentMentions';
import { fileTagContext, fileTagText, findFileTags } from './fileTags';
import { findSlashCommands, slashCommandContext, slashCommandDescription, slashCommandLabel, type SlashCommand } from './slashCommands';
import { trimSpeechPcm } from '../../../shared/speechGate';
import { VoiceStreamFeedQueue, startVoiceStream, type VoiceStreamController } from './voiceStream';
import { ProviderConnectDialog } from '../../components/ProviderConnectDialog';
import { modelIdentity, visibleModels } from '../../../shared/modelVisibility';

interface Attachment {
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
  bytes: number;
  pixels: number;
}

interface SessionDraft {
  text: string;
  textRevision: number;
  images: Attachment[];
  imagesRevision: number;
  browserAnnotationIds: string[];
  browserAnnotationsRevision: number;
  sessionReferences: SessionReferenceAttachment[];
  sessionReferencesRevision: number;
  forkNotice: string | null;
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
}

const emptySessionDraft = (): SessionDraft => ({
  text: '', textRevision: 0, images: [], imagesRevision: 0,
  browserAnnotationIds: [], browserAnnotationsRevision: 0,
  sessionReferences: [], sessionReferencesRevision: 0, forkNotice: null,
  selectionStart: 0, selectionEnd: 0, scrollTop: 0,
});

// Keep unfinished identity-keyed drafts when the composer remounts within the renderer.
const MAX_CACHED_SESSION_DRAFTS = 50;
const MAX_CACHED_DRAFT_IMAGE_BYTES = 60_000_000;
const sessionDraftsByIdentity = new Map<string, SessionDraft>();
const sessionDraftListeners = new Set<(key: string, draft: SessionDraft) => void>();
let cachedDraftImageBytes = 0;

function draftImageBytes(draft: SessionDraft): number {
  return draft.images.reduce((total, image) => total + image.bytes, 0);
}

function cacheSessionDraft(key: string, draft: SessionDraft, notify = true): void {
  const previous = sessionDraftsByIdentity.get(key);
  if (previous) cachedDraftImageBytes -= draftImageBytes(previous);
  sessionDraftsByIdentity.delete(key);
  sessionDraftsByIdentity.set(key, draft);
  cachedDraftImageBytes += draftImageBytes(draft);
  while (sessionDraftsByIdentity.size > MAX_CACHED_SESSION_DRAFTS || cachedDraftImageBytes > MAX_CACHED_DRAFT_IMAGE_BYTES) {
    const oldestKey = sessionDraftsByIdentity.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const evicted = sessionDraftsByIdentity.get(oldestKey);
    sessionDraftsByIdentity.delete(oldestKey);
    if (evicted) cachedDraftImageBytes -= draftImageBytes(evicted);
  }
  if (notify && sessionDraftsByIdentity.has(key)) {
    for (const listener of sessionDraftListeners) listener(key, draft);
  }
}

export function clearComposerSessionDrafts(): void {
  sessionDraftsByIdentity.clear();
  cachedDraftImageBytes = 0;
}

const NEW_SESSION_DRAFT_IDENTITY = ['new-session'] as const;
const sessionDraftKey = (
  projectPath: string | null,
  sessionId: string | null,
  sessions?: readonly { id: string }[],
): string | null => {
  if (projectPath === null) return null;
  const identity = sessionId !== null && (sessions === undefined || sessions.some((session) => session.id === sessionId))
    ? ['session', sessionId]
    : NEW_SESSION_DRAFT_IDENTITY;
  return JSON.stringify([projectPath, identity]);
};

export function attachBrowserAnnotationToSession(projectPath: string | null, sessionId: string | null, id: string): void {
  const runtime = useRuntimeStore.getState().runtime;
  const currentSessions = runtime.project?.path === projectPath && runtime.sessionId === sessionId ? runtime.sessions : undefined;
  const key = sessionDraftKey(projectPath, sessionId, currentSessions);
  if (!key) return;
  const current = sessionDraftsByIdentity.get(key) ?? emptySessionDraft();
  if (current.browserAnnotationIds.includes(id)) return;
  cacheSessionDraft(key, {
    ...current,
    browserAnnotationIds: [...current.browserAnnotationIds, id].slice(-24),
    browserAnnotationsRevision: current.browserAnnotationsRevision + 1,
  });
}

const MAX_ATTACHMENT_BYTES = 10_000_000;
const MAX_TOTAL_ATTACHMENT_BYTES = 15_000_000;
const MAX_ATTACHMENT_DIMENSION = 8_192;
const MAX_TOTAL_ATTACHMENT_PIXELS = 24_000_000;
const supportedImageTypes = new Set<Attachment['mimeType']>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const MODEL_NAME_MAX_LENGTH = 28;
const MIN_COMPOSER_INPUT_HEIGHT = 53;
const COMPACT_MIN_COMPOSER_INPUT_HEIGHT = 36;
const COMPOSER_RESIZE_STEP = 18;
const MAX_VOICE_DURATION_MS = 180_000;
/** Live-stream feed chunk size (300 ms of 16 kHz mono = 4 800 samples). The
 *  backend's buffered-stream window (PARAKEET_BUFFERED_WINDOW_MS) is separate
 *  and model-constrained; this only sizes mic captures. */
const STREAM_CHUNK_SAMPLES = 16_000 * 0.3;
/** When accepted-but-unprocessed live audio reaches this depth, the meter warns
 *  that the machine is falling behind before the hard ten-second limit fails. */
const VOICE_LAG_WARN_SECONDS = 5;
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
type SendClickOutcome = 'submit-follow-up' | 'submit-prompt' | 'cancel';
const thinkingLabel = (level: string) => level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1);
const normalizedPointerId = (pointerId: number) => Number.isFinite(pointerId) ? pointerId : 1;

export function clampComposerInputHeight(contentHeight: number, maximum: number, minimum = MIN_COMPOSER_INPUT_HEIGHT): number {
  return Math.min(Math.max(minimum, maximum), Math.max(minimum, Math.ceil(contentHeight)));
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
  // The IPC hand-off below makes its own ArrayBuffer copy. Reuse already-mono
  // 16 kHz decoded PCM here instead of allocating another full recording.
  if (buffer.sampleRate === targetRate && buffer.numberOfChannels === 1) return buffer.getChannelData(0);
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
    // The renderer-to-main IPC hand-off copies this PCM after resampling, so a
    // second renderer-side copy here only adds latency and peak memory.
    return rendered.getChannelData(0);
  } catch {
    return resampleVoiceAudio(buffer, targetRate);
  }
}

export function Composer({ onOpenProject, connectRequest = 0 }: { onOpenProject: () => void; connectRequest?: number }) {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<Attachment[]>([]);
  const [browserAnnotationIds, setBrowserAnnotationIds] = useState<string[]>([]);
  const [sessionReferences, setSessionReferences] = useState<SessionReferenceAttachment[]>([]);
  const [sessionReferenceMenuOpen, setSessionReferenceMenuOpen] = useState(false);
  const [sessionDropActive, setSessionDropActive] = useState(false);
  const [previewImage, setPreviewImage] = useState<Attachment | null>(null);
  const [providerLoginOpen, setProviderLoginOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
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
  const [goalUpdateBusyId, setGoalUpdateBusyId] = useState<string | null>(null);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0);
  const [liveAgentTarget, setLiveAgentTarget] = useState<LiveAgentMention | null>(null);
  const [liveAgentDelivery, setLiveAgentDelivery] = useState<'queue' | 'steer'>('queue');
  const [liveAgentBusy, setLiveAgentBusy] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [fileSuggestionResult, setFileSuggestionResult] = useState<{ projectPath: string; query: string; entries: FileEntry[] } | null>(null);
  const [fileTagDismissed, setFileTagDismissed] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [caretPosition, setCaretPosition] = useState(0);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [inputHeight, setInputHeight] = useState(MIN_COMPOSER_INPUT_HEIGHT);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [voiceLag, setVoiceLag] = useState(false);
  const composer = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const inputShell = useRef<HTMLDivElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const slashList = useRef<HTMLDivElement>(null);
  const agentList = useRef<HTMLDivElement>(null);
  const fileTagList = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const activeRecording = useRef<ActiveRecording | null>(null);
  const draftRef = useRef(draft);
  const imagesRef = useRef(images);
  const browserAnnotationIdsRef = useRef(browserAnnotationIds);
  const sessionReferencesRef = useRef(sessionReferences);
  const draftRevision = useRef(0);
  const imagesRevision = useRef(0);
  const browserAnnotationsRevision = useRef(0);
  const sessionReferencesRevision = useRef(0);
  const sessionDrafts = useRef(sessionDraftsByIdentity);
  const activeDraftKey = useRef<string | null>(null);
  const pendingDraftSelection = useRef<{ key: string | null; text: string; start: number; end: number; scrollTop: number; focus?: boolean } | null>(null);
  const forkNoticeRef = useRef(forkNotice);
  const caretPositionRef = useRef(caretPosition);
  const selectionEndRef = useRef(caretPosition);
  const draftScrollTopRef = useRef(0);
  const submittingRef = useRef(false);
  const optimizingPromptRef = useRef(false);
  const queueBusyRef = useRef(false);
  const goalUpdateBusyRef = useRef(false);
  const modelBusyRef = useRef(false);
  const permissionBusyRef = useRef(false);
  const forkingRef = useRef(false);
  const sendHoldGesture = useRef<SendHoldGesture | null>(null);
  const sendClickOutcome = useRef<SendClickOutcome | null>(null);
  const voiceRestoreFrames = useRef(new Set<number>());
  const voiceAttempt = useRef(0);
  const voiceStateRef = useRef<VoiceState>('idle');
  const voiceSelectionKey = useRef<string | null>(null);
  const liveRecording = useRef<{ controller: VoiceStreamController; feedQueue: VoiceStreamFeedQueue; attempt: number } | null>(null);
  const liveAnchorRef = useRef<number | null>(null);
  const liveSpanLenRef = useRef(0);
  const mounted = useRef(true);
  const runtime = useRuntimeStore(useShallow((state) => ({
    status: state.runtime.status,
    project: state.runtime.project,
    sessionId: state.runtime.sessionId,
    sessions: state.runtime.sessions,
    streaming: state.runtime.streaming,
    activeSessionRunning: state.runtime.activeSessionRunning,
    model: state.runtime.model,
    pendingModel: state.runtime.pendingModel,
    models: state.runtime.models,
    thinkingLevel: state.runtime.thinkingLevel,
    pendingThinkingLevel: state.runtime.pendingThinkingLevel,
    permissionLevel: state.runtime.permissionLevel,
    providerLogin: state.runtime.providerLogin,
    commands: state.runtime.commands,
    contextUsage: state.runtime.contextUsage,
    forkPoints: state.runtime.forkPoints,
    sessionCapabilities: state.runtime.sessionCapabilities,
    sessionOperation: state.runtime.sessionOperation,
    agentTeams: state.runtime.agentTeams,
  })));
  const activeSessionDraftKey = sessionDraftKey(runtime.project?.path ?? null, runtime.sessionId, runtime.sessions);
  const cachedActiveDraft = activeSessionDraftKey === null ? undefined : sessionDraftsByIdentity.get(activeSessionDraftKey);
  const editorDraft = activeDraftKey.current === activeSessionDraftKey ? draft : cachedActiveDraft?.text ?? '';
  const queue = useRuntimeStore((state) => state.queue);
  const browserAnnotations = useBrowserStore((state) => state.annotations);
  const attachedBrowserAnnotations = useMemo(() => {
    const byId = new Map(browserAnnotations.map((annotation) => [annotation.id, annotation]));
    return browserAnnotationIds.flatMap((id) => {
      const annotation = byId.get(id);
      return annotation ? [annotation] : [];
    });
  }, [browserAnnotationIds, browserAnnotations]);
  const activeGoal = useGoalMaxStore((state) => state.goal);
  const setActiveGoal = useGoalMaxStore((state) => state.setGoal);
  const subagentOrder = useRuntimeStore((state) => state.subagentOrder);
  const heldQueueItems = queue.held ?? [];
  const queuedItems = [...heldQueueItems, ...(queue.items ?? [])];
  const heldQueueIds = new Set(heldQueueItems.map((item) => item.id));
  const goalUpdates = activeGoal ? [...activeGoal.steering].reverse() : [];
  const compactMode = useUiStore((state) => state.compactMode);
  const disabledModels = useUiStore((state) => state.disabledModels);
  const minComposerInputHeight = compactMode ? COMPACT_MIN_COMPOSER_INPUT_HEIGHT : MIN_COMPOSER_INPUT_HEIGHT;
  const sendMessageWithModifier = useUiStore((state) => state.sendMessageWithModifier);
  const advancedPromptImprovement = useUiStore((state) => state.advancedPromptImprovement);
  const composerDraftRequest = useUiStore((state) => state.composerDraftRequest);
  const clearComposerDraftRequest = useUiStore((state) => state.clearComposerDraftRequest);
  const showToast = useUiStore((state) => state.showToast);
  const speech = useUiStore((state) => state.speech);
  const speechDownload = useUiStore((state) => state.speechDownload);
  const speechStatus = useUiStore((state) => state.speechStatus);
  const isLiveModel = speech.enabled && speech.liveTranscription
    && Boolean(speechStatus?.models.find((model) => model.id === speech.modelId)?.streaming);
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
  const goalCancelable = Boolean(activeGoal && activeGoal.status !== 'completed' && activeGoal.status !== 'cancelled');
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
  const modelOptions = useMemo(() => {
    if (!nextModel) return [{ value: '', label: 'Not connected' }];
    const options = visibleModels(runtime.models, disabledModels).map((model) => ({ value: modelIdentity(model.provider, model.id), label: model.name, detail: model.provider }));
    const selectedKey = modelIdentity(nextModel.provider, nextModel.id);
    if (!options.some((option) => option.value === selectedKey)) {
      options.unshift({ value: selectedKey, label: nextModel.name, detail: nextModel.provider });
    }
    return options;
  }, [runtime.models, nextModel, disabledModels]);
  const voiceDownloadProgress = speechDownload?.modelId === speech.modelId
    ? speechDownload.state === 'verifying' ? 100 : Math.min(100, Math.round(speechDownload.downloadedBytes / speechDownload.totalBytes * 100))
    : 0;
  const openProviderLogin = useCallback(async () => {
    const desktop = 'piDesktop' in window ? window.piDesktop : undefined;
    if (typeof desktop?.initializeProviderLogin !== 'function') {
      setComposerError('Provider sign-in is unavailable in this build. Update Fate UI and try again.');
      return;
    }
    try {
      const state = await desktop.initializeProviderLogin();
      useRuntimeStore.getState().setRuntime(state);
      setProviderLoginOpen(true);
    } catch (error) {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'Provider sign-in options could not load. Try again.');
    }
  }, []);
  useEffect(() => {
    if (connectRequest > 0) void openProviderLogin();
  }, [connectRequest, openProviderLogin]);
  useEffect(() => {
    setInputHeight((current) => {
      if (compactMode && current === MIN_COMPOSER_INPUT_HEIGHT) return COMPACT_MIN_COMPOSER_INPUT_HEIGHT;
      if (!compactMode && current === COMPACT_MIN_COMPOSER_INPUT_HEIGHT) return MIN_COMPOSER_INPUT_HEIGHT;
      return Math.max(minComposerInputHeight, current);
    });
  }, [compactMode, minComposerInputHeight]);
  const attachableSessions = useMemo(() => (runtime.sessions ?? [])
    .filter((session) => !session.active && !session.path.startsWith('live:'))
    .slice(0, 50)
    .map((session) => ({ id: session.id, title: session.title, projectPath: runtime.project?.path ?? '' })), [runtime.project?.path, runtime.sessions]);
  forkNoticeRef.current = forkNotice;
  caretPositionRef.current = caretPosition;

  const saveActiveDraft = useCallback((key: string) => {
    const current = sessionDrafts.current.get(key) ?? emptySessionDraft();
    cacheSessionDraft(key, {
      ...current,
      text: draftRef.current,
      textRevision: draftRevision.current,
      images: imagesRef.current,
      imagesRevision: imagesRevision.current,
      browserAnnotationIds: browserAnnotationIdsRef.current,
      browserAnnotationsRevision: browserAnnotationsRevision.current,
      sessionReferences: sessionReferencesRef.current,
      sessionReferencesRevision: sessionReferencesRevision.current,
      forkNotice: forkNoticeRef.current,
      selectionStart: caretPositionRef.current,
      selectionEnd: selectionEndRef.current,
      scrollTop: draftScrollTopRef.current,
    }, false);
  }, []);
  const updateDraftForKey = useCallback((key: string | null, next: string) => {
    if (key === null) return;
    const current = sessionDrafts.current.get(key) ?? emptySessionDraft();
    cacheSessionDraft(key, { ...current, text: next, textRevision: current.textRevision + 1 });
  }, []);
  const updateDraft = useCallback((next: string) => {
    updateDraftForKey(activeDraftKey.current, next);
  }, [updateDraftForKey]);
  const updateImagesForKey = useCallback((key: string | null, update: Attachment[] | ((current: Attachment[]) => Attachment[])) => {
    if (key === null) return;
    const stored = sessionDrafts.current.get(key) ?? emptySessionDraft();
    const next = typeof update === 'function' ? update(stored.images) : update;
    if (next === stored.images) return;
    cacheSessionDraft(key, { ...stored, images: next, imagesRevision: stored.imagesRevision + 1 });
  }, []);
  const updateImages = useCallback((update: Attachment[] | ((current: Attachment[]) => Attachment[])) => {
    updateImagesForKey(activeDraftKey.current, update);
  }, [updateImagesForKey]);
  const updateBrowserAnnotationsForKey = useCallback((key: string | null, update: string[] | ((current: string[]) => string[])) => {
    if (key === null) return;
    const stored = sessionDrafts.current.get(key) ?? emptySessionDraft();
    const next = typeof update === 'function' ? update(stored.browserAnnotationIds) : update;
    if (next === stored.browserAnnotationIds) return;
    cacheSessionDraft(key, {
      ...stored,
      browserAnnotationIds: [...new Set(next)].slice(-24),
      browserAnnotationsRevision: stored.browserAnnotationsRevision + 1,
    });
  }, []);
  const updateBrowserAnnotations = useCallback((update: string[] | ((current: string[]) => string[])) => {
    updateBrowserAnnotationsForKey(activeDraftKey.current, update);
  }, [updateBrowserAnnotationsForKey]);
  const updateSessionReferencesForKey = useCallback((key: string | null, update: SessionReferenceAttachment[] | ((current: SessionReferenceAttachment[]) => SessionReferenceAttachment[])) => {
    if (key === null) return;
    const stored = sessionDrafts.current.get(key) ?? emptySessionDraft();
    const current = stored.sessionReferences ?? [];
    const next = typeof update === 'function' ? update(current) : update;
    const unique = next.filter((reference, index) => next.findIndex((candidate) => candidate.id === reference.id && candidate.projectPath === reference.projectPath) === index).slice(-8);
    if (unique.length === current.length && unique.every((reference, index) => reference === current[index])) return;
    cacheSessionDraft(key, { ...stored, sessionReferences: unique, sessionReferencesRevision: (stored.sessionReferencesRevision ?? 0) + 1 });
  }, []);
  const updateSessionReferences = useCallback((update: SessionReferenceAttachment[] | ((current: SessionReferenceAttachment[]) => SessionReferenceAttachment[])) => {
    updateSessionReferencesForKey(activeDraftKey.current, update);
  }, [updateSessionReferencesForKey]);
  const updateForkNoticeForKey = useCallback((key: string | null, next: string | null) => {
    if (key === null) return;
    const current = sessionDrafts.current.get(key) ?? emptySessionDraft();
    cacheSessionDraft(key, { ...current, forkNotice: next });
  }, []);
  const updateForkNotice = useCallback((next: string | null) => {
    updateForkNoticeForKey(activeDraftKey.current, next);
  }, [updateForkNoticeForKey]);
  const updateVoiceState = useCallback((next: VoiceState) => {
    voiceStateRef.current = next;
    if (mounted.current) setVoiceState(next);
  }, []);
  const isCurrentVoiceAttempt = useCallback((attempt: number) => mounted.current && voiceAttempt.current === attempt, []);

  /** Replace the live-transcription span (anchored at liveAnchorRef) with the latest
   *  committed text. The span grows as Parakeet stabilizes words, giving the
   *  type-as-you-speak effect without rewriting anything the user typed outside it. */
  const applyLiveText = useCallback((committed: string) => {
    const anchor = liveAnchorRef.current;
    if (anchor === null || !mounted.current) return;
    const text = committed.trim();
    const current = draftRef.current;
    const before = current.slice(0, anchor);
    const after = current.slice(anchor + liveSpanLenRef.current);
    const leading = before && !/\s$/u.test(before) ? ' ' : '';
    const insertion = `${leading}${text}`;
    liveSpanLenRef.current = insertion.length;
    updateDraft(`${before}${insertion}${after}`);
    const caret = anchor + insertion.length;
    setCaretPosition(caret);
    const input = textarea.current;
    if (input) { input.focus({ preventScroll: true }); input.setSelectionRange(caret, caret); }
  }, [updateDraft]);

  const teardownLiveRecording = () => {
    const recording = liveRecording.current;
    if (recording) {
      liveRecording.current = null;
      recording.feedQueue.cancel();
      void Promise.resolve(recording.controller.stop()).catch(() => undefined);
    }
    liveAnchorRef.current = null;
    liveSpanLenRef.current = 0;
  };
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

  const commandContext = slashCommandContext(editorDraft, caretPosition);
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
  const mentionContext = agentMentionContext(editorDraft, caretPosition);
  const mentionQuery = mentionContext?.query ?? null;
  const agentSuggestions = useMemo(
    () => mentionQuery === null
      ? []
      : findLiveAgentMentions(subagentOrder.flatMap((id) => {
        const run = useRuntimeStore.getState().subagentsById[id];
        return run ? [run] : [];
      }), runtime.agentTeams ?? [], runtime.sessions ?? [], runtime.sessionId, mentionQuery, 8, mentionContext?.symbol),
    [mentionContext?.symbol, mentionQuery, runtime.agentTeams, runtime.sessionId, runtime.sessions, subagentOrder],
  );
  const mentionMenuOpen = !slashMenuOpen && mentionContext !== null && agentSuggestions.length > 0 && !mentionDismissed;
  const activeAgentIndex = agentSuggestions.length > 0
    ? Math.min(selectedAgentIndex, agentSuggestions.length - 1)
    : 0;
  const selectedAgent = agentSuggestions[activeAgentIndex];
  const resourceTagContext = fileTagContext(editorDraft, caretPosition);
  const resourceSuggestions = fileSuggestionResult
    && fileSuggestionResult.projectPath === runtime.project?.path
    && fileSuggestionResult.query === resourceTagContext?.query
    ? findFileTags(fileSuggestionResult.entries)
    : [];
  const resourceMenuOpen = !slashMenuOpen && !mentionMenuOpen && resourceTagContext !== null && resourceSuggestions.length > 0 && !fileTagDismissed;
  const activeFileIndex = resourceSuggestions.length > 0 ? Math.min(selectedFileIndex, resourceSuggestions.length - 1) : 0;
  const selectedFile = resourceSuggestions[activeFileIndex];

  useLayoutEffect(() => {
    const synchronize = (key: string, next: SessionDraft) => {
      if (activeDraftKey.current !== key) return;
      draftRef.current = next.text;
      draftRevision.current = next.textRevision;
      imagesRef.current = next.images;
      imagesRevision.current = next.imagesRevision;
      browserAnnotationIdsRef.current = next.browserAnnotationIds;
      browserAnnotationsRevision.current = next.browserAnnotationsRevision;
      sessionReferencesRef.current = next.sessionReferences ?? [];
      sessionReferencesRevision.current = next.sessionReferencesRevision ?? 0;
      forkNoticeRef.current = next.forkNotice;
      setDraft(next.text);
      setImages(next.images);
      setBrowserAnnotationIds(next.browserAnnotationIds);
      setSessionReferences(next.sessionReferences ?? []);
      setForkNotice(next.forkNotice);
    };
    sessionDraftListeners.add(synchronize);
    return () => { sessionDraftListeners.delete(synchronize); };
  }, []);

  useEffect(() => {
    if (!resourceTagContext || !runtime.project?.path || !('piDesktop' in window)) {
      setFileSuggestionResult(null);
      return;
    }
    const projectPath = runtime.project.path;
    const query = resourceTagContext.query;
    let cancelled = false;
    const load = async () => {
      try {
        const result = query ? await window.piDesktop.searchFiles(query, 100) : await window.piDesktop.listFiles('');
        if (!cancelled && useRuntimeStore.getState().runtime.project?.path === projectPath) {
          setFileSuggestionResult({ projectPath, query, entries: result.entries });
        }
      } catch {
        if (!cancelled) setFileSuggestionResult({ projectPath, query, entries: [] });
      }
    };
    const timer = window.setTimeout(() => { void load(); }, query ? 100 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [resourceTagContext?.query, runtime.project?.path]);

  useLayoutEffect(() => {
    const previousKey = activeDraftKey.current;
    if (previousKey === activeSessionDraftKey) return;
    if (previousKey !== null) saveActiveDraft(previousKey);
    activeDraftKey.current = activeSessionDraftKey;
    const next = activeSessionDraftKey === null
      ? emptySessionDraft()
      : sessionDrafts.current.get(activeSessionDraftKey) ?? emptySessionDraft();
    if (activeSessionDraftKey !== null && !sessionDrafts.current.has(activeSessionDraftKey)) {
      cacheSessionDraft(activeSessionDraftKey, next, false);
    }
    draftRef.current = next.text;
    draftRevision.current = next.textRevision;
    imagesRef.current = next.images;
    imagesRevision.current = next.imagesRevision;
    browserAnnotationIdsRef.current = next.browserAnnotationIds;
    browserAnnotationsRevision.current = next.browserAnnotationsRevision;
    sessionReferencesRef.current = next.sessionReferences ?? [];
    sessionReferencesRevision.current = next.sessionReferencesRevision ?? 0;
    forkNoticeRef.current = next.forkNotice;
    caretPositionRef.current = next.selectionStart;
    selectionEndRef.current = next.selectionEnd;
    draftScrollTopRef.current = next.scrollTop;
    setDraft(next.text);
    setImages(next.images);
    setBrowserAnnotationIds(next.browserAnnotationIds);
    setSessionReferences(next.sessionReferences ?? []);
    setForkNotice(next.forkNotice);
    setCaretPosition(next.selectionStart);
    setPreviewImage(null);
    setComposerError(null);
    setSlashDismissed(false);
    setMentionDismissed(false);
    setLiveAgentTarget(null);
    setFileTagDismissed(false);
    const start = Math.min(next.text.length, next.selectionStart);
    pendingDraftSelection.current = {
      key: activeSessionDraftKey,
      text: next.text,
      start,
      end: Math.min(next.text.length, Math.max(start, next.selectionEnd)),
      scrollTop: next.scrollTop,
    };
  }, [activeSessionDraftKey, saveActiveDraft]);

  useLayoutEffect(() => {
    const pending = pendingDraftSelection.current;
    const input = textarea.current;
    if (!pending || !input || pending.key !== activeDraftKey.current || input.value !== pending.text) return;
    if (pending.focus) input.focus({ preventScroll: true });
    input.setSelectionRange(pending.start, pending.end);
    input.scrollTop = pending.scrollTop;
    caretPositionRef.current = pending.start;
    selectionEndRef.current = pending.end;
    draftScrollTopRef.current = pending.scrollTop;
    pendingDraftSelection.current = null;
  }, [activeSessionDraftKey, draft]);

  useEffect(() => {
    if (!composerDraftRequest) return;
    const targetKey = activeDraftKey.current;
    const input = textarea.current;
    const currentDraft = draftRef.current;
    const insertionStart = input && document.activeElement === input ? input.selectionStart : currentDraft.length;
    const insertionEnd = input && document.activeElement === input ? input.selectionEnd : insertionStart;
    const nextDraft = composerDraftRequest.mode === 'insert'
      ? `${currentDraft.slice(0, insertionStart)}${composerDraftRequest.text}${currentDraft.slice(insertionEnd)}`
      : composerDraftRequest.text;
    const nextCaret = composerDraftRequest.mode === 'insert'
      ? insertionStart + composerDraftRequest.text.length
      : composerDraftRequest.selectAll ? 0 : nextDraft.length;

    updateDraft(nextDraft);
    if (composerDraftRequest.mode === 'replace') {
      updateImages([]);
      updateBrowserAnnotations([]);
      updateSessionReferences([]);
      updateForkNotice(composerDraftRequest.notice ?? null);
    } else if (composerDraftRequest.notice) {
      updateForkNotice(composerDraftRequest.notice);
    }
    setCaretPosition(nextCaret);
    clearComposerDraftRequest(composerDraftRequest.id);
    requestAnimationFrame(() => {
      if (!mounted.current || activeDraftKey.current !== targetKey || draftRef.current !== nextDraft) return;
      textarea.current?.focus({ preventScroll: true });
      textarea.current?.setSelectionRange(composerDraftRequest.selectAll ? 0 : nextCaret, composerDraftRequest.selectAll ? nextDraft.length : nextCaret);
    });
  }, [clearComposerDraftRequest, composerDraftRequest, updateBrowserAnnotations, updateDraft, updateForkNotice, updateImages, updateSessionReferences]);

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
    if (!form || !input) return minComposerInputHeight;
    const formHeight = form.getBoundingClientRect().height;
    const measuredInputHeight = input.getBoundingClientRect().height || minComposerInputHeight;
    const fixedHeight = Math.max(compactMode ? 52 : 71, formHeight - measuredInputHeight);
    const workspaceHeight = workspace?.getBoundingClientRect().height || window.innerHeight;
    return Math.max(minComposerInputHeight, Math.floor(workspaceHeight * 0.5 - fixedHeight));
  }, [compactMode, minComposerInputHeight]);

  const autoSizeInput = useCallback(() => {
    const input = textarea.current;
    if (!input) return;
    const previousInlineHeight = input.style.height;
    input.style.height = '0px';
    const contentHeight = input.scrollHeight;
    input.style.height = previousInlineHeight;
    setInputHeight((current) => {
      const next = clampComposerInputHeight(contentHeight, maxInputHeight(), minComposerInputHeight);
      return current === next ? current : next;
    });
  }, [maxInputHeight, minComposerInputHeight]);

  const syncInputFades = useCallback(() => {
    const input = textarea.current;
    const shell = inputShell.current;
    if (!input || !shell) return;
    shell.dataset.overflowTop = String(input.scrollTop > 1);
    shell.dataset.overflowBottom = String(input.scrollTop + input.clientHeight < input.scrollHeight - 1);
  }, []);

  useLayoutEffect(() => {
    autoSizeInput();
  }, [autoSizeInput, editorDraft]);

  useLayoutEffect(() => {
    syncInputFades();
  }, [editorDraft, inputHeight, syncInputFades]);

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
      teardownLiveRecording();
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
      if ('piDesktop' in window && typeof window.piDesktop.cancelSpeechStream === 'function') {
        void window.piDesktop.cancelSpeechStream().catch(() => undefined);
      }
    };
  }, [clearSendHoldGesture]);

  useEffect(() => {
    if (runtime.streaming || goalCancelable) return;
    if (clearSendHoldGesture()) sendClickOutcome.current = 'cancel';
  }, [clearSendHoldGesture, goalCancelable, runtime.streaming]);

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
    teardownLiveRecording();
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
    if ('piDesktop' in window && typeof window.piDesktop.cancelSpeechStream === 'function') {
      void window.piDesktop.cancelSpeechStream().catch(() => undefined);
    }
  }, [runtime.project?.path, runtime.sessionId, updateVoiceState]);

  // Live transcription updates: committed text writes straight into the input box.
  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.onSpeechStreamUpdate !== 'function') return;
    return window.piDesktop.onSpeechStreamUpdate((update: SpeechStreamUpdate) => {
      if (update.state === 'active' || update.state === 'final') {
        if (update.state === 'active' && !update.committed.trim() && liveSpanLenRef.current > 0) {
          setVoiceLag((update.backlogSeconds ?? 0) >= VOICE_LAG_WARN_SECONDS);
          return;
        }
        applyLiveText(update.committed);
        setVoiceLag(update.state === 'active' && (update.backlogSeconds ?? 0) >= VOICE_LAG_WARN_SECONDS);
      } else if (update.state === 'finalizing') {
        // Input is closed: stop was pressed, or the main process sealed the
        // stream at the three-minute limit. Stop the microphone; the finished
        // text arrives with the final update.
        setVoiceLag(false);
        if (voiceStateRef.current === 'recording') void stopLiveRecording();
      } else if (update.state === 'error') {
        // Keep every word the user already saw before reporting the failure.
        if (update.committed) applyLiveText(update.committed);
        setVoiceLag(false);
        teardownLiveRecording();
        if (voiceStateRef.current !== 'idle') updateVoiceState('idle');
        setComposerError(update.error ?? 'Live transcription failed.');
      } else if (update.state === 'cancelled') {
        setVoiceLag(false);
        teardownLiveRecording();
        if (voiceStateRef.current !== 'idle') updateVoiceState('idle');
      }
    });
  // stopLiveRecording is a stable closure over refs + state setters, matching
  // the voice hotkey effect below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyLiveText, updateVoiceState]);

  // Global voice hotkey (registered by the main process): start/stop from anywhere.
  useEffect(() => {
    if (!('piDesktop' in window) || typeof window.piDesktop.onVoiceHotkey !== 'function') return;
    return window.piDesktop.onVoiceHotkey((event) => {
      if (event.source !== 'hotkey') return;
      if (event.action === 'start') { if (voiceStateRef.current === 'idle') void startVoiceRecording(); }
      else { if (voiceStateRef.current === 'recording') stopVoiceRecording(); }
    });
  // startVoiceRecording/stopVoiceRecording are stable closures over refs + state setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!compactToolbar) setUtilityMenuOpen(false);
  }, [compactToolbar]);

  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [commandContext?.start, commandQuery]);

  useEffect(() => {
    setSelectedAgentIndex(0);
  }, [mentionContext?.start, mentionQuery]);

  useEffect(() => {
    setSelectedFileIndex(0);
  }, [resourceTagContext?.start, resourceTagContext?.query]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    const activeOption = slashList.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (typeof activeOption?.scrollIntoView === 'function') activeOption.scrollIntoView({ block: 'nearest' });
  }, [activeCommandIndex, slashMenuOpen]);

  useEffect(() => {
    if (!mentionMenuOpen) return;
    const activeOption = agentList.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (typeof activeOption?.scrollIntoView === 'function') activeOption.scrollIntoView({ block: 'nearest' });
  }, [activeAgentIndex, mentionMenuOpen]);

  useEffect(() => {
    if (!resourceMenuOpen) return;
    const activeOption = fileTagList.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (typeof activeOption?.scrollIntoView === 'function') activeOption.scrollIntoView({ block: 'nearest' });
  }, [activeFileIndex, resourceMenuOpen]);

  const submit = async (behavior: PromptInput['behavior']) => {
    const runtimeNow = useRuntimeStore.getState().runtime;
    const originDraftKey = sessionDraftKey(runtimeNow.project?.path ?? null, runtimeNow.sessionId, runtimeNow.sessions);
    const submittedDraft = draftRef.current;
    const submittedDraftRevision = draftRevision.current;
    const submittedImages = imagesRef.current;
    const submittedImagesRevision = imagesRevision.current;
    const submittedBrowserAnnotationIds = [...browserAnnotationIdsRef.current];
    const submittedBrowserAnnotationsRevision = browserAnnotationsRevision.current;
    const submittedSessionReferences = [...sessionReferencesRef.current];
    const submittedSessionReferencesRevision = sessionReferencesRevision.current;
    const text = submittedDraft.trim()
      || (submittedSessionReferences.length > 0 ? 'Review the attached session reference.' : '')
      || (submittedBrowserAnnotationIds.length > 0 ? 'Address the attached browser annotations.' : '');
    if (/^\/login(?:\s+.*)?$/iu.test(text)) {
      void openProviderLogin();
      updateDraft('');
      return;
    }
    const logout = /^\/logout\s+([^\s/]+)\s*$/iu.exec(text);
    if (logout && 'piDesktop' in window) {
      updateDraft('');
      void window.piDesktop.logoutProvider(logout[1]!).then((state) => useRuntimeStore.getState().setRuntime(state)).catch((error: unknown) => {
        if (mounted.current) setComposerError(error instanceof Error ? error.message : 'The provider could not be signed out.');
      });
      return;
    }
    if (/^\/logout\s*$/iu.test(text)) {
      setProviderLoginOpen(true);
      updateDraft('');
      return;
    }
    if (!text || runtimeNow.status !== 'ready' || submittingRef.current || !('piDesktop' in window)) return;
    submittingRef.current = true;
    if (mounted.current) {
      setSubmitting(true);
      setComposerError(null);
    }
    const clearSubmittedDraft = () => {
      if (originDraftKey === null) return;
      const originDraft = sessionDrafts.current.get(originDraftKey);
      if (originDraft?.textRevision === submittedDraftRevision) {
        updateDraftForKey(originDraftKey, '');
        updateForkNoticeForKey(originDraftKey, null);
      }
      if (originDraft?.imagesRevision === submittedImagesRevision) {
        updateImagesForKey(originDraftKey, []);
      } else if (submittedImages.length > 0) {
        const submitted = new Set(submittedImages);
        updateImagesForKey(originDraftKey, (current) => {
          const remaining = current.filter((image) => !submitted.has(image));
          return remaining.length === current.length ? current : remaining;
        });
      }
      if (originDraft?.browserAnnotationsRevision === submittedBrowserAnnotationsRevision) {
        updateBrowserAnnotationsForKey(originDraftKey, []);
      } else if (submittedBrowserAnnotationIds.length > 0) {
        const submittedIds = new Set(submittedBrowserAnnotationIds);
        updateBrowserAnnotationsForKey(originDraftKey, (current) => current.filter((id) => !submittedIds.has(id)));
      }
      if ((originDraft?.sessionReferencesRevision ?? 0) === submittedSessionReferencesRevision) {
        updateSessionReferencesForKey(originDraftKey, []);
      } else if (submittedSessionReferences.length > 0) {
        const submitted = new Set(submittedSessionReferences.map((reference) => `${reference.projectPath}\u0000${reference.id}`));
        updateSessionReferencesForKey(originDraftKey, (current) => current.filter((reference) => !submitted.has(`${reference.projectPath}\u0000${reference.id}`)));
      }
    };
    try {
      const goalCommand = parseGoalMaxCommand(text);
      if (goalCommand) {
        if (submittedImages.length > 0 || submittedBrowserAnnotationIds.length > 0 || submittedSessionReferences.length > 0) throw new Error('Remove image, browser annotation, and session attachments before using GoalMax commands.');
        const currentGoal = useGoalMaxStore.getState().goal;
        if (goalCommand.kind === 'view') {
          if (!currentGoal) throw new Error('This thread has no GoalMax objective. Start one with /goalmax followed by an objective.');
          useUiStore.getState().openGoalMax();
        } else if (goalCommand.kind === 'clear') {
          if (!currentGoal) throw new Error('This thread has no GoalMax objective to clear.');
          if (typeof window.piDesktop.clearGoalMax !== 'function') throw new Error('Restart Fate UI to clear persistent goals.');
          await window.piDesktop.clearGoalMax();
          setActiveGoal(null);
        } else if (goalCommand.kind === 'pause' || goalCommand.kind === 'resume') {
          if (!currentGoal) throw new Error(`This thread has no GoalMax objective to ${goalCommand.kind}.`);
          if (typeof window.piDesktop.controlGoalMax !== 'function') throw new Error('Restart Fate UI to control persistent goals.');
          setActiveGoal(await window.piDesktop.controlGoalMax({ action: goalCommand.kind }));
        } else {
          if (typeof window.piDesktop.createGoalMax !== 'function') throw new Error('Restart Fate UI to create persistent goals.');
          setActiveGoal(await window.piDesktop.createGoalMax({
            objective: goalCommand.objective,
            verificationLevel: 'normal',
            agentStrategy: 'auto',
            tokenLimit: null,
            timeLimitMs: null,
          }));
        }
        clearSubmittedDraft();
        return;
      }
      const stopCommand = submittedImages.length === 0 && submittedBrowserAnnotationIds.length === 0 && submittedSessionReferences.length === 0 ? parseAgentStopCommand(text) : null;
      if (stopCommand) {
        if (typeof window.piDesktop.controlSubagent !== 'function') throw new Error('Restart Fate UI to use direct agent controls.');
        const state = await window.piDesktop.controlSubagent({ action: 'cancel', target: stopCommand.target });
        const current = useRuntimeStore.getState().runtime;
        const selectionIsOrigin = current.sessionId === runtimeNow.sessionId && current.project?.path === runtimeNow.project?.path;
        const resultIsCurrent = current.sessionId === state.sessionId && current.project?.path === state.project?.path;
        if (selectionIsOrigin || resultIsCurrent) useRuntimeStore.getState().setRuntime(state);
        clearSubmittedDraft();
        return;
      }
      const promptImages = submittedImages.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
      const browserAnnotationRefs = submittedBrowserAnnotationIds.map((id) => ({ id }));
      const promptSessionReferences = submittedSessionReferences.map(({ id, title, projectPath }) => ({ id, title, projectPath }));
      const acceptance = await window.piDesktop.prompt({
        text,
        behavior,
        ...(promptImages.length ? { images: promptImages } : {}),
        ...(browserAnnotationRefs.length ? { browserAnnotations: browserAnnotationRefs } : {}),
        ...(promptSessionReferences.length ? { sessionReferences: promptSessionReferences } : {}),
      });
      if (!acceptance.accepted) return;
      if (submittedBrowserAnnotationIds.length > 0 && typeof window.piDesktop.dismissBrowserAnnotations === 'function') {
        try {
          await window.piDesktop.dismissBrowserAnnotations(submittedBrowserAnnotationIds);
        } catch (error) {
          useBrowserStore.getState().setError(error instanceof Error ? error.message : 'Sent page markers could not be cleared.');
        }
      }
      clearSubmittedDraft();
    } catch (error) {
      if (mounted.current && activeDraftKey.current === originDraftKey) {
        setComposerError(error instanceof Error ? error.message : 'Pi could not accept this message.');
      }
    } finally {
      submittingRef.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const abortSendGesture = (gesture: SendHoldGesture) => {
    if (gesture.aborted || sendHoldGesture.current !== gesture) return gesture.aborted;
    const runtimeNow = useRuntimeStore.getState().runtime;
    const goalNow = useGoalMaxStore.getState().goal;
    const cancellableGoal = Boolean(goalNow && goalNow.status !== 'completed' && goalNow.status !== 'cancelled');
    if (runtimeNow.status !== 'ready' || (!runtimeNow.streaming && !cancellableGoal) || !('piDesktop' in window)) return false;
    gesture.aborted = true;
    const cancellation = cancellableGoal && typeof window.piDesktop.controlGoalMax === 'function'
      ? window.piDesktop.controlGoalMax({ action: 'cancel', reason: 'Cancelled from the composer hold control.' }).then((goal) => { if (mounted.current) setActiveGoal(goal); })
      : window.piDesktop.abort().then(() => undefined);
    void cancellation.catch((error: unknown) => {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'Pi could not be stopped.');
    });
    return true;
  };

  const finishSendHold = (pointerId: number) => {
    const gesture = sendHoldGesture.current;
    if (!gesture || gesture.pointerId !== pointerId) return;
    if (!gesture.aborted && performance.now() - gesture.startedAt >= SEND_HOLD_TO_ABORT_MS) abortSendGesture(gesture);
    const runtimeNow = useRuntimeStore.getState().runtime;
    const goalNow = useGoalMaxStore.getState().goal;
    const outcome: SendClickOutcome = !gesture.aborted && runtimeNow.status === 'ready' && runtimeNow.streaming
      ? 'submit-follow-up'
      : !gesture.aborted && runtimeNow.status === 'ready' && goalNow && goalNow.status !== 'completed' && goalNow.status !== 'cancelled'
        ? 'submit-prompt'
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
    const goalNow = useGoalMaxStore.getState().goal;
    const cancellableGoal = Boolean(goalNow && goalNow.status !== 'completed' && goalNow.status !== 'cancelled');
    if (runtimeNow.status !== 'ready' || (!runtimeNow.streaming && !cancellableGoal)) return;

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
    const before = editorDraft.slice(0, replaceStart);
    const after = editorDraft.slice(commandContext.end);
    const commandText = `/${command.name}`;
    const trailingSpace = after.length === 0 || !/^\s/u.test(after) ? ' ' : '';
    const insertion = `${commandText}${trailingSpace}`;
    const nextDraft = `${before}${insertion}${after}`;
    const nextCaret = before.length + insertion.length;
    pendingDraftSelection.current = {
      key: activeDraftKey.current,
      text: nextDraft,
      start: nextCaret,
      end: nextCaret,
      scrollTop: Math.max(0, textarea.current?.scrollTop ?? 0),
      focus: true,
    };
    updateDraft(nextDraft);
    setCaretPosition(nextCaret);
    setSlashDismissed(true);
  };

  const selectAgentMention = (agent: NonNullable<typeof selectedAgent>) => {
    if (!mentionContext) return;
    const before = editorDraft.slice(0, mentionContext.start);
    const after = editorDraft.slice(mentionContext.end);
    const mention = `${mentionContext.symbol}${agent.handle}`;
    const trailingSpace = after.length === 0 || !/^\s/u.test(after) ? ' ' : '';
    const insertion = `${mention}${trailingSpace}`;
    const nextDraft = `${before}${insertion}${after}`;
    const nextCaret = before.length + insertion.length;
    pendingDraftSelection.current = {
      key: activeDraftKey.current,
      text: nextDraft,
      start: nextCaret,
      end: nextCaret,
      scrollTop: Math.max(0, textarea.current?.scrollTop ?? 0),
      focus: true,
    };
    updateDraft(nextDraft);
    setCaretPosition(nextCaret);
    if (agent.kind === 'session') {
      const session = attachableSessions.find((candidate) => candidate.id === agent.id);
      if (session) updateSessionReferences((current) => [...current, session]);
      setLiveAgentTarget(null);
    } else {
      setLiveAgentTarget(agent);
      setLiveAgentDelivery(agent.active ? 'steer' : 'queue');
    }
    setMentionDismissed(true);
  };

  const selectFileTag = (entry: NonNullable<typeof selectedFile>) => {
    if (!resourceTagContext) return;
    const before = editorDraft.slice(0, resourceTagContext.start);
    const after = editorDraft.slice(resourceTagContext.end);
    const insertion = `${fileTagText(entry.path)}${after.length === 0 || !/^\s/u.test(after) ? ' ' : ''}`;
    const nextDraft = `${before}${insertion}${after}`;
    const nextCaret = before.length + insertion.length;
    pendingDraftSelection.current = { key: activeDraftKey.current, text: nextDraft, start: nextCaret, end: nextCaret, scrollTop: Math.max(0, textarea.current?.scrollTop ?? 0), focus: true };
    updateDraft(nextDraft);
    setCaretPosition(nextCaret);
    setFileTagDismissed(true);
  };

  const sendLiveAgentMessage = async () => {
    const target = liveAgentTarget;
    const message = draftRef.current.trim();
    if (!target || !message || liveAgentBusy || !('piDesktop' in window)) return;
    const steerActiveTurn = target.active && liveAgentDelivery === 'steer';
    const maximum = target.kind === 'team-node' ? 32_768 : target.active ? 20_000 : 200_000;
    if (new TextEncoder().encode(message).byteLength > maximum) {
      setComposerError(`Messages to @${target.handle} are limited to ${maximum.toLocaleString()} bytes.`);
      return;
    }
    setLiveAgentBusy(true);
    setComposerError(null);
    const origin = useRuntimeStore.getState().runtime;
    try {
      let state;
      if (target.kind === 'team-node') {
        if (typeof window.piDesktop.controlAgentTeam !== 'function') throw new Error('Restart Fate UI to message Agent Team sessions.');
        state = await window.piDesktop.controlAgentTeam({
          action: steerActiveTurn ? 'message' : 'followUp',
          teamId: target.teamId,
          target: target.id,
          message,
          replyToUser: true,
          ...(steerActiveTurn ? { delivery: 'steer' as const } : {}),
          operationId: crypto.randomUUID(),
        });
      } else {
        if (typeof window.piDesktop.controlSubagent !== 'function') throw new Error('Restart Fate UI to message live agent sessions.');
        if (target.active) {
          state = await window.piDesktop.controlSubagent({ action: 'steer', target: `@${target.handle}`, message });
        } else {
          state = await window.piDesktop.controlSubagent({ action: 'followUp', target: `@${target.handle}`, message });
        }
      }
      const current = useRuntimeStore.getState().runtime;
      const selectionIsOrigin = current.sessionId === origin.sessionId && current.project?.path === origin.project?.path;
      const resultIsCurrent = current.sessionId === state.sessionId && current.project?.path === state.project?.path;
      if (selectionIsOrigin || resultIsCurrent) useRuntimeStore.getState().setRuntime(state);
      updateDraft('');
      setLiveAgentTarget(null);
      showToast({ kind: 'success', title: 'Message delivered', message: `Sent to @${target.handle}${steerActiveTurn ? ' in its active turn.' : '.'}` });
    } catch (error) {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'The live agent message could not be delivered.');
    } finally {
      if (mounted.current) setLiveAgentBusy(false);
    }
  };

  const selectSessionTarget = (session: (typeof attachableSessions)[number]) => {
    const handle = sessionMentionHandle(session.title, session.id);
    const caret = Math.max(0, Math.min(editorDraft.length, caretPosition));
    const before = editorDraft.slice(0, caret);
    const after = editorDraft.slice(caret);
    const prefix = before && !/\s$/u.test(before) ? ' ' : '';
    const suffix = after.length === 0 || !/^\s/u.test(after) ? ' ' : '';
    const insertion = `${prefix}~${handle}${suffix}`;
    const nextDraft = `${before}${insertion}${after}`;
    const nextCaret = before.length + insertion.length;
    pendingDraftSelection.current = {
      key: activeDraftKey.current,
      text: nextDraft,
      start: nextCaret,
      end: nextCaret,
      scrollTop: Math.max(0, textarea.current?.scrollTop ?? 0),
      focus: true,
    };
    updateDraft(nextDraft);
    setCaretPosition(nextCaret);
    updateSessionReferences((current) => [...current, session]);
    setLiveAgentTarget(null);
    setSessionReferenceMenuOpen(false);
  };

  const attachSessionReference = (reference: SessionReferenceAttachment) => {
    if (!connected || !reference.projectPath) return;
    if (reference.id === runtime.sessionId && reference.projectPath === runtime.project?.path) {
      setComposerError('The current session is already in context. Choose a different session.');
      return;
    }
    if (sessionReferencesRef.current.some((current) => current.id === reference.id && current.projectPath === reference.projectPath)) {
      setSessionReferenceMenuOpen(false);
      textarea.current?.focus({ preventScroll: true });
      return;
    }
    if (sessionReferencesRef.current.length >= 8) {
      setComposerError('You can attach up to eight sessions to one message.');
      return;
    }
    updateSessionReferences((current) => [...current, reference]);
    setComposerError(null);
    setSessionReferenceMenuOpen(false);
    textarea.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const modifierPressed = event.metaKey || event.ctrlKey;
    const shouldSend = sendMessageWithModifier
      ? modifierPressed
      : !event.shiftKey && !event.altKey;
    if (event.key === 'Enter' && shouldSend && liveAgentTarget && liveAgentTarget.kind !== 'session') {
      event.preventDefault();
      void sendLiveAgentMessage();
      return;
    }
    if (event.key === 'Enter' && shouldSend && parseAgentStopCommand(editorDraft)) {
      event.preventDefault();
      void submit(runtime.streaming || runtime.activeSessionRunning ? 'followUp' : 'prompt');
      return;
    }
    if (mentionMenuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        setSelectedAgentIndex((current) => (current + offset + agentSuggestions.length) % agentSuggestions.length);
        return;
      }
      if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) || event.key === 'Tab') {
        if (selectedAgent) {
          event.preventDefault();
          selectAgentMention(selectedAgent);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionDismissed(true);
        return;
      }
    }
    if (resourceMenuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        setSelectedFileIndex((current) => (current + offset + resourceSuggestions.length) % resourceSuggestions.length);
        return;
      }
      if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) || event.key === 'Tab') {
        if (selectedFile) { event.preventDefault(); selectFileTag(selectedFile); }
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); setFileTagDismissed(true); return; }
    }
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
    if (event.key === 'Enter' && shouldSend) {
      event.preventDefault();
      void submit(runtime.streaming || runtime.activeSessionRunning ? 'followUp' : 'prompt');
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
      setInputHeight(Math.min(maximum, Math.max(minComposerInputHeight, Math.round(startHeight + startY - moveEvent.clientY))));
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
    else if (event.key === 'Home') next = minComposerInputHeight;
    else if (event.key === 'End') next = maxInputHeight();
    if (next === null) return;
    event.preventDefault();
    setInputHeight(Math.min(maxInputHeight(), Math.max(minComposerInputHeight, next)));
  };

  const startResourceTag = () => {
    const input = textarea.current;
    if (!input) return;
    const currentDraft = draftRef.current;
    const start = Math.min(currentDraft.length, input.selectionStart);
    const end = Math.min(currentDraft.length, Math.max(start, input.selectionEnd));
    const leadingSpace = start > 0 && !/\s/u.test(currentDraft[start - 1] ?? '') ? ' ' : '';
    const trailingSpace = end < currentDraft.length && !/\s/u.test(currentDraft[end] ?? '') ? ' ' : '';
    const insertion = `${leadingSpace}#${trailingSpace}`;
    const nextDraft = `${currentDraft.slice(0, start)}${insertion}${currentDraft.slice(end)}`;
    const nextCaret = start + leadingSpace.length + 1;
    pendingDraftSelection.current = { key: activeDraftKey.current, text: nextDraft, start: nextCaret, end: nextCaret, scrollTop: Math.max(0, input.scrollTop), focus: true };
    updateDraft(nextDraft);
    setCaretPosition(nextCaret);
    setFileTagDismissed(false);
  };

  const addImageFiles = useCallback((incoming: readonly File[]) => {
    if (!imageCapable) {
      setComposerError('The model selected for the next message does not support image attachments.');
      return;
    }
    const targetKey = activeDraftKey.current;
    if (targetKey === null) return;
    const currentImages = sessionDrafts.current.get(targetKey)?.images ?? imagesRef.current;
    const targetIsActive = () => mounted.current && activeDraftKey.current === targetKey;
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
                if (targetIsActive()) setComposerError(`${file.name || 'Image'} exceeds the 8,192-pixel side or 24-megapixel limit.`);
                return;
              }
            } catch {
              if (targetIsActive()) setComposerError(`${file.name || 'Image'} could not be decoded safely.`);
              return;
            }
          }
          if (!mounted.current) return;
          const result = typeof reader.result === 'string' ? reader.result : '';
          const data = result.slice(result.indexOf(',') + 1);
          const sourceName = file.name || `pasted-image.${file.type.split('/')[1] ?? 'png'}`;
          updateImagesForKey(targetKey, (current) => {
            const totalBytes = current.reduce((total, image) => total + image.bytes, 0);
            const totalPixels = current.reduce((total, image) => total + image.pixels, 0);
            if (current.length >= 4 || totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES || totalPixels + pixels > MAX_TOTAL_ATTACHMENT_PIXELS) {
              queueMicrotask(() => { if (targetIsActive()) setComposerError('Image attachments exceed the combined size or pixel budget.'); });
              return current;
            }
            const name = uniqueAttachmentName(sourceName, current.map((image) => image.name));
            return [...current, { name, mimeType: file.type as Attachment['mimeType'], data, bytes: file.size, pixels }];
          });
        })();
      };
      reader.onerror = () => { if (targetIsActive()) setComposerError(`Could not read ${file.name || 'that image'}.`); };
      reader.readAsDataURL(file);
    }
  }, [imageCapable, updateImagesForKey]);

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

  const startLiveRecording = async () => {
    const runtimeNow = useRuntimeStore.getState().runtime;
    if (!speech.enabled || speechDownload || voiceStateRef.current !== 'idle' || runtimeNow.status !== 'ready' || !('piDesktop' in window)) return;
    const attempt = voiceAttempt.current + 1;
    voiceAttempt.current = attempt;
    const input = textarea.current;
    liveAnchorRef.current = input ? Math.max(0, input.selectionStart ?? draftRef.current.length) : draftRef.current.length;
    liveSpanLenRef.current = 0;
    updateVoiceState('preparing');
    setComposerError(null);
    let feedQueue: VoiceStreamFeedQueue | null = null;
    try {
      if (typeof window.piDesktop.startSpeechStream !== 'function') throw new Error('Restart Fate UI to activate live transcription.');
      await afterNextPaint();
      if (!isCurrentVoiceAttempt(attempt)) return;
      updateVoiceState('downloading');
      await window.piDesktop.ensureSpeechModel(speech.modelId);
      if (!isCurrentVoiceAttempt(attempt)) return;
      updateVoiceState('preparing');
      await window.piDesktop.startSpeechStream(speech.modelId, speech.language === 'auto' ? undefined : speech.language, speech.finalAccuracyPass);
      if (!isCurrentVoiceAttempt(attempt)) { await window.piDesktop.cancelSpeechStream().catch(() => undefined); return; }
      feedQueue = new VoiceStreamFeedQueue(
        (audio) => window.piDesktop.feedSpeechStream(audio),
        (error) => {
          if (!isCurrentVoiceAttempt(attempt)) return;
          feedQueue?.cancel();
          teardownLiveRecording();
          void window.piDesktop.cancelSpeechStream().catch(() => undefined);
          setComposerError(error instanceof Error ? error.message : 'Live transcription failed.');
          updateVoiceState('idle');
        },
      );
      const controller = await startVoiceStream(speech.inputDeviceId, STREAM_CHUNK_SAMPLES, (pcm) => {
        // stop() flushes the final partial worklet chunk while state is
        // "transcribing". The queue itself rejects data after cancellation.
        if (!isCurrentVoiceAttempt(attempt)) return;
        feedQueue?.push(pcm);
      });
      if (!isCurrentVoiceAttempt(attempt)) {
        feedQueue.cancel();
        void Promise.resolve(controller.stop()).catch(() => undefined);
        await window.piDesktop.cancelSpeechStream().catch(() => undefined);
        return;
      }
      liveRecording.current = { controller, feedQueue, attempt };
      updateVoiceState('recording');
    } catch (error) {
      feedQueue?.cancel();
      teardownLiveRecording();
      await window.piDesktop.cancelSpeechStream().catch(() => undefined);
      if (isCurrentVoiceAttempt(attempt)) {
        setComposerError(error instanceof Error ? error.message : 'Could not start live transcription.');
        updateVoiceState('idle');
      }
    }
  };

  const stopLiveRecording = async () => {
    const recording = liveRecording.current;
    if (!recording) return;
    liveRecording.current = null;
    if (voiceStateRef.current === 'recording') updateVoiceState('transcribing');
    try { await recording.controller.stop(); } catch { /* best-effort teardown */ }
    try {
      await recording.feedQueue.closeAndDrain();
      await window.piDesktop.stopSpeechStream();
    } catch (error) {
      if (isCurrentVoiceAttempt(recording.attempt)) setComposerError(error instanceof Error ? error.message : 'Live transcription failed to finalize.');
    } finally {
      if (isCurrentVoiceAttempt(recording.attempt)) {
        liveAnchorRef.current = null;
        liveSpanLenRef.current = 0;
        updateVoiceState('idle');
      }
    }
  };

  const insertTranscript = (transcript: string, target: VoiceInsertionTarget) => {
    const text = transcript.trim();
    if (!text) throw new Error('The voice model returned no text. Try speaking a bit longer, then stop.');
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
      const spoken = trimSpeechPcm(pcm);
      if (spoken.length === 0) throw new Error('No speech was detected. Try again closer to the microphone.');
      const audio = spoken.buffer.slice(spoken.byteOffset, spoken.byteOffset + spoken.byteLength) as ArrayBuffer;
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
    if (liveRecording.current) { void stopLiveRecording(); return; }
    const recording = activeRecording.current;
    if (!recording || recording.recorder.state === 'inactive') return;
    updateVoiceState('transcribing');
    recording.recorder.stop();
  };

  const startVoiceRecording = async () => {
    if (isLiveModel) return startLiveRecording();
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
    if (action === 'edit' && (draftRef.current.trim() || imagesRef.current.length > 0 || browserAnnotationIdsRef.current.length > 0 || sessionReferencesRef.current.length > 0)) {
      setComposerError('Finish or clear the current draft and attachments before editing a queued message.');
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
        updateBrowserAnnotations((result.restored.browserAnnotations ?? []).map(({ id: annotationId }) => annotationId));
        updateSessionReferences((result.restored.sessionReferences ?? []).map((reference) => ({ ...reference })));
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

  const mutateGoalUpdate = async (id: string, action: 'edit' | 'cancel') => {
    if (!('piDesktop' in window) || goalUpdateBusyRef.current) return;
    const goalNow = useGoalMaxStore.getState().goal;
    const item = goalNow?.steering.find((entry) => entry.id === id);
    if (!item) return;
    if (action === 'edit' && (draftRef.current.trim() || imagesRef.current.length > 0 || browserAnnotationIdsRef.current.length > 0)) {
      setComposerError('Finish or clear the current draft and attachments before editing a goal update.');
      textarea.current?.focus({ preventScroll: true });
      return;
    }
    if (typeof window.piDesktop.removeGoalMaxSteering !== 'function') {
      setComposerError('Restart Fate UI to edit goal updates.');
      return;
    }
    goalUpdateBusyRef.current = true;
    setGoalUpdateBusyId(id);
    setComposerError(null);
    try {
      // Goal updates are authoritative steering: editing withdraws the entry
      // and restores its text to the composer (mirroring queued-message edit),
      // while cancel removes it from the goal entirely.
      const goal = await window.piDesktop.removeGoalMaxSteering({ steeringId: id });
      if (mounted.current) setActiveGoal(goal);
      if (action === 'edit') {
        updateDraft(item.text);
        requestAnimationFrame(() => {
          if (!mounted.current) return;
          textarea.current?.focus({ preventScroll: true });
          const end = item.text.length;
          textarea.current?.setSelectionRange(end, end);
        });
      }
    } catch (error) {
      if (mounted.current) setComposerError(error instanceof Error ? error.message : 'The goal update could not be changed.');
    } finally {
      goalUpdateBusyRef.current = false;
      if (mounted.current) setGoalUpdateBusyId(null);
    }
  };

  const optimizePrompt = async () => {
    if (!('piDesktop' in window) || optimizingPromptRef.current) return;
    const origin = useRuntimeStore.getState().runtime;
    const originalDraft = draftRef.current;
    if (!originalDraft.trim() || origin.status !== 'ready' || origin.streaming || origin.activeSessionRunning || origin.sessionOperation) return;
    if (voiceStateRef.current !== 'idle') return;
    if (typeof window.piDesktop.optimizePrompt !== 'function') {
      setComposerError('Restart Fate UI to activate prompt improvement.');
      return;
    }
    optimizingPromptRef.current = true;
    setOptimizingPrompt(true);
    setComposerError(null);
    try {
      const result = await window.piDesktop.optimizePrompt(originalDraft, { advanced: advancedPromptImprovement });
      if (!mounted.current) return;
      const current = useRuntimeStore.getState().runtime;
      const selectionIsOrigin = current.sessionId === origin.sessionId && current.project?.path === origin.project?.path;
      if (!selectionIsOrigin || draftRef.current !== originalDraft) return;
      updateDraft(result.text);
      requestAnimationFrame(() => {
        if (!mounted.current) return;
        textarea.current?.focus({ preventScroll: true });
        textarea.current?.setSelectionRange(0, result.text.length);
      });
      showToast({ kind: 'success', title: 'Prompt improved', message: 'Review the selected prompt, then send it when ready.' });
    } catch (error) {
      if (mounted.current && activeDraftKey.current === sessionDraftKey(origin.project?.path ?? null, origin.sessionId, origin.sessions)) {
        setComposerError(error instanceof Error ? error.message : 'Prompt improvement failed. Your draft was not changed.');
      }
    } finally {
      optimizingPromptRef.current = false;
      if (mounted.current) setOptimizingPrompt(false);
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
      useUiStore.getState().requestComposerDraft(
        result.selectedText ?? point.text,
        true,
        'This is a new session branched from the latest user message. Edit the selected prompt, then send it to continue.',
      );
      textarea.current?.focus({ preventScroll: true });
      showToast({ kind: 'success', title: 'Fork ready', message: 'A new session is active. Edit the selected prompt and send when ready.' });
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
      {resourceMenuOpen && resourceTagContext && (
        <div className="slash-suggestions file-tag-suggestions" role="listbox" aria-label="Project resources" id="file-tag-suggestions">
          <div className="slash-suggestions-heading"><span>Project resources</span><code>#{resourceTagContext.query}</code></div>
          <div ref={fileTagList} className="slash-suggestions-list">
            {resourceSuggestions.map((entry, index) => {
              const Icon = entry.kind === 'directory' ? FolderOpen : FileText;
              return <button id={`file-tag-option-${index}`} key={`${entry.kind}:${entry.path}`} type="button" role="option" aria-selected={index === activeFileIndex} data-active={index === activeFileIndex} onMouseEnter={() => setSelectedFileIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => selectFileTag(entry)}>
                <Icon size={14} aria-hidden="true" /><span className="slash-suggestion-copy icon-label"><strong>{fileTagText(entry.path)}</strong><small>{entry.kind === 'directory' ? 'Folder · includes descendant files' : 'Project file'}</small></span><em>{entry.kind === 'directory' ? 'folder' : 'file'}</em>
              </button>;
            })}
          </div>
          <div className="slash-suggestions-hints" aria-hidden="true"><span><b>↑↓</b> Navigate</span><span><b>Enter</b> Tag</span><span><b>Esc</b> Close</span></div>
        </div>
      )}
      {mentionMenuOpen && mentionContext && (
        <div className="slash-suggestions agent-suggestions" role="listbox" aria-label="Agent mentions" id="agent-suggestions">
          <div className="slash-suggestions-heading">
            <span>{mentionContext.symbol === '~' ? 'Sessions' : 'Agents'}</span>
            <code>{mentionContext.symbol}{mentionQuery}</code>
          </div>
          <div ref={agentList} className="slash-suggestions-list">
            {agentSuggestions.map((run, index) => (
              <button
                id={`agent-option-${index}`}
                key={run.id}
                type="button"
                role="option"
                aria-selected={index === activeAgentIndex}
                data-active={index === activeAgentIndex}
                onMouseEnter={() => setSelectedAgentIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectAgentMention(run)}
              >
                {run.kind === 'session' ? <History size={14} aria-hidden="true" /> : <AtSign size={14} aria-hidden="true" />}
                <span className="slash-suggestion-copy agent-suggestion-copy icon-label">
                  <strong>{run.kind === 'session' ? '~' : '@'}{run.handle}</strong>
                  <small>{run.displayName} · {run.status} · {run.task}</small>
                </span>
                <em>{run.active ? 'live' : 'ready'}</em>
              </button>
            ))}
          </div>
          <div className="slash-suggestions-hints" aria-hidden="true">
            <span><b>↑↓</b> Navigate</span><span><b>Enter</b> Mention</span><span><b>Esc</b> Close</span>
          </div>
        </div>
      )}
      {slashMenuOpen && commandContext && (
        <div className="slash-suggestions" role="listbox" aria-label="Skills and commands" id="slash-suggestions">
          <div className="slash-suggestions-heading">
            <span>{commandContext.commandPosition ? 'Skills & commands' : 'Skills & prompts'}</span>
            <code>/{commandQuery}</code>
          </div>
          <div ref={slashList} className="slash-suggestions-list">
            {commandSuggestions.map((command, index) => {
              const source = command.source ?? 'prompt';
              const Icon = source === 'skill' ? Sparkles : source === 'extension' ? Plug : source === 'builtin' ? Target : FileText;
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
      {goalUpdates.length > 0 && (
        <section className="queued-messages goalmax-steering-messages" aria-label="GoalMax updates" aria-live="polite">
          {goalUpdates.map((item) => {
            const preview = item.text.split('\n', 1)[0]?.trim() || item.text;
            const busy = goalUpdateBusyId === item.id;
            return (
              <div className="queued-message" key={item.id} data-behavior="steer" data-goal-update="true">
                <CornerUpLeft size={13} aria-hidden="true" />
                <AppTooltip content={item.text}><span className="queued-message-preview icon-label">{preview}</span></AppTooltip>
                <span className="queued-message-status">Goal update</span>
                <div className="queued-message-actions">
                  <AppTooltip content="Edit goal update" wrapTrigger>
                    <button className="queued-message-edit" type="button" aria-label={`Edit goal update: ${preview}`} disabled={Boolean(goalUpdateBusyId)} onClick={() => void mutateGoalUpdate(item.id, 'edit')}><Pencil size={13} aria-hidden="true" /></button>
                  </AppTooltip>
                  <AppTooltip content="Cancel goal update" wrapTrigger>
                    <button className="queued-message-cancel" type="button" aria-label={`Cancel goal update: ${preview}`} disabled={Boolean(goalUpdateBusyId)} onClick={() => void mutateGoalUpdate(item.id, 'cancel')}>
                      {busy ? <LoaderCircle className="tool-spinner" size={13} /> : <Trash2 size={13} aria-hidden="true" />}
                    </button>
                  </AppTooltip>
                </div>
              </div>
            );
          })}
        </section>
      )}
      {queuedItems.length > 0 && (
        <section className="queued-messages" aria-label="Queued messages" aria-live="polite">
          {queuedItems.map((item) => {
            const busy = queueBusyId === item.id;
            const held = heldQueueIds.has(item.id);
            return (
              <div className="queued-message" key={item.id} data-behavior={item.behavior} data-held={held || undefined}>
                <CornerUpLeft size={13} aria-hidden="true" />
                <AppTooltip content={item.text}><span className="queued-message-preview icon-label">{item.text}</span></AppTooltip>
                <div className="queued-message-actions">
                  {item.images?.length ? <span className="queued-message-attachments">{item.images.length} image{item.images.length === 1 ? '' : 's'}</span> : null}
                  {item.browserAnnotations?.length ? <span className="queued-message-attachments">{item.browserAnnotations.length} page note{item.browserAnnotations.length === 1 ? '' : 's'}</span> : null}
                  {item.sessionReferences?.length ? <span className="queued-message-attachments">{item.sessionReferences.length} session{item.sessionReferences.length === 1 ? '' : 's'}</span> : null}
                  <AppTooltip content={item.behavior === 'steer' ? 'Steer mode · switch to follow-up' : 'Follow-up mode · switch to steer'} wrapTrigger>
                    <button
                      className="queued-message-behavior"
                      type="button"
                      role="switch"
                      aria-checked={item.behavior === 'steer'}
                      data-active={item.behavior === 'steer' || undefined}
                      aria-label={`${item.behavior === 'steer' ? 'Steer' : 'Follow-up'} queued message: ${item.text}`}
                      disabled={Boolean(queueBusyId)}
                      onClick={() => void mutateQueuedMessage(item.id, item.behavior === 'steer' ? 'followUp' : 'steer')}
                    >
                      <CornerUpLeft size={13} aria-hidden="true" />
                    </button>
                  </AppTooltip>
                  <AppTooltip content="Edit message" wrapTrigger>
                    <button className="queued-message-edit" type="button" aria-label={`Edit queued message: ${item.text}`} disabled={Boolean(queueBusyId)} onClick={() => void mutateQueuedMessage(item.id, 'edit')}><Pencil size={13} aria-hidden="true" /></button>
                  </AppTooltip>
                  <AppTooltip content="Cancel queued message" wrapTrigger>
                    <button className="queued-message-cancel" type="button" aria-label={`Cancel queued message: ${item.text}`} disabled={Boolean(queueBusyId)} onClick={() => void mutateQueuedMessage(item.id, 'cancel')}>
                      {busy ? <LoaderCircle className="tool-spinner" size={13} /> : <Trash2 size={13} aria-hidden="true" />}
                    </button>
                  </AppTooltip>
                </div>
              </div>
            );
          })}
        </section>
      )}
      <GoalMaxRail />
      <GoalMaxTaskStrip />
      <form
        ref={composer}
        className="composer"
        data-compact-toolbar={compactToolbar ? 'true' : 'false'}
        data-session-drop={sessionDropActive || undefined}
        style={{ '--composer-input-height': `${inputHeight}px` } as CSSProperties}
        onDragEnter={(event) => {
          if (!readSessionReference(event.dataTransfer)) return;
          event.preventDefault();
          setSessionDropActive(true);
        }}
        onDragOver={(event) => {
          if (!readSessionReference(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setSessionDropActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSessionDropActive(false);
        }}
        onDrop={(event) => {
          const reference = readSessionReference(event.dataTransfer);
          if (!reference) return;
          event.preventDefault();
          setSessionDropActive(false);
          attachSessionReference(reference);
        }}
        onSubmit={(event) => { event.preventDefault(); if (liveAgentTarget && liveAgentTarget.kind !== 'session') void sendLiveAgentMessage(); else void submit(runtime.streaming || runtime.activeSessionRunning ? 'followUp' : 'prompt'); }}
      >
        <AppTooltip content={'Drag upward to enlarge the message input\nUse ↑ or ↓ while focused'}>
          <div
            className="composer-resize-handle"
            role="separator"
            aria-label="Resize message input"
            aria-orientation="horizontal"
            aria-valuemin={minComposerInputHeight}
            aria-valuemax={maxInputHeight()}
            aria-valuenow={Math.round(inputHeight)}
            tabIndex={0}
            onPointerDown={startComposerResize}
            onKeyDown={resizeComposerWithKeyboard}
          />
        </AppTooltip>
        {liveAgentTarget && liveAgentTarget.kind !== 'session' && (
          <div className="composer-live-agent-target" role="status" aria-label={`Live message target: @${liveAgentTarget.handle}`}>
            <MessageSquarePlus size={14} aria-hidden="true" />
            <span><strong>Message @{liveAgentTarget.handle}</strong><small>{liveAgentTarget.displayName} · {liveAgentTarget.active ? 'active session' : 'ready session'}</small></span>
            {liveAgentTarget.kind === 'team-node' && liveAgentTarget.active ? (
              <button type="button" className="composer-live-agent-delivery" aria-label={`Delivery: ${liveAgentDelivery === 'steer' ? 'Steer active turn' : 'Queue after active turn'}`} onClick={() => setLiveAgentDelivery((current) => current === 'steer' ? 'queue' : 'steer')}>
                {liveAgentDelivery === 'steer' ? 'Steer' : 'Queue'}
              </button>
            ) : null}
            <button type="button" aria-label={`Clear live message target: @${liveAgentTarget.handle}`} onClick={() => setLiveAgentTarget(null)}><X size={12} /></button>
          </div>
        )}
        {forkNotice && (
          <div className="composer-fork-notice" role="status">
            <GitFork size={14} aria-hidden="true" />
            <span><strong>Fork ready</strong><small>{forkNotice}</small></span>
            <button type="button" aria-label="Dismiss fork instructions" onClick={() => updateForkNotice(null)}><X size={12} /></button>
          </div>
        )}
        {attachedBrowserAnnotations.length > 0 && (
          <div className="composer-browser-annotations" aria-label="Attached browser annotations">
            {attachedBrowserAnnotations.map((annotation, index) => (
              <BrowserAnnotationAttachment
                key={annotation.id}
                annotation={annotation}
                index={index + 1}
                onRemove={() => updateBrowserAnnotations((current) => current.filter((id) => id !== annotation.id))}
              />
            ))}
          </div>
        )}
        {sessionReferences.length > 0 && (
          <div className="composer-session-references" aria-label="Attached session references" aria-live="polite">
            {sessionReferences.map((reference) => (
              <span key={`${reference.projectPath}\u0000${reference.id}`}>
                <History size={13} aria-hidden="true" />
                <span><strong>{reference.title}</strong><small>{reference.projectPath === runtime.project?.path ? 'Current project' : 'Trusted project'}</small></span>
                <button type="button" aria-label={`Remove session reference: ${reference.title}`} onClick={() => updateSessionReferences((current) => current.filter((item) => item.id !== reference.id || item.projectPath !== reference.projectPath))}><X size={12} /></button>
              </span>
            ))}
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
            aria-controls={resourceMenuOpen ? 'file-tag-suggestions' : mentionMenuOpen ? 'agent-suggestions' : slashMenuOpen ? 'slash-suggestions' : undefined}
            aria-expanded={resourceMenuOpen || mentionMenuOpen || slashMenuOpen}
            aria-autocomplete="list"
            aria-activedescendant={resourceMenuOpen && resourceSuggestions.length > 0
              ? `file-tag-option-${activeFileIndex}`
              : mentionMenuOpen && agentSuggestions.length > 0
                ? `agent-option-${activeAgentIndex}`
                : slashMenuOpen && commandSuggestions.length > 0 ? `slash-option-${activeCommandIndex}` : undefined}
            value={editorDraft}
            onChange={(event) => {
              if (liveAgentTarget && !event.target.value.trim()) setLiveAgentTarget(null);
              updateDraft(event.target.value);
              caretPositionRef.current = event.target.selectionStart;
              selectionEndRef.current = event.target.selectionEnd;
              draftScrollTopRef.current = Math.max(0, event.target.scrollTop);
              setCaretPosition(event.target.selectionStart);
              setSlashDismissed(false);
              setMentionDismissed(false);
              setFileTagDismissed(false);
            }}
            onSelect={(event) => {
              caretPositionRef.current = event.currentTarget.selectionStart;
              selectionEndRef.current = event.currentTarget.selectionEnd;
              setCaretPosition(event.currentTarget.selectionStart);
            }}
            onScroll={(event) => {
              draftScrollTopRef.current = Math.max(0, event.currentTarget.scrollTop);
              syncInputFades();
            }}
            onKeyDown={onKeyDown}
            onPaste={pasteImages}
            placeholder={connected ? runtime.streaming ? 'Ask for follow-up changes…' : 'Ask Pi about your project…' : runtime.status === 'auth-required' ? 'Type /login to connect a provider…' : 'Open and trust a project to begin…'}
            rows={2}
            disabled={(!connected && runtime.status !== 'auth-required') || optimizingPrompt}
          />
        </div>
        <div className="composer-toolbar">
          {(voiceState === 'recording' || voiceState === 'transcribing') && (
            <div className="composer-voice-meter" aria-hidden="true" data-live={isLiveModel || undefined} data-lag={voiceLag || undefined}><i /><i /><i /><i /><i /></div>
          )}
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
                      <button type="button" aria-label="Tag project file or folder" disabled={!connected} onClick={() => { setUtilityMenuOpen(false); startResourceTag(); }}>
                        <Hash size={14} aria-hidden="true" /><span className="icon-label">Project tag</span>
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
              <AppTooltip content={runtime.project?.name ?? 'Open project'}><button className="composer-project-button" type="button" onClick={onOpenProject}>{runtime.project?.name ?? 'Project'}</button></AppTooltip>
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
                <AppTooltip content="Tag a project file or folder with #" wrapTrigger><button className="composer-icon-action" type="button" aria-label="Tag project file or folder" disabled={!connected} onClick={startResourceTag}><Hash size={15} aria-hidden="true" /></button></AppTooltip>
                <AppTooltip content={imageCapable ? 'Attach up to four images' : 'The model selected for the next message does not support images'} wrapTrigger><button className="composer-icon-action" type="button" aria-label="Attach image" disabled={!imageCapable || images.length >= 4} onClick={() => fileInput.current?.click()}><ImagePlus size={15} aria-hidden="true" /></button></AppTooltip>
                {runtime.sessionCapabilities?.fork && forkPoint && <AppTooltip content={forkTooltip} wrapTrigger><button className="composer-icon-action" type="button" aria-label="Create new session from latest prompt" disabled={!canFork || forking} onClick={() => void forkConversation()}>{forking ? <LoaderCircle className="tool-spinner" size={15} aria-label="Creating session" /> : <GitFork size={15} aria-hidden="true" />}</button></AppTooltip>}
                <Popover.Root
                  open={sessionReferenceMenuOpen}
                  onOpenChange={(nextOpen) => {
                    setSessionReferenceMenuOpen(nextOpen);
                    if (nextOpen) {
                      setUtilityMenuOpen(false);
                      setPermissionMenuOpen(false);
                    }
                  }}
                >
                  <AppTooltip content="Message a saved session with ~" wrapTrigger>
                    <Popover.Trigger asChild>
                      <button className="composer-icon-action" type="button" aria-label="Message saved session" disabled={!connected}>
                        <History size={15} aria-hidden="true" />
                      </button>
                    </Popover.Trigger>
                  </AppTooltip>
                  <Popover.Portal>
                    <Popover.Content className="session-reference-popover" role="dialog" aria-label="Message saved session" side="top" align="start" sideOffset={9} collisionPadding={12}>
                      <div className="session-reference-popover-heading">
                        <div><strong>Message saved session</strong><span>Select a session to insert its ~ tag.</span></div>
                        <History size={15} aria-hidden="true" />
                      </div>
                      {attachableSessions.length > 0 ? (
                        <div className="session-reference-options" role="listbox" aria-label="Saved sessions">
                          {attachableSessions.map((session) => {
                            return (
                              <button key={session.id} type="button" role="option" onClick={() => selectSessionTarget(session)}>
                                <History size={14} aria-hidden="true" />
                                <span><strong>{session.title}</strong><small>Insert ~{sessionMentionHandle(session.title, session.id)}</small></span>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="session-reference-empty">No other saved sessions are available in this project.</p>
                      )}
                      <p className="session-reference-popover-note">You can also type ~ in the message box to find a saved session.</p>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              </>
            )}
          </div>
          <div className="composer-toolbar-trailing">
              <div className="composer-model-context">
                <Popover.Root
                  open={modelMenuOpen}
                  onOpenChange={setModelMenuOpen}
                >
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
                          options={modelOptions}
                          contentClassName="model-select-content"
                          side="top"
                          searchable
                          searchPlaceholder="Filter by name or provider"
                          searchLabel="Filter models by name or provider"
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
                          contentClassName="model-select-content"
                          onValueChange={(value) => void changeThinking(value as typeof thinkingLevels[number])}
                        />
                      </div>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
                {connected && <ContextWheel usage={runtime.contextUsage} {...(runtime.model ? { fallbackWindow: runtime.model.contextWindow } : {})} />}
              </div>
              <AppTooltip
                content={optimizingPrompt
                  ? advancedPromptImprovement ? 'Exploring the project, then improving the prompt…' : 'Improving prompt with the selected model…'
                  : runtime.streaming || runtime.activeSessionRunning
                    ? 'Wait for Pi to finish before improving the prompt'
                    : voiceState !== 'idle'
                      ? 'Wait for voice input to finish before improving the prompt'
                      : !draft.trim()
                        ? 'Write a prompt to improve it'
                        : advancedPromptImprovement
                          ? 'Advanced: explore the project read-only, then improve the prompt with the findings'
                          : 'Improve prompt with the selected model'}
                wrapTrigger
              >
                <button
                  className="voice-button prompt-optimize-button"
                  type="button"
                  data-advanced={advancedPromptImprovement || undefined}
                  aria-label={optimizingPrompt ? 'Improving prompt' : 'Improve prompt'}
                  aria-busy={optimizingPrompt}
                  disabled={!connected || !draft.trim() || optimizingPrompt || runtime.streaming || Boolean(runtime.activeSessionRunning) || Boolean(runtime.sessionOperation) || voiceState !== 'idle'}
                  onClick={() => void optimizePrompt()}
                >
                  {optimizingPrompt ? <LoaderCircle className="tool-spinner" size={17} aria-hidden="true" /> : <Sparkles size={17} aria-hidden="true" />}
                </button>
              </AppTooltip>
              {speech.enabled && (
                <AppTooltip
                  content={voiceState === 'recording' ? (voiceLag ? 'Transcription is falling behind — stop soon to keep your text' : 'Stop and transcribe') : voiceState === 'downloading' ? `Downloading local model… ${voiceDownloadProgress}%` : speechDownload ? 'Wait for the voice model download to finish or cancel it in Settings.' : voiceState === 'preparing' ? 'Preparing microphone…' : voiceState === 'transcribing' ? 'Transcribing locally…' : 'Voice input'}
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
              {(runtime.streaming || goalCancelable) && <span id="streaming-send-instructions" className="visually-hidden">Hold continuously for two seconds to {goalCancelable ? 'cancel the persistent goal and stop its work' : 'stop Pi without queuing the draft'}.</span>}
              <AppTooltip content={liveAgentTarget && liveAgentTarget.kind !== 'session' ? `Send directly to @${liveAgentTarget.handle}` : runtime.streaming || runtime.activeSessionRunning ? `Click queues the message · Hold for 2 seconds to ${goalCancelable ? 'cancel goal' : 'stop Pi'}` : goalCancelable ? 'Send · Hold for 2 seconds to cancel goal' : sendMessageWithModifier ? 'Send · Ctrl/⌘ Enter' : 'Send · Enter'}>
                <span className="send-tooltip-trigger">
                  <button
                    className="send-button"
                    type="submit"
                    aria-label={runtime.streaming || runtime.activeSessionRunning ? 'Queue follow-up message' : goalCancelable && !draft.trim() ? 'Goal control; hold to cancel goal' : 'Send message'}
                    aria-describedby={runtime.streaming || goalCancelable ? 'streaming-send-instructions' : undefined}
                    aria-busy={submitting || liveAgentBusy}
                    disabled={(!connected && runtime.status !== 'auth-required') || liveAgentBusy || (!runtime.streaming && submitting) || (!(liveAgentTarget && liveAgentTarget.kind !== 'session') && !runtime.streaming && !goalCancelable && !draft.trim() && browserAnnotationIds.length === 0 && sessionReferences.length === 0)}
                    onPointerDown={startSendHold}
                    onPointerUp={(event) => finishSendHold(normalizedPointerId(event.pointerId))}
                    onPointerCancel={(event) => cancelSendHold(normalizedPointerId(event.pointerId))}
                    onLostPointerCapture={(event) => cancelSendHold(normalizedPointerId(event.pointerId))}
                    onContextMenu={(event) => { if (runtime.streaming) event.preventDefault(); }}
                    onClick={(event) => {
                      if (liveAgentTarget && liveAgentTarget.kind !== 'session') {
                        event.preventDefault();
                        void sendLiveAgentMessage();
                        return;
                      }
                      const outcome = sendClickOutcome.current;
                      if (!outcome) return;
                      sendClickOutcome.current = null;
                      event.preventDefault();
                      if (outcome === 'submit-follow-up') void submit('followUp');
                      else if (outcome === 'submit-prompt') void submit('prompt');
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
      <ProviderConnectDialog open={providerLoginOpen} onOpenChange={setProviderLoginOpen} />
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

function BrowserAnnotationAttachment({
  annotation,
  index,
  onRemove,
}: {
  annotation: BrowserAnnotation;
  index: number;
  onRemove: () => void;
}) {
  const [comment, setComment] = useState(annotation.comment);
  const [busy, setBusy] = useState(false);
  const target = annotation.target.accessibleName || annotation.target.role || annotation.target.tagName || 'Page element';
  const element = annotation.target.tagName
    ? `<${annotation.target.tagName}${annotation.target.locatorHints.id ? `#${annotation.target.locatorHints.id}` : ''}>`
    : annotation.kind === 'region' ? 'selected region' : 'page element';
  const excerpt = annotation.domExcerpt?.trim() || `${element} ${target}`;

  useEffect(() => setComment(annotation.comment), [annotation.comment]);

  const saveComment = async () => {
    const next = comment.trim();
    if (next === annotation.comment || !('piDesktop' in window)) return;
    setBusy(true);
    try {
      const updated = await window.piDesktop.updateBrowserAnnotation(annotation.id, next);
      useBrowserStore.getState().replaceAnnotation(updated);
    } catch (error) {
      useBrowserStore.getState().setError(error instanceof Error ? error.message : 'The browser note could not be saved.');
      setComment(annotation.comment);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!('piDesktop' in window) || busy) return;
    setBusy(true);
    try {
      const removed = await window.piDesktop.removeBrowserAnnotation(annotation.id);
      if (!removed) throw new Error('That browser annotation no longer exists.');
      useBrowserStore.getState().removeAnnotation(annotation.id);
      onRemove();
    } catch (error) {
      useBrowserStore.getState().setError(error instanceof Error ? error.message : 'The browser attachment could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="composer-browser-annotation" data-testid="browser-annotation-attachment">
      <button
        type="button"
        className="composer-browser-annotation-preview"
        aria-label={`Show browser annotation ${index}: ${target}`}
        onClick={() => { if ('piDesktop' in window) void window.piDesktop.highlightBrowserAnnotation(annotation.id); }}
      >
        <span><Globe2 size={12} aria-hidden="true" /><em>{index}</em><strong>{target}</strong><code>{element}</code></span>
        <pre><code>{excerpt}</code></pre>
      </button>
      <div className="composer-browser-annotation-note">
        <input
          value={comment}
          disabled={busy}
          aria-label={`Note for browser annotation ${index}`}
          placeholder="Add a note for Pi…"
          maxLength={8_000}
          onChange={(event) => setComment(event.target.value)}
          onBlur={() => void saveComment()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === 'Escape') { setComment(annotation.comment); event.currentTarget.blur(); }
          }}
        />
        <button type="button" aria-label={`Remove browser annotation ${index}`} onClick={() => void remove()}><X size={12} /></button>
      </div>
    </article>
  );
}
