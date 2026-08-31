import { z } from 'zod';
import { MAX_SPEECH_STREAM_FEED_SAMPLES, SPEECH_PCM_BYTES_PER_SAMPLE } from '../speech';
import {
  SUBAGENT_DISPLAY_NAME_MAX_LENGTH,
  SUBAGENT_HANDLE_MAX_LENGTH,
  SUBAGENT_HANDLE_PATTERN,
} from '../subagentIdentity';
import { themeCatalogSchema, type ThemeDefinition } from '../themes';
import { agentTeamSchema, agentTeamControlInputSchema, type AgentTeamControlInput } from './multiAgent';

const AGENT_TEAM_MAX_RETAINED_TEAMS = 32;
import { toolProvenanceSchema } from './provenance';
import { type AttestationQueryRequestInput, type AttestationQueryResult } from './mutationAttestation';
import {
  browserAnnotationReferenceSchema,
  type BrowserAnnotation,
  type BrowserBounds,
  type BrowserConfirmation,
  type BrowserControlLevel,
  type BrowserDeviceEmulation,
  type BrowserEvent,
  type BrowserOriginGrant,
  type BrowserSnapshotMode,
  type BrowserState,
  type BrowserUiMode,
  type SemanticPageSnapshot,
} from './browser';
import { imageGenerationProviderIds } from '../imageGeneration';

export * from './browser';
export * from './automations';
import {
  automationDefinitionSchema,
  type AutomationCreateInput,
  type AutomationDefinition,
  type AutomationLaunchOutcome,
  type AutomationUpdateInput,
} from './automations';
import type {
  GoalMaxClearResult,
  GoalMaxControlInput,
  GoalMaxCreateInput,
  GoalMaxEvent,
  GoalMaxState,
  GoalMaxSteeringEditInput,
  GoalMaxSteeringRemoveInput,
  GoalMaxUpdateInput,
} from './goalmaxxing';
import {
  taskListSummarySchema,
  type TaskCreateInput,
  type TaskDeleteInput,
  type TaskEvent,
  type TaskList,
  type TaskReorderInput,
  type TaskUpdateInput,
} from './tasks';

export const ipcChannels = {
  systemGetInfo: 'system:get-info',
  windowControl: 'window:control',
  windowGetState: 'window:get-state',
  windowNew: 'window:new',
  windowState: 'window:state',
  projectSelect: 'project:select',
  projectSelectFile: 'project:select-file',
  projectReveal: 'project:reveal',
  projectRevealPath: 'project:reveal-path',
  projectOpenPath: 'project:open-path',
  projectFocusPath: 'project:focus-path',
  projectCloseRuntime: 'project:close-runtime',
  projectListSessions: 'project:list-sessions',
  projectDeleteSessions: 'project:delete-sessions',
  imageReadLocal: 'image:read-local',
  imageSaveAs: 'image:save-as',
  clipboardWriteText: 'clipboard:write-text',
  browserInitialize: 'browser:initialize',
  browserGetState: 'browser:get-state',
  browserSetBounds: 'browser:set-bounds',
  browserSetVisible: 'browser:set-visible',
  browserSetOverlay: 'browser:set-overlay',
  browserNavigate: 'browser:navigate',
  browserShowLinkContextMenu: 'browser:show-link-context-menu',
  browserOpenLink: 'browser:open-link',
  browserOpenLocalFile: 'browser:open-local-file',
  browserNewTab: 'browser:new-tab',
  browserActivateTab: 'browser:activate-tab',
  browserCloseTab: 'browser:close-tab',
  browserHistory: 'browser:history',
  browserSetMode: 'browser:set-mode',
  browserSetDeviceEmulation: 'browser:set-device-emulation',
  browserSetControlLevel: 'browser:set-control-level',
  browserSetGrant: 'browser:set-grant',
  browserRevokeGrant: 'browser:revoke-grant',
  browserSnapshot: 'browser:snapshot',
  browserSelectAnnotation: 'browser:select-annotation',
  browserListAnnotations: 'browser:list-annotations',
  browserUpdateAnnotation: 'browser:update-annotation',
  browserRemoveAnnotation: 'browser:remove-annotation',
  browserDismissAnnotations: 'browser:dismiss-annotations',
  browserHighlightAnnotation: 'browser:highlight-annotation',
  browserRespondConfirmation: 'browser:respond-confirmation',
  browserEvents: 'browser:events',
  automationsList: 'automations:list',
  automationsCreate: 'automations:create',
  automationsUpdate: 'automations:update',
  automationsDelete: 'automations:delete',
  automationsRecordLaunch: 'automations:record-launch',
  automationsPrepareSession: 'automations:prepare-session',
  runtimeGetState: 'runtime:get-state',
  runtimePrompt: 'runtime:prompt',
  runtimeOptimizePrompt: 'runtime:optimize-prompt',
  runtimeAbort: 'runtime:abort',
  runtimeControlSubagent: 'runtime:control-subagent',
  runtimeControlAgentTeam: 'runtime:control-agent-team',
  runtimeSendSessionMessage: 'runtime:send-session-message',
  runtimeSetModel: 'runtime:set-model',
  runtimeSetThinking: 'runtime:set-thinking',
  runtimeSetPermission: 'runtime:set-permission',
  runtimeProviderLoginInitialize: 'runtime:provider-login:initialize',
  runtimeProviderLoginStart: 'runtime:provider-login:start',
  runtimeProviderLoginRespond: 'runtime:provider-login:respond',
  runtimeProviderLoginCancel: 'runtime:provider-login:cancel',
  runtimeProviderLogout: 'runtime:provider-logout',
  modelsDevList: 'modelsdev:list',
  modelsDevDetail: 'modelsdev:detail',
  modelsDevAdd: 'modelsdev:add',
  modelsDevRemove: 'modelsdev:remove',
  runtimeMutateQueue: 'runtime:mutate-queue',
  runtimeGoalMaxGet: 'runtime:goalmax:get',
  runtimeGoalMaxCreate: 'runtime:goalmax:create',
  runtimeGoalMaxControl: 'runtime:goalmax:control',
  runtimeGoalMaxUpdate: 'runtime:goalmax:update',
  runtimeGoalMaxClear: 'runtime:goalmax:clear',
  runtimeGoalMaxSteeringEdit: 'runtime:goalmax:steering-edit',
  runtimeGoalMaxSteeringRemove: 'runtime:goalmax:steering-remove',
  runtimeGoalMaxEvents: 'runtime:goalmax:events',
  runtimeTaskGet: 'runtime:task:get',
  runtimeTaskCreate: 'runtime:task:create',
  runtimeTaskUpdate: 'runtime:task:update',
  runtimeTaskReorder: 'runtime:task:reorder',
  runtimeTaskDelete: 'runtime:task:delete',
  runtimeTaskClear: 'runtime:task:clear',
  runtimeTaskEvents: 'runtime:task:events',
  runtimeNewSession: 'runtime:new-session',
  runtimeListSessions: 'runtime:list-sessions',
  runtimeSwitchSession: 'runtime:switch-session',
  runtimeRenameSession: 'runtime:rename-session',
  runtimeDeleteSession: 'runtime:delete-session',
  runtimeForkSession: 'runtime:fork-session',
  runtimeNavigateSessionBranch: 'runtime:navigate-session-branch',
  runtimeDeleteSessionBranch: 'runtime:delete-session-branch',
  runtimeCloneSession: 'runtime:clone-session',
  runtimeImportSession: 'runtime:import-session',
  runtimeCompact: 'runtime:compact',
  runtimeEvents: 'runtime:events',
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalAck: 'terminal:ack',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalEvents: 'terminal:events',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  updatesCheck: 'updates:check',
  updatesOpenDownload: 'updates:open-download',
  updatesDownloadInstall: 'updates:download-and-install',
  updatesProgress: 'updates:progress',
  themesGet: 'themes:get',
  speechGetStatus: 'speech:get-status',
  speechEnsureModel: 'speech:ensure-model',
  speechDownloadModel: 'speech:download-model',
  speechCancelDownload: 'speech:cancel-download',
  speechRemoveModel: 'speech:remove-model',
  speechTranscribe: 'speech:transcribe',
  speechCancel: 'speech:cancel',
  speechEvents: 'speech:events',
  speechStreamStart: 'speech:stream-start',
  speechStreamFeed: 'speech:stream-feed',
  speechStreamStop: 'speech:stream-stop',
  speechStreamCancel: 'speech:stream-cancel',
  speechStreamEvents: 'speech:stream-events',
  speechHotkeyStatus: 'speech:hotkey-status',
  voiceHotkey: 'voice-hotkey',
  musicGetStatus: 'music:get-status',
  musicLoad: 'music:load',
  musicResolveTrack: 'music:resolve-track',
  musicClearQueue: 'music:clear-queue',
  musicDurations: 'music:durations',
  diagnosticsGet: 'diagnostics:get',
  logsGet: 'logs:get',
  attestationsQuery: 'attestations:query',
  appCommand: 'app:command',
  filesList: 'files:list',
  filesSearch: 'files:search',
  filesRead: 'files:read',
  filesOpen: 'files:open',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitCombinedDiff: 'git:combined-diff',
  gitWorktrees: 'git:worktrees',
  gitSwitchWorktree: 'git:switch-worktree',
  gitCreateWorktreeSession: 'git:create-worktree-session',
  gitHistory: 'git:history',
  gitCommitDetails: 'git:commit-details',
  gitOperation: 'git:operation',
  gitRevertPath: 'git:revert-path',
  recoveryConsume: 'recovery:consume',
  sessionExport: 'session:export',
} as const;

export const getAppInfoInputSchema = z.object({}).strict();
export const emptyInputSchema = z.object({}).strict();
export const windowControlInputSchema = z.object({
  action: z.enum(['minimize', 'toggle-maximize', 'close']),
}).strict();
export const windowStateSchema = z.object({ maximized: z.boolean(), minimized: z.boolean() }).strict();

export const appInfoSchema = z.object({
  name: z.literal('Fate UI'),
  version: z.string().min(1),
  platform: z.enum(['win32', 'darwin', 'linux']),
  packaged: z.boolean(),
});

export const appErrorSchema = z.object({
  code: z.enum([
    'AUTH_REQUIRED',
    'INVALID_PROJECT',
    'PROJECT_NOT_TRUSTED',
    'RUNTIME_NOT_READY',
    'RUN_ACTIVE',
    'INVALID_REQUEST',
    'PI_RUNTIME_ERROR',
    'SPEECH_ERROR',
    'ABORTED',
    'UNKNOWN',
  ]),
  message: z.string().min(1),
  actionable: z.string().min(1).optional(),
  retryable: z.boolean(),
});

export const thinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const permissionLevelSchema = z.enum(['read-only', 'edit', 'full-access']);
export const interfaceFontSchema = z.enum(['noto-sans', 'system', 'inter', 'poppins', 'montserrat', 'jetbrains-mono']);
export const codeFontSchema = z.enum(['jetbrains-mono', 'noto-sans-mono', 'system-mono']);
export const speechTierSchema = z.enum(['mini', 'balanced', 'max']);
/** Every downloadable local voice model. Stored settings with the legacy
 *  tier-as-id values are migrated by `speechModelIdSchema`. */
export const speechModelIdSchema = z.enum([
  'canary-flash',
  'parakeet-unified',
  'nemotron-stream',
  'parakeet-tdt-v3',
  'cohere-transcribe',
  'whisper-turbo',
]);
/** Map settings saved before model ids were decoupled from tiers. */
const legacySpeechModelIds: Record<string, z.infer<typeof speechModelIdSchema>> = {
  mini: 'canary-flash',
  balanced: 'parakeet-unified',
  max: 'cohere-transcribe',
};
export function migrateSpeechModelId(value: string): z.infer<typeof speechModelIdSchema> {
  return legacySpeechModelIds[value] ?? (value as z.infer<typeof speechModelIdSchema>);
}

export const modelInfoSchema = z.object({
  provider: z.string().min(1).max(200),
  id: z.string().min(1).max(500),
  name: z.string().min(1).max(500),
  reasoning: z.boolean(),
  contextWindow: z.number().int().positive().max(2_147_483_647),
  supportsImages: z.boolean().optional(),
  api: z.string().min(1).max(100).optional(),
});

export const projectStateSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  trusted: z.boolean(),
});

// ---------------------------------------------------------------------------
// models.dev provider catalog (Add Provider flow)
// ---------------------------------------------------------------------------

/** A provider the user added from models.dev. Rides RuntimeState so every
 *  window sees the same managed list without extra IPC round-trips. */
export const modelsDevManagedProviderSchema = z.object({
  /** models.dev provider id; doubles as the Pi provider id in models.json. */
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  baseUrl: z.string().min(1).max(2_000),
  /** Environment variable pi reads the API key from, when models.dev lists one. */
  envVar: z.string().min(1).max(200).nullable(),
  /** Pi streaming API kind, for example "openai-completions". */
  api: z.string().min(1).max(100),
  modelCount: z.number().int().nonnegative().max(100_000),
  addedAt: z.number().finite(),
  /** Last successful models.dev catalog refresh; null until the first one. */
  checkedAt: z.number().finite().nullable(),
  credentialConfigured: z.boolean(),
});

/** One row of the Add Provider picker. Fetched live from models.dev. */
export const modelsDevProviderSummarySchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  modelCount: z.number().int().nonnegative().max(100_000),
  envVar: z.string().min(1).max(200).nullable(),
  baseUrl: z.string().min(1).max(2_000),
  api: z.string().min(1).max(100),
  docUrl: z.string().min(1).max(2_000).nullable(),
  /** "available" for addable rows; "managed" or "configured" rows are shown as already present. */
  status: z.enum(['available', 'managed', 'configured']),
});

export const modelsDevModelSummarySchema = z.object({
  id: z.string().min(1).max(500),
  name: z.string().min(1).max(500),
  reasoning: z.boolean(),
  toolCall: z.boolean(),
  structuredOutput: z.boolean(),
  imageInput: z.boolean(),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  effortValues: z.array(z.string().min(1).max(100)).max(20),
  costInput: z.number().nonnegative(),
  costOutput: z.number().nonnegative(),
});

/** Full provider detail shown before confirming an add. */
export const modelsDevProviderDetailSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  baseUrl: z.string().min(1).max(2_000),
  envVar: z.string().min(1).max(200).nullable(),
  api: z.string().min(1).max(100),
  docUrl: z.string().min(1).max(2_000).nullable(),
  models: z.array(modelsDevModelSummarySchema).max(500),
});

export const modelsDevListResultSchema = z.object({
  providers: z.array(modelsDevProviderSummarySchema).max(1_000),
  fetchedAt: z.number().finite(),
});

export const modelsDevAddInputSchema = z.object({
  providerId: z.string().min(1).max(200),
  /** Optional API key; stored in the Fate UI credential store, never in models.json. */
  apiKey: z.string().min(1).max(2_000).optional(),
}).strict();

export const modelsDevRemoveInputSchema = z.object({
  providerId: z.string().min(1).max(200),
}).strict();
export const projectFileReferenceSchema = z.string().min(1).max(4_096).nullable();
export const revealProjectResultSchema = z.object({ opened: z.literal(true) }).strict();

export const relativePathSchema = z.string().max(4_096);
export const filePathInputSchema = z.object({ path: relativePathSchema }).strict();
export const fileListInputSchema = z.object({ path: relativePathSchema.default('') }).strict();
export const fileSearchInputSchema = z.object({ query: z.string().trim().max(500), limit: z.number().int().min(1).max(500).default(300) }).strict();
export const fileEntrySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['file', 'directory']),
  symlink: z.boolean(),
});
export const fileListSchema = z.object({ path: relativePathSchema, entries: z.array(fileEntrySchema).max(2_000), truncated: z.boolean() });
export const fileSearchResultSchema = z.object({ entries: z.array(fileEntrySchema).max(500), truncated: z.boolean() });
export const filePreviewSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  state: z.enum(['text', 'image', 'binary', 'large']),
  content: z.string().max(1_500_000).optional(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']).optional(),
  language: z.string(),
  openable: z.boolean(),
}).superRefine((preview, context) => {
  if (preview.state === 'image' && (!preview.content || !preview.mimeType)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Image previews require bounded data and a supported MIME type.' });
  }
});
export const openFileResultSchema = z.object({ opened: z.boolean(), error: z.string().optional() });

export const gitChangeSchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  indexStatus: z.string().length(1),
  workTreeStatus: z.string().length(1),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});
export const gitStatusSchema = z.object({
  repository: z.boolean(),
  branch: z.string(),
  upstream: z.string().max(1_000).nullable(),
  pushTarget: z.string().max(1_000).nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  changes: z.array(gitChangeSchema).max(10_000),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export const gitDiffSchema = z.object({
  path: z.string().min(1),
  state: z.enum(['text', 'image', 'binary', 'large', 'unavailable']),
  original: z.string().optional(),
  modified: z.string().optional(),
  imageData: z.string().max(1_500_000).optional(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']).optional(),
  language: z.string(),
  openable: z.boolean(),
  message: z.string().optional(),
}).superRefine((diff, context) => {
  if (diff.state === 'image' && (!diff.imageData || !diff.mimeType)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Image diffs require bounded data and a supported MIME type.' });
  }
});
const gitHashSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);
export const gitCombinedDiffSchema = z.object({
  patch: z.string().max(4_000_000),
  truncated: z.boolean(),
}).strict();
export const gitWorktreeSchema = z.object({
  path: z.string().min(1).max(32_768),
  branch: z.string().min(1).max(1_000).nullable(),
  head: gitHashSchema.nullable(),
  detached: z.boolean(),
  bare: z.boolean(),
  current: z.boolean(),
}).strict();
export const gitWorktreeListSchema = z.array(gitWorktreeSchema).max(500);
export const gitWorktreeSessionResultSchema = z.object({
  state: z.lazy(() => runtimeStateSchema),
  selectedText: z.string().max(2_000),
  worktree: gitWorktreeSchema,
}).strict();
export const gitRefSchema = z.object({
  name: z.string().min(1).max(1_000),
  kind: z.enum(['head', 'local', 'remote', 'tag', 'other']),
}).strict();
export const gitCommitSummarySchema = z.object({
  hash: gitHashSchema,
  parents: z.array(gitHashSchema).max(64),
  authorName: z.string().min(1).max(500),
  authorEmail: z.string().max(500),
  authoredAt: z.string().datetime({ offset: true }),
  subject: z.string().max(2_000),
  refs: z.array(gitRefSchema).max(64),
}).strict();
export const gitHistorySchema = z.object({
  head: gitHashSchema.nullable(),
  commits: z.array(gitCommitSummarySchema).max(500),
  truncated: z.boolean(),
}).strict();
export const gitCommitFileSchema = z.object({
  path: z.string().min(1).max(4_096),
  oldPath: z.string().min(1).max(4_096).optional(),
  status: z.string().min(1).max(10),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
}).strict();
export const gitCommitDetailsSchema = gitCommitSummarySchema.extend({
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  files: z.array(gitCommitFileSchema).max(500),
  filesTruncated: z.boolean(),
  githubUrl: z.string().url().max(4_096).nullable(),
}).strict();
export const gitOperationSchema = z.enum(['fetch', 'pull', 'push']);
export const gitOperationResultSchema = z.object({
  operation: gitOperationSchema,
  message: z.string().min(1).max(2_000),
  status: gitStatusSchema,
}).strict();
export const gitWorktreeInputSchema = z.object({ path: z.string().min(1).max(32_768) }).strict();
export const gitCommitInputSchema = z.object({ hash: gitHashSchema }).strict();
export const gitOperationInputSchema = z.object({ operation: gitOperationSchema }).strict();
export const gitRevertPathInputSchema = z.object({ path: z.string().min(1).max(4_096) }).strict();
export const gitRevertPathResultSchema = z.object({
  path: z.string().min(1).max(4_096),
  status: gitStatusSchema,
}).strict();
export const recoveryNoticeSchema = z.object({
  projectPath: z.string().min(1).max(32_768).nullable(),
  sessionId: z.string().min(1).max(500).nullable(),
  permissionLevel: permissionLevelSchema.optional(),
  streaming: z.boolean(),
  activeSessionRunning: z.boolean(),
  queueSteering: z.number().int().nonnegative().max(10_000),
  queueFollowUp: z.number().int().nonnegative().max(10_000),
  eventCursor: z.number().int().nonnegative().optional(),
  lastToolName: z.string().min(1).max(200).nullable(),
  writtenAt: z.number().finite(),
}).strict();
export const recoveryNoticeResultSchema = recoveryNoticeSchema.nullable();

export const runtimeImageSchema = z.object({
  data: z.string().min(1).max(20_000_000),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']),
  alt: z.string().max(500).optional(),
});
const boundedImageBase64Schema = z.string().min(4).max(20_000_000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
export const localImageInputSchema = z.object({ path: z.string().trim().min(1).max(32_768) }).strict();
export const imageSaveInputSchema = z.object({
  data: boundedImageBase64Schema,
  mimeType: runtimeImageSchema.shape.mimeType,
  suggestedName: z.string().trim().min(1).max(200),
}).strict();
export const imageSaveResultSchema = z.discriminatedUnion('saved', [
  z.object({ saved: z.literal(false) }).strict(),
  z.object({ saved: z.literal(true), path: z.string().min(1).max(32_768) }).strict(),
]);
export const clipboardTextInputSchema = z.object({ text: z.string().max(200_000) }).strict();
export const clipboardWriteResultSchema = z.object({ written: z.literal(true) }).strict();

export const runtimeMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  text: z.string().max(65_000),
  reasoning: z.string().max(65_000).optional(),
  images: z.array(runtimeImageSchema).max(8).optional(),
  timestamp: z.number().finite(),
  timelinePosition: z.number().finite().optional(),
  historyOmitted: z.number().int().positive().optional(),
  error: z.boolean().optional(),
});

export const runtimeToolSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.string().max(65_000),
  output: z.string().max(65_000),
  outputTruncated: z.boolean(),
  status: z.enum(['running', 'succeeded', 'error']),
  startedAt: z.number().finite(),
  updatedAt: z.number().finite(),
  endedAt: z.number().finite().optional(),
  timelinePosition: z.number().finite().optional(),
  images: z.array(runtimeImageSchema).max(8).optional(),
  subagentRunIds: z.array(z.string().min(1).max(100)).optional(),
  provenance: toolProvenanceSchema.optional(),
}).strict();

export const slashCommandSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().max(2_000),
  source: z.enum(['builtin', 'extension', 'prompt', 'skill']).optional(),
});
export const skillInfoSchema = z.object({ name: z.string().min(1).max(500), description: z.string().max(2_000) });
export const contextUsageSchema = z.object({
  tokens: z.number().int().nonnegative().nullable(),
  contextWindow: z.number().int().positive(),
  percent: z.number().nonnegative().nullable(),
  estimated: z.boolean().optional(),
});
const tokenCountSchema = z.number().int().nonnegative().safe();
const tokenCostSchema = z.number().finite().nonnegative().max(1_000_000_000);
const tokenMetricsShape = {
  input: tokenCountSchema,
  output: tokenCountSchema,
  cacheRead: tokenCountSchema,
  cacheWrite: tokenCountSchema,
  reasoning: tokenCountSchema.optional(),
  totalTokens: tokenCountSchema,
  cost: tokenCostSchema,
};
function requireReasoningSubset(usage: { output: number; reasoning?: number | undefined }, context: z.RefinementCtx): void {
  if (usage.reasoning !== undefined && usage.reasoning > usage.output) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Reasoning tokens must be a subset of output tokens.' });
  }
}
export const tokenMetricsSchema = z.object(tokenMetricsShape).strict().superRefine(requireReasoningSubset);
export const tokenUsageSampleSchema = z.object({
  ...tokenMetricsShape,
  timestamp: z.number().int().nonnegative().safe(),
}).strict().superRefine(requireReasoningSubset);
export const sessionTokenTotalsSchema = z.object({
  ...tokenMetricsShape,
  turns: tokenCountSchema,
}).strict().superRefine(requireReasoningSubset);
export const runtimeTokenTelemetrySchema = z.object({
  session: sessionTokenTotalsSchema,
  latest: tokenUsageSampleSchema.nullable(),
  history: z.array(tokenUsageSampleSchema).max(120),
}).strict();

export const MAX_SUBAGENT_IMAGE_CHARACTERS = 8_000_000;
export const subagentRoleSchema = z.string().trim().min(1).max(80).refine((role) => !/[\u0000-\u001f\u007f]/u.test(role), 'Subagent role labels cannot contain control characters.');
export const subagentHandleSchema = z.string().trim().min(1).max(SUBAGENT_HANDLE_MAX_LENGTH).regex(SUBAGENT_HANDLE_PATTERN, 'Subagent handles must use lowercase letters, numbers, and single hyphen-separated words.');
export const subagentDisplayNameSchema = z.string().trim().min(1).max(SUBAGENT_DISPLAY_NAME_MAX_LENGTH).refine((name) => !/[\u0000-\u001f\u007f]/u.test(name), 'Subagent display names cannot contain control characters.');
export const subagentAgentSourceSchema = z.enum(['direct', 'builtin', 'user', 'project']);
export const subagentStatusSchema = z.enum(['blocked', 'queued', 'running', 'completed', 'error', 'cancelled', 'timed-out', 'budget-exceeded', 'skipped', 'interrupted']);
export const subagentSkillModeSchema = z.enum(['all', 'selected', 'none']);
export const subagentNotificationSchema = z.enum(['never', 'next-turn', 'immediate']);
export const subagentBudgetSchema = z.object({
  maxCostUsd: z.number().positive().optional(),
  maxInputTokens: z.number().int().positive().safe().optional(),
  maxOutputTokens: z.number().int().positive().safe().optional(),
  maxTotalTokens: z.number().int().positive().safe().optional(),
  maxTurns: z.number().int().positive().safe().optional(),
}).strict();
export const subagentMailboxSchema = z.object({
  state: z.enum(['disabled', 'available', 'expired', 'closed']),
  ttlMs: z.number().int().nonnegative().safe(),
  expiresAt: z.number().finite().optional(),
  followUpCount: z.number().int().nonnegative(),
}).strict();
export const subagentUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  contextTokens: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
}).strict();
export const subagentLivenessReportSchema = z.object({
  id: z.string().min(1).max(160),
  trigger: z.enum(['repetition', 'idle', 'runtime-limit', 'checkpoint', 'adaptive-limit', 'resource-limit']),
  reason: z.string().min(1).max(2_000),
  evidence: z.array(z.object({
    signal: z.enum(['repeated-tool', 'repeated-error', 'idle-duration', 'runtime-duration', 'turn-threshold', 'checkpoint', 'cost-threshold', 'input-token-threshold', 'output-token-threshold', 'total-token-threshold']),
    detail: z.string().min(1).max(1_000),
    count: z.number().int().nonnegative().optional(),
  }).strict()).min(1).max(12),
  recentProgress: z.array(z.string().min(1).max(1_000)).max(8),
  counters: z.object({
    turns: z.number().int().nonnegative(),
    activities: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    repeatedOccurrences: z.number().int().nonnegative(),
    softTurnThreshold: z.number().int().positive().safe(),
  }).strict(),
  timing: z.object({
    detectedAt: z.number().finite(),
    startedAt: z.number().finite(),
    lastActivityAt: z.number().finite(),
    lastProgressAt: z.number().finite(),
    idleForMs: z.number().int().nonnegative().safe().optional(),
    cooldownMs: z.number().int().nonnegative().safe(),
  }).strict(),
  child: z.object({
    runId: z.string().min(1).max(100),
    handle: subagentHandleSchema,
    displayName: subagentDisplayNameSchema,
    role: subagentRoleSchema,
    task: z.string().min(1),
  }).strict(),
  checkpointSummary: z.string().min(1).max(4_000),
  recommendedOptions: z.array(z.enum(['continue', 'steer', 'request-checkpoint', 'cancel'])).min(1).max(4),
}).strict();
export const subagentWorkflowLivenessReportSchema = z.object({
  id: z.string().min(1).max(160),
  trigger: z.enum(['adaptive-limit', 'resource-limit']),
  reason: z.string().min(1).max(2_000),
  evidence: z.array(z.object({
    signal: z.enum(['turn-threshold', 'cost-threshold', 'input-token-threshold', 'output-token-threshold', 'total-token-threshold']),
    detail: z.string().min(1).max(1_000),
    count: z.number().int().nonnegative().optional(),
  }).strict()).min(1).max(12),
  recentProgress: z.array(z.string().min(1).max(1_000)).max(8),
  counters: z.object({
    turns: z.number().int().nonnegative(),
    completedNodes: z.number().int().nonnegative(),
    runningNodes: z.number().int().nonnegative(),
    pendingNodes: z.number().int().nonnegative(),
    totalNodes: z.number().int().positive(),
    softTurnThreshold: z.number().int().positive().safe(),
  }).strict(),
  timing: z.object({
    detectedAt: z.number().finite(),
    startedAt: z.number().finite(),
    updatedAt: z.number().finite(),
  }).strict(),
  workflow: z.object({
    id: z.string().min(1).max(100),
  }).strict(),
  checkpointSummary: z.string().min(1).max(4_000),
  recommendedOptions: z.array(z.enum(['continue', 'steer', 'request-checkpoint', 'cancel'])).min(1).max(4),
}).strict();
export const subagentRunSchema = z.object({
  id: z.string().min(1).max(100),
  parentSessionId: z.string().min(1).max(500),
  parentToolCallId: z.string().min(1).max(500),
  task: z.string().min(1),
  role: subagentRoleSchema,
  handle: subagentHandleSchema.optional(),
  displayName: subagentDisplayNameSchema.optional(),
  agentName: z.string().min(1).max(80),
  agentSource: subagentAgentSourceSchema,
  permissionLevel: permissionLevelSchema,
  enabledTools: z.array(z.enum(['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash', 'generate_image'])).max(8),
  skills: z.array(z.string().min(1).max(64)).default([]),
  skillMode: subagentSkillModeSchema.default('all'),
  preloadedSkills: z.array(z.string().min(1).max(64)).default([]),
  status: subagentStatusSchema,
  model: modelInfoSchema,
  routingModels: z.array(modelInfoSchema).default([]),
  thinkingLevel: thinkingLevelSchema,
  executionMode: z.enum(['blocking', 'managed', 'workflow']),
  controlCount: z.number().int().nonnegative(),
  attempt: z.number().int().positive().safe().default(1),
  maxAttempts: z.number().int().positive().safe().default(1),
  mailbox: subagentMailboxSchema.default({ state: 'disabled', ttlMs: 0, followUpCount: 0 }),
  notification: subagentNotificationSchema.default('never'),
  budget: subagentBudgetSchema.optional(),
  workflowId: z.string().min(1).max(100).optional(),
  workflowNodeId: z.string().min(1).max(80).optional(),
  dependsOn: z.array(z.string().min(1).max(80)).default([]),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  startedAt: z.number().finite().optional(),
  endedAt: z.number().finite().optional(),
  timeoutAt: z.number().finite().optional(),
  idleTimeoutMs: z.number().int().positive().safe().optional(),
  messages: z.array(runtimeMessageSchema).max(120),
  tools: z.array(runtimeToolSchema).max(120),
  result: z.string().optional(),
  error: z.string().max(4_000).optional(),
  omittedActivity: z.number().int().nonnegative(),
  transcriptTruncated: z.boolean(),
  usage: subagentUsageSchema,
  livenessReports: z.array(subagentLivenessReportSchema).max(20).optional(),
}).strict().superRefine((run, context) => {
  if (run.messages.length + run.tools.length > 120) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Subagent activity exceeds its item limit.' });
  }
  if (new Set(run.enabledTools).size !== run.enabledTools.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Subagent enabled tools must be unique.' });
  }
  if (new Set(run.skills).size !== run.skills.length || new Set(run.preloadedSkills).size !== run.preloadedSkills.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Subagent skills must be unique.' });
  }
  if ((run.workflowId === undefined) !== (run.workflowNodeId === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Workflow run metadata must include both workflow and node IDs.' });
  }
  const characters = run.messages.reduce((total, message) => total + message.text.length + (message.reasoning?.length ?? 0), 0)
    + run.tools.reduce((total, tool) => total + tool.input.length + tool.output.length, 0)
    + (run.error?.length ?? 0);
  if (characters > 320_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Subagent transcript exceeds its text budget.' });
  }
  const imageCharacters = [...run.messages, ...run.tools]
    .reduce((total, item) => total + (item.images?.reduce((imageTotal, image) => imageTotal + image.data.length, 0) ?? 0), 0);
  if (imageCharacters > MAX_SUBAGENT_IMAGE_CHARACTERS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Subagent transcript exceeds its image budget.' });
  }
});
export const subagentWorkflowNodeStatusSchema = z.enum(['pending', 'running', 'completed', 'error', 'skipped', 'cancelled', 'interrupted']);
export const subagentWorkflowStatusSchema = z.enum(['running', 'completed', 'error', 'cancelled', 'paused']);
export const subagentWorkflowNodeSchema = z.object({
  id: z.string().min(1).max(80),
  handle: subagentHandleSchema.optional(),
  displayName: subagentDisplayNameSchema.optional(),
  task: z.string().min(1),
  status: subagentWorkflowNodeStatusSchema,
  dependsOn: z.array(z.string().min(1).max(80)),
  runId: z.string().min(1).max(100).optional(),
  result: z.string().optional(),
  error: z.string().max(4_000).optional(),
  startedAt: z.number().finite().optional(),
  endedAt: z.number().finite().optional(),
}).strict();
export const subagentWorkflowSchema = z.object({
  id: z.string().min(1).max(100),
  parentSessionId: z.string().min(1).max(500),
  parentToolCallId: z.string().min(1).max(500),
  status: subagentWorkflowStatusSchema,
  maxConcurrency: z.number().int().positive().safe(),
  notification: subagentNotificationSchema,
  budget: subagentBudgetSchema.optional(),
  usage: subagentUsageSchema,
  nodes: z.array(subagentWorkflowNodeSchema).min(1),
  livenessReports: z.array(subagentWorkflowLivenessReportSchema).max(20).optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  endedAt: z.number().finite().optional(),
  error: z.string().max(4_000).optional(),
}).strict().superRefine((workflow, context) => {
  const ids = new Set(workflow.nodes.map((node) => node.id));
  if (ids.size !== workflow.nodes.length || workflow.nodes.some((node) => node.dependsOn.some((dependency) => !ids.has(dependency)))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Workflow nodes and dependencies must reference unique local IDs.' });
    return;
  }
  const remainingDependencies = new Map(workflow.nodes.map((node) => [node.id, node.dependsOn.length]));
  const dependents = new Map(workflow.nodes.map((node) => [node.id, [] as string[]]));
  for (const node of workflow.nodes) for (const dependency of node.dependsOn) dependents.get(dependency)!.push(node.id);
  const ready = workflow.nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id);
  let visited = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index]!;
    visited += 1;
    for (const dependent of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependent)! - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  if (visited !== workflow.nodes.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Workflow dependencies must be acyclic.' });
});

export const subagentToolDetailsSchema = z.object({
  kind: z.literal('fate-subagent'),
  version: z.union([z.literal(2), z.literal(3)]),
  runIds: z.array(z.string().min(1).max(100)),
  runs: z.array(subagentRunSchema).optional(),
}).strict();
export const subagentSnapshotSchema = z.object({
  kind: z.literal('fate-subagent-snapshot'),
  version: z.union([z.literal(1), z.literal(2)]),
  run: subagentRunSchema,
}).strict();

export const sessionAttentionSchema = z.enum(['running', 'completed', 'error']);
export const sessionSummarySchema = z.object({
  id: z.string().min(1).max(500),
  title: z.string().min(1).max(200),
  firstMessage: z.string().max(2_000),
  path: z.string().min(1).max(32_768),
  createdAt: z.string().datetime(),
  modifiedAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
  parentSessionPath: z.string().max(32_768).optional(),
  active: z.boolean(),
  attention: sessionAttentionSchema.nullable().optional(),
});

/** A saved session selected as read-only context for the next Pi prompt. */
export const sessionReferenceSchema = z.object({
  id: z.string().min(1).max(500),
  title: z.string().min(1).max(200),
  projectPath: z.string().min(1).max(32_768),
}).strict();
const promptSessionReferencesSchema = z.array(sessionReferenceSchema).max(8).superRefine((references, context) => {
  const keys = new Set(references.map((reference) => `${reference.projectPath}\u0000${reference.id}`));
  if (keys.size !== references.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Session references must be unique.' });
  }
});

export const sessionBranchSchema = z.object({
  id: z.string().min(1).max(500),
  parentId: z.string().max(500).nullable(),
  depth: z.number().int().nonnegative().max(50_000),
  label: z.string().max(500).optional(),
  preview: z.string().max(500),
  kind: z.string().min(1).max(100),
  active: z.boolean(),
});

export const sessionCapabilitiesSchema = z.object({
  fork: z.boolean(),
  navigate: z.boolean().optional(),
  clone: z.boolean(),
  import: z.boolean(),
  compact: z.boolean(),
});

export const forkPointSchema = z.object({ entryId: z.string().min(1).max(500), text: z.string().max(2_000) });

export const promptImageSchema = z.object({
  data: z.string().min(1).max(14_000_000),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']),
  name: z.string().min(1).max(255),
}).strict();
const promptImagesSchema = z.array(promptImageSchema).max(4).superRefine((images, context) => {
  if (images.reduce((total, image) => total + image.data.length, 0) > 20_000_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Image attachments exceed the combined encoded-size limit.' });
  }
});
export const queuedMessageSchema = z.object({
  id: z.string().uuid(),
  behavior: z.enum(['steer', 'followUp']),
  text: z.string().min(1).max(200_000),
  images: promptImagesSchema.optional(),
  browserAnnotations: z.array(browserAnnotationReferenceSchema).max(24).optional(),
  sessionReferences: promptSessionReferencesSchema.optional(),
  createdAt: z.number().finite(),
});
export const runtimeQueueSchema = z.object({
  steering: z.number().int().nonnegative(),
  followUp: z.number().int().nonnegative(),
  items: z.array(queuedMessageSchema).max(100).optional(),
  /** Messages held by the strict GoalMax/task gate until verification passes. */
  held: z.array(queuedMessageSchema).max(100).optional(),
});

export const extensionUiStateSchema = z.object({
  statuses: z.array(z.object({
    key: z.string().min(1).max(100),
    text: z.string().min(1).max(500),
  }).strict()).max(16),
  widgets: z.array(z.object({
    key: z.string().min(1).max(100),
    lines: z.array(z.string().min(1).max(500)).max(32),
  }).strict()).max(8),
  working: z.string().min(1).max(300).nullable(),
  title: z.string().min(1).max(300).nullable(),
}).strict();

const providerLoginMethodSchema = z.enum(['api_key', 'oauth']);
const providerLoginOptionSchema = z.object({ id: z.string().min(1).max(500), label: z.string().min(1).max(500), description: z.string().max(2_000).optional() }).strict();
export const providerLoginProviderSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  methods: z.array(providerLoginMethodSchema).min(1).max(2),
  configured: z.boolean(),
}).strict();
export const providerLoginPromptSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['text', 'secret', 'select', 'manual_code']),
  message: z.string().min(1).max(2_000),
  placeholder: z.string().max(500).optional(),
  options: z.array(providerLoginOptionSchema).max(100).optional(),
}).strict();
export const providerLoginStateSchema = z.object({
  status: z.enum(['idle', 'working', 'awaiting-input', 'error']),
  providers: z.array(providerLoginProviderSchema).max(500),
  providerId: z.string().min(1).max(200).nullable(),
  providerName: z.string().min(1).max(300).nullable(),
  method: providerLoginMethodSchema.nullable(),
  prompt: providerLoginPromptSchema.nullable(),
  message: z.string().max(2_000).nullable(),
  deviceCode: z.object({ userCode: z.string().min(1).max(500), verificationUri: z.string().url().max(2_000), expiresInSeconds: z.number().int().positive().max(86_400).optional() }).strict().nullable(),
}).strict();
export const providerLoginStartInputSchema = z.object({ providerId: z.string().trim().min(1).max(200), method: providerLoginMethodSchema }).strict();
export const providerLoginRespondInputSchema = z.object({ promptId: z.string().uuid(), value: z.string().max(20_000) }).strict();
export const providerLogoutInputSchema = z.object({ providerId: z.string().trim().min(1).max(200) }).strict();

export const runtimeStateSchema = z.object({
  status: z.enum(['disconnected', 'initializing', 'ready', 'auth-required', 'error']),
  project: projectStateSchema.nullable(),
  sessionId: z.string().min(1).nullable(),
  sessionFile: z.string().nullable(),
  streaming: z.boolean(),
  activeSessionRunning: z.boolean().optional(),
  runningSessionCount: z.number().int().nonnegative().max(4).optional(),
  model: modelInfoSchema.nullable(),
  pendingModel: modelInfoSchema.nullable().optional(),
  models: z.array(modelInfoSchema).max(2_000),
  thinkingLevel: thinkingLevelSchema,
  pendingThinkingLevel: thinkingLevelSchema.nullable().optional(),
  permissionLevel: permissionLevelSchema.optional(),
  providerLogin: providerLoginStateSchema.optional(),
  messages: z.array(runtimeMessageSchema),
  tools: z.array(runtimeToolSchema).optional(),
  commands: z.array(slashCommandSchema).max(5_000).optional(),
  skills: z.array(skillInfoSchema).max(5_000).optional(),
  objective: z.string().optional(),
  contextUsage: contextUsageSchema.optional(),
  tokenTelemetry: runtimeTokenTelemetrySchema.optional(),
  queue: runtimeQueueSchema.optional(),
  taskList: taskListSummarySchema.optional(),
  extensionUi: extensionUiStateSchema.optional(),
  sessions: z.array(sessionSummarySchema).max(1_000).optional(),
  subagents: z.array(subagentRunSchema).optional(),
  subagentWorkflows: z.array(subagentWorkflowSchema).optional(),
  agentTeams: z.array(agentTeamSchema).max(AGENT_TEAM_MAX_RETAINED_TEAMS).optional(),
  branches: z.array(sessionBranchSchema).max(5_000).optional(),
  forkPoints: z.array(forkPointSchema).max(2_000).optional(),
  sessionCapabilities: sessionCapabilitiesSchema.optional(),
  sessionOperation: z.boolean().optional(),
  eventCursor: z.number().int().nonnegative().optional(),
  error: appErrorSchema.nullable(),
  modelsDevManaged: z.array(modelsDevManagedProviderSchema).max(200).optional(),
});

export const modelsDevMutationResultSchema = z.object({
  providerId: z.string().min(1).max(200),
  providerName: z.string().min(1).max(300),
  modelCount: z.number().int().nonnegative(),
  state: runtimeStateSchema,
});

export const automationSessionPreparationResultSchema = z.object({
  state: runtimeStateSchema,
  automation: automationDefinitionSchema,
}).strict();

const eventBaseSchema = z.object({ timestamp: z.number().finite(), cursor: z.number().int().nonnegative().optional() }).strict();
const runStartedEventSchema = eventBaseSchema.extend({ type: z.literal('run.started'), runId: z.string().min(1) });
const runCompletedEventSchema = eventBaseSchema.extend({ type: z.literal('run.completed'), runId: z.string().min(1), aborted: z.boolean() });
const messageStartedEventSchema = eventBaseSchema.extend({ type: z.literal('message.started'), messageId: z.string().min(1), role: z.enum(['user', 'assistant', 'system', 'tool']) });
const messageCompletedEventSchema = eventBaseSchema.extend({ type: z.literal('message.completed'), messageId: z.string().min(1), role: z.enum(['user', 'assistant', 'system', 'tool']), text: z.string().max(65_000), images: z.array(runtimeImageSchema).max(8).optional(), error: z.boolean().optional() });
const assistantTextEventSchema = eventBaseSchema.extend({ type: z.literal('assistant.text'), messageId: z.string().min(1), delta: z.string().min(1).max(32_000) });
const assistantReasoningEventSchema = eventBaseSchema.extend({ type: z.literal('assistant.reasoning'), messageId: z.string().min(1), delta: z.string().min(1).max(32_000) });
const toolStartedEventSchema = eventBaseSchema.extend({ type: z.literal('tool.started'), toolCallId: z.string().min(1), name: z.string().min(1), input: z.string().max(65_000), subagentRunIds: z.array(z.string().min(1).max(100)).optional(), provenance: toolProvenanceSchema.optional() });
const toolUpdatedEventSchema = eventBaseSchema.extend({ type: z.literal('tool.updated'), toolCallId: z.string().min(1), output: z.string().max(65_000), subagentRunIds: z.array(z.string().min(1).max(100)).optional(), provenance: toolProvenanceSchema.optional() });
const toolCompletedEventSchema = eventBaseSchema.extend({ type: z.literal('tool.completed'), toolCallId: z.string().min(1), name: z.string().min(1), output: z.string().max(65_000), images: z.array(runtimeImageSchema).max(8).optional(), error: z.boolean(), subagentRunIds: z.array(z.string().min(1).max(100)).optional(), provenance: toolProvenanceSchema.optional() });
const queueChangedEventSchema = eventBaseSchema.extend({ type: z.literal('queue.changed'), steering: z.number().int().nonnegative(), followUp: z.number().int().nonnegative() });
const contextCompactionEventSchema = eventBaseSchema.extend({ type: z.literal('context.compaction'), phase: z.enum(['started', 'completed', 'failed']), aborted: z.boolean().optional(), error: appErrorSchema.optional() });
const errorEventSchema = eventBaseSchema.extend({ type: z.literal('error'), error: appErrorSchema });
export const subagentChildEventSchema = z.discriminatedUnion('type', [
  runStartedEventSchema,
  runCompletedEventSchema,
  messageStartedEventSchema,
  messageCompletedEventSchema,
  assistantTextEventSchema,
  assistantReasoningEventSchema,
  toolStartedEventSchema,
  toolUpdatedEventSchema,
  toolCompletedEventSchema,
  queueChangedEventSchema,
  contextCompactionEventSchema,
  errorEventSchema,
]);
export const piEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema.extend({ type: z.literal('run.accepted'), runId: z.string().min(1) }),
  runStartedEventSchema,
  runCompletedEventSchema,
  messageStartedEventSchema,
  messageCompletedEventSchema,
  assistantTextEventSchema,
  assistantReasoningEventSchema,
  toolStartedEventSchema,
  toolUpdatedEventSchema,
  toolCompletedEventSchema,
  queueChangedEventSchema,
  contextCompactionEventSchema,
  eventBaseSchema.extend({ type: z.literal('state.changed'), state: runtimeStateSchema, messagesIncluded: z.boolean() }),
  errorEventSchema,
  eventBaseSchema.extend({ type: z.literal('subagent.started'), run: subagentRunSchema }),
  eventBaseSchema.extend({
    type: z.literal('subagent.updated'),
    runId: z.string().min(1).max(100),
    status: subagentStatusSchema,
    updatedAt: z.number().finite(),
    startedAt: z.number().finite().optional(),
    timeoutAt: z.number().finite().optional(),
    model: modelInfoSchema.optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
    controlCount: z.number().int().nonnegative().optional(),
    displayName: subagentDisplayNameSchema.optional(),
    attempt: z.number().int().positive().safe().optional(),
    mailbox: subagentMailboxSchema.optional(),
    usage: subagentUsageSchema.optional(),
  }),
  eventBaseSchema.extend({ type: z.literal('subagent.event'), runId: z.string().min(1).max(100), event: subagentChildEventSchema }),
  eventBaseSchema.extend({ type: z.literal('subagent.liveness'), runId: z.string().min(1).max(100), report: subagentLivenessReportSchema }),
  eventBaseSchema.extend({ type: z.literal('subagent.completed'), run: subagentRunSchema }),
  eventBaseSchema.extend({ type: z.literal('subagent.workflow.updated'), workflow: subagentWorkflowSchema }),
  eventBaseSchema.extend({ type: z.literal('subagent.workflow.liveness'), workflowId: z.string().min(1).max(100), report: subagentWorkflowLivenessReportSchema }),
  eventBaseSchema.extend({ type: z.literal('agent-team.updated'), team: agentTeamSchema }),
]);

export const piEventBatchSchema = z.array(piEventSchema).min(1).max(100);
export const promptInputSchema = z.object({
  text: z.string().trim().min(1).max(200_000),
  behavior: z.enum(['prompt', 'steer', 'followUp']).default('prompt'),
  images: promptImagesSchema.optional(),
  browserAnnotations: z.array(browserAnnotationReferenceSchema).max(24).optional(),
  sessionReferences: promptSessionReferencesSchema.optional(),
}).strict();
export const promptAcceptanceSchema = z.object({ accepted: z.boolean(), runId: z.string().min(1) });
export const promptOptimizationInputSchema = z.object({ text: z.string().trim().min(1).max(200_000), advanced: z.boolean().default(false) }).strict();
export const promptOptimizationResultSchema = z.object({ text: z.string().trim().min(1).max(200_000) }).strict();
export const abortResultSchema = z.object({ aborted: z.boolean() });
const subagentControlTargetSchema = z.string().trim().min(1).max(100).refine((target) => !/[\u0000-\u001f\u007f]/u.test(target), 'Subagent targets cannot contain control characters.');
const individualSubagentTargetSchema = subagentControlTargetSchema.refine((target) => target.toLocaleLowerCase().replace(/^@/u, '') !== 'all', 'This action requires one agent handle.');
export const subagentControlInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('cancel'), target: subagentControlTargetSchema, reason: z.string().trim().min(1).max(500).optional() }).strict(),
  z.object({ action: z.literal('close'), target: individualSubagentTargetSchema }).strict(),
  z.object({ action: z.literal('steer'), target: individualSubagentTargetSchema, message: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ action: z.literal('followUp'), target: individualSubagentTargetSchema, message: z.string().trim().min(1).max(200_000) }).strict(),
  z.object({ action: z.literal('rename'), target: individualSubagentTargetSchema, displayName: subagentDisplayNameSchema }).strict(),
]);
export const setModelInputSchema = z.object({ provider: z.string().min(1), id: z.string().min(1) }).strict();
export const setThinkingInputSchema = z.object({ level: thinkingLevelSchema }).strict();
export const setPermissionInputSchema = z.object({ level: permissionLevelSchema }).strict();
export const queueMutationInputSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['cancel', 'edit', 'steer', 'followUp']),
}).strict();
export const queueMutationResultSchema = z.object({
  state: runtimeStateSchema,
  restored: z.object({
    text: z.string().min(1).max(200_000),
    images: promptImagesSchema.optional(),
    browserAnnotations: z.array(browserAnnotationReferenceSchema).max(24).optional(),
    sessionReferences: promptSessionReferencesSchema.optional(),
  }).optional(),
}).strict();
export const sessionSearchInputSchema = z.object({ query: z.string().max(500).default('') }).strict();
// Direct message to a saved session, delivered without switching the active
// view. A cold session is resumed first. steer injects into a running turn;
// followUp starts a new turn when the session is idle.
export const sessionDirectMessageInputSchema = z.object({
  sessionId: z.string().min(1).max(500),
  text: z.string().trim().min(1).max(200_000),
  behavior: z.enum(['steer', 'followUp']).default('followUp'),
}).strict();
export type SessionDirectMessageInput = z.infer<typeof sessionDirectMessageInputSchema>;
export const projectPathInputSchema = z.object({ projectPath: z.string().min(1).max(32_768) }).strict();
export const projectSessionListInputSchema = z.object({ projectPath: z.string().min(1).max(32_768), query: z.string().max(500).default('') }).strict();
export const projectDeleteSessionsResultSchema = z.object({ deleted: z.number().int().nonnegative().max(100_000), skipped: z.number().int().nonnegative().max(100_000) }).strict();
export const sessionIdInputSchema = z.object({ sessionId: z.string().min(1).max(500) }).strict();
export const sessionRenameInputSchema = z.object({
  sessionId: z.string().min(1).max(500),
  name: z.string().trim().min(1).max(120).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Session names cannot contain control characters.'),
}).strict();
export const sessionEntryInputSchema = z.object({ entryId: z.string().min(1).max(500) }).strict();
export const compactInputSchema = z.object({ instructions: z.string().trim().max(20_000).optional() }).strict();
export const sessionListSchema = z.array(sessionSummarySchema).max(1_000);
export const forkSessionResultSchema = z.object({ state: runtimeStateSchema, selectedText: z.string().optional() }).strict();
export const navigateSessionBranchResultSchema = z.object({ state: runtimeStateSchema, selectedText: z.string().max(200_000).optional() }).strict();
export const deleteSessionBranchResultSchema = z.object({ state: runtimeStateSchema }).strict();

export const terminalIdSchema = z.string().uuid();
export const terminalCreateInputSchema = z.object({ cols: z.number().int().min(2).max(400), rows: z.number().int().min(1).max(200) }).strict();
export const terminalCreateResultSchema = z.object({ id: terminalIdSchema, shell: z.string().min(1), cwd: z.string().min(1) });
export const terminalWriteInputSchema = z.object({ id: terminalIdSchema, data: z.string().max(65_536) }).strict();
export const terminalAckInputSchema = z.object({ id: terminalIdSchema, characters: z.number().int().min(1).max(65_536) }).strict();
export const terminalResizeInputSchema = z.object({ id: terminalIdSchema, cols: z.number().int().min(2).max(400), rows: z.number().int().min(1).max(200) }).strict();
export const terminalCloseInputSchema = z.object({ id: terminalIdSchema }).strict();
export const terminalEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), id: terminalIdSchema, data: z.string().max(131_072) }),
  z.object({ type: z.literal('exit'), id: terminalIdSchema, exitCode: z.number().int(), signal: z.number().int().optional() }),
]);
export const voiceHotkeyModeSchema = z.enum(['toggle', 'push-to-talk']);
export const defaultSpeechSettings = {
  enabled: true,
  modelId: 'canary-flash' as const,
  language: 'auto',
  inputDeviceId: null,
  liveTranscription: true,
  finalAccuracyPass: false,
  voiceHotkey: null,
  voiceHotkeyMode: 'toggle' as const,
};
export const speechSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  modelId: z.preprocess(
    (value) => (typeof value === 'string' ? migrateSpeechModelId(value) : value),
    speechModelIdSchema.default('canary-flash'),
  ),
  language: z.string().trim().min(2).max(16).default('auto'),
  inputDeviceId: z.string().max(1_024).nullable().default(null),
  liveTranscription: z.boolean().default(true),
  /** Re-runs the full recording once at stop for a final accuracy pass.
   *  Off by default: it doubles decode work, which is why long dictations
   *  used to max out the CPU (Handy makes the same pass opt-in). */
  finalAccuracyPass: z.boolean().default(false),
  voiceHotkey: z.string().trim().min(1).max(64).nullable().default(null),
  voiceHotkeyMode: voiceHotkeyModeSchema.default('toggle'),
}).strict();
export const speechModelInfoSchema = z.object({
  id: speechModelIdSchema,
  tier: speechTierSchema,
  name: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  detail: z.string().min(1).max(300),
  bytes: z.number().int().positive(),
  installed: z.boolean(),
  downloadedBytes: z.number().int().nonnegative(),
  /** True when the model supports live streaming transcription. */
  streaming: z.boolean(),
}).strict();
export const speechStatusSchema = z.object({
  models: z.array(speechModelInfoSchema).min(1).max(12),
  backend: z.string().min(1).max(300),
  accelerated: z.boolean(),
}).strict();
export const speechModelInputSchema = z.object({ modelId: speechModelIdSchema }).strict();
const arrayBufferSchema = z.custom<ArrayBuffer>((value) => Object.prototype.toString.call(value) === '[object ArrayBuffer]' && typeof (value as ArrayBuffer).byteLength === 'number');
export const speechTranscribeInputSchema = z.object({
  modelId: speechModelIdSchema,
  audio: arrayBufferSchema.refine((value) => value.byteLength > 0 && value.byteLength <= 16_000 * 180 * 4 && value.byteLength % 4 === 0, 'Audio must be bounded 16 kHz Float32 PCM.'),
  language: z.string().trim().min(2).max(16).optional(),
}).strict();
export const speechTranscriptionSchema = z.object({
  text: z.string().max(200_000),
  language: z.string().min(1).max(100),
  backend: z.string().min(1).max(300),
  accelerated: z.boolean(),
}).strict();
export const speechDownloadProgressSchema = z.object({
  modelId: speechModelIdSchema,
  state: z.enum(['downloading', 'verifying', 'installed', 'cancelled', 'error']),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
  error: z.string().min(1).max(1_000).optional(),
}).strict();
export const speechCancelResultSchema = z.object({ cancelled: z.boolean() }).strict();
export const speechStreamStateSchema = z.enum(['active', 'finalizing', 'final', 'error', 'cancelled']);
export const speechStreamStartInputSchema = z.object({
  modelId: speechModelIdSchema,
  language: z.string().trim().min(2).max(16).optional(),
  /** Run the full-recording accuracy pass at stop. Off by default — the pass
   *  doubles decode work and is the main CPU spike on long dictations. */
  refine: z.boolean().default(false),
}).strict();
export const speechStreamFeedInputSchema = z.object({
  audio: arrayBufferSchema.refine((value) => value.byteLength > 0 && value.byteLength <= MAX_SPEECH_STREAM_FEED_SAMPLES * SPEECH_PCM_BYTES_PER_SAMPLE && value.byteLength % SPEECH_PCM_BYTES_PER_SAMPLE === 0, 'Audio must be bounded 16 kHz Float32 PCM.'),
}).strict();
export const speechStreamUpdateSchema = z.object({
  state: speechStreamStateSchema,
  committed: z.string().max(200_000),
  tentative: z.string().max(200_000),
  error: z.string().min(1).max(1_000).optional(),
  /** Seconds of accepted audio still waiting for native inference, present on
   *  `active` updates. A growing value warns that the machine cannot keep up
   *  and the stream may fail; the UI can surface this before the hard limit. */
  backlogSeconds: z.number().min(0).max(600).optional(),
}).strict();
export const voiceHotkeyEventSchema = z.object({
  action: z.enum(['start', 'stop']),
  source: z.enum(['hotkey', 'button']).default('hotkey'),
}).strict();
export const speechHotkeyStatusSchema = z.object({
  pushToTalkAvailable: z.boolean(),
  reason: z.string().min(1).max(300).optional(),
}).strict();

export const updateCheckResultSchema = z.object({
  status: z.enum(['local-unreadable', 'local-invalid', 'remote-unavailable', 'remote-invalid', 'current', 'available', 'development']),
  message: z.string().min(1).max(300),
  installedVersion: z.string().min(1).max(100).optional(),
  productionVersion: z.string().min(1).max(100).optional(),
}).strict();
export const openUpdateDownloadResultSchema = z.object({ opened: z.literal(true) }).strict();
export const updateDownloadProgressSchema = z.object({
  downloaded: z.number().nonnegative(),
  total: z.number().nonnegative(),
  percent: z.number().min(0).max(1),
  version: z.string().min(1).max(100),
}).strict();
export const updateInstallStartedSchema = z.object({ installing: z.literal(true) }).strict();
export const updateVersionInputSchema = z.object({ version: z.string().min(1).max(100) }).strict();

export const imageGenerationSettingsSchema = z.object({
  provider: z.enum(imageGenerationProviderIds),
  model: z.string().trim().min(1).max(500).nullable(),
  customProvider: z.string().trim().min(1).max(200).nullable().default(null),
}).strict();

export const appSettingsSchema = z.object({
  appearance: z.enum(['dark', 'system']),
  defaultModel: z.string().max(500).nullable(),
  /** Hidden `provider/id` keys. Disabled models stay loaded but leave the picker. */
  disabledModels: z.array(z.string().min(1).max(700)).max(5_000).default([]),
  thinkingLevel: thinkingLevelSchema,
  agentTeamMode: z.enum(['legacy', 'v2']).default('legacy'),
  confirmRiskyCommands: z.boolean(),
  terminalShell: z.string().max(4_096).nullable(),
  reduceMotion: z.boolean(),
  performanceMode: z.boolean().default(false),
  holyShitMode: z.boolean().default(false),
  musicPlayerEnabled: z.boolean().default(false),
  sendMessageWithModifier: z.boolean().default(false),
  compactMode: z.boolean().default(false),
  compactSessions: z.boolean().default(false),
  advancedPromptImprovement: z.boolean().default(false),
  crashTelemetryEnabled: z.boolean().default(false),
  themeId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/).default('catppuccin-mocha'),
  interfaceFont: interfaceFontSchema.default('noto-sans'),
  codeFont: codeFontSchema.default('jetbrains-mono'),
  imageGeneration: imageGenerationSettingsSchema.default({ provider: 'auto', model: null, customProvider: null }),
  speech: speechSettingsSchema.default(defaultSpeechSettings),
}).strict();
export const musicStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().min(1).max(100).nullable(),
  message: z.string().min(1).max(300).optional(),
}).strict();
export const musicLoadInputSchema = z.object({ url: z.string().trim().min(1).max(2_048) }).strict();
export const musicTrackSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(300),
  duration: z.number().finite().nonnegative().nullable(),
}).strict();
export const musicQueueSchema = z.object({
  title: z.string().min(1).max(300),
  tracks: z.array(musicTrackSchema).min(1).max(200),
}).strict();
export const musicTrackInputSchema = z.object({ trackId: z.string().uuid() }).strict();
export const musicStreamSchema = z.object({
  trackId: z.string().uuid(),
  title: z.string().min(1).max(300),
  duration: z.number().finite().nonnegative().nullable(),
  url: z.string().url().max(16_384),
}).strict();
export const musicQueueResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: musicQueueSchema }).strict(),
  z.object({ ok: z.literal(false), error: appErrorSchema }).strict(),
]);
export const musicStreamResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: musicStreamSchema }).strict(),
  z.object({ ok: z.literal(false), error: appErrorSchema }).strict(),
]);
export const musicClearResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: appErrorSchema }).strict(),
]);
export const musicDurationUpdateSchema = z.object({
  trackId: z.string().uuid(),
  duration: z.number().finite().positive(),
}).strict();
export const musicDurationsEventSchema = z.object({
  updates: z.array(musicDurationUpdateSchema).min(1).max(200),
}).strict();
export { themeCatalogSchema };
export const diagnosticsSchema = z.object({
  appVersion: z.string(), electronVersion: z.string(), nodeVersion: z.string(), chromeVersion: z.string(),
  piVersion: z.string(), platform: z.string(), arch: z.string(), agentDirectory: z.string(), projectPath: z.string().nullable(),
  runtimeStatus: z.string(), sessionId: z.string().nullable(), packaged: z.boolean(),
});
export const logEntrySchema = z.object({ timestamp: z.string().datetime(), level: z.enum(['info', 'warn', 'error']), scope: z.string(), message: z.string() });
export const logListSchema = z.array(logEntrySchema).max(500);
export const appCommandSchema = z.enum(['open-project', 'new-session', 'focus-composer', 'focus-address', 'stop-generation', 'toggle-sidebar', 'toggle-inspector', 'toggle-browser', 'open-settings', 'open-terminal', 'open-palette', 'export-session']);
export const sessionExportResultSchema = z.object({
  saved: z.boolean(),
  path: z.string().min(1).max(32_768).optional(),
}).strict();

export type AppInfo = z.infer<typeof appInfoSchema>;
export type AppError = z.infer<typeof appErrorSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type PermissionLevel = z.infer<typeof permissionLevelSchema>;
export type ProviderLoginState = z.infer<typeof providerLoginStateSchema>;
export type ProviderLoginProvider = z.infer<typeof providerLoginProviderSchema>;
export type ProviderLoginStartInput = z.infer<typeof providerLoginStartInputSchema>;
export type ProviderLoginRespondInput = z.infer<typeof providerLoginRespondInputSchema>;
export type InterfaceFont = z.infer<typeof interfaceFontSchema>;
export type CodeFont = z.infer<typeof codeFontSchema>;
export type SpeechModelId = z.infer<typeof speechModelIdSchema>;
export type SpeechTier = z.infer<typeof speechTierSchema>;
export type SpeechSettings = z.infer<typeof speechSettingsSchema>;
export type SpeechModelInfo = z.infer<typeof speechModelInfoSchema>;
export type SpeechStatus = z.infer<typeof speechStatusSchema>;
export type SpeechDownloadProgress = z.infer<typeof speechDownloadProgressSchema>;
export type SpeechTranscription = z.infer<typeof speechTranscriptionSchema>;
export type SpeechStreamState = z.infer<typeof speechStreamStateSchema>;
export type SpeechStreamUpdate = z.infer<typeof speechStreamUpdateSchema>;
export type VoiceHotkeyMode = z.infer<typeof voiceHotkeyModeSchema>;
export type VoiceHotkeyEvent = z.infer<typeof voiceHotkeyEventSchema>;
export type SpeechHotkeyStatus = z.infer<typeof speechHotkeyStatusSchema>;
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export type ProjectState = z.infer<typeof projectStateSchema>;
export type RuntimeImage = z.infer<typeof runtimeImageSchema>;
export type ImageSaveInput = z.infer<typeof imageSaveInputSchema>;
export type ImageSaveResult = z.infer<typeof imageSaveResultSchema>;
export type RuntimeMessage = z.infer<typeof runtimeMessageSchema>;
export type RuntimeTool = z.infer<typeof runtimeToolSchema>;
export type TokenMetrics = z.infer<typeof tokenMetricsSchema>;
export type TokenUsageSample = z.infer<typeof tokenUsageSampleSchema>;
export type RuntimeTokenTelemetry = z.infer<typeof runtimeTokenTelemetrySchema>;
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export type AutomationSessionPreparationResult = z.infer<typeof automationSessionPreparationResultSchema>;
export type SubagentRole = z.infer<typeof subagentRoleSchema>;
export type SubagentAgentSource = z.infer<typeof subagentAgentSourceSchema>;
export type SubagentStatus = z.infer<typeof subagentStatusSchema>;
export type SubagentSkillMode = z.infer<typeof subagentSkillModeSchema>;
export type SubagentNotification = z.infer<typeof subagentNotificationSchema>;
export type SubagentBudget = z.infer<typeof subagentBudgetSchema>;
export type SubagentMailbox = z.infer<typeof subagentMailboxSchema>;
export type SubagentUsage = z.infer<typeof subagentUsageSchema>;
export type SubagentLivenessReport = z.infer<typeof subagentLivenessReportSchema>;
export type SubagentWorkflowLivenessReport = z.infer<typeof subagentWorkflowLivenessReportSchema>;
export type SubagentParentLivenessReport = SubagentLivenessReport | SubagentWorkflowLivenessReport;
export type SubagentRun = z.infer<typeof subagentRunSchema>;
export type SubagentWorkflowNodeStatus = z.infer<typeof subagentWorkflowNodeStatusSchema>;
export type SubagentWorkflowStatus = z.infer<typeof subagentWorkflowStatusSchema>;
export type SubagentWorkflowNode = z.infer<typeof subagentWorkflowNodeSchema>;
export type SubagentWorkflow = z.infer<typeof subagentWorkflowSchema>;
export type SubagentToolDetails = z.infer<typeof subagentToolDetailsSchema>;
export type SubagentSnapshot = z.infer<typeof subagentSnapshotSchema>;
export type SubagentChildEvent = z.infer<typeof subagentChildEventSchema>;
export type ExtensionUiState = z.infer<typeof extensionUiStateSchema>;
export type SessionAttention = z.infer<typeof sessionAttentionSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionReference = z.infer<typeof sessionReferenceSchema>;
export type SessionBranch = z.infer<typeof sessionBranchSchema>;
export type DeleteSessionBranchResult = z.infer<typeof deleteSessionBranchResultSchema>;
export type PiEvent = z.infer<typeof piEventSchema>;
export type PromptInput = z.infer<typeof promptInputSchema>;
export type PromptAcceptance = z.infer<typeof promptAcceptanceSchema>;
export type PromptOptimizationInput = z.infer<typeof promptOptimizationInputSchema>;
export type PromptOptimizationResult = z.infer<typeof promptOptimizationResultSchema>;
export type PromptOptimizationOptions = { advanced?: boolean };
export type SubagentControlInput = z.infer<typeof subagentControlInputSchema>;
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type QueueMutationInput = z.infer<typeof queueMutationInputSchema>;
export type QueueMutationResult = z.infer<typeof queueMutationResultSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type FileList = z.infer<typeof fileListSchema>;
export type FilePreview = z.infer<typeof filePreviewSchema>;
export type GitChange = z.infer<typeof gitChangeSchema>;
export type GitStatus = z.infer<typeof gitStatusSchema>;
export type GitDiff = z.infer<typeof gitDiffSchema>;
export type GitCombinedDiff = z.infer<typeof gitCombinedDiffSchema>;
export type GitWorktree = z.infer<typeof gitWorktreeSchema>;
export type GitRef = z.infer<typeof gitRefSchema>;
export type GitCommitSummary = z.infer<typeof gitCommitSummarySchema>;
export type GitHistory = z.infer<typeof gitHistorySchema>;
export type GitCommitFile = z.infer<typeof gitCommitFileSchema>;
export type GitCommitDetails = z.infer<typeof gitCommitDetailsSchema>;
export type GitOperation = z.infer<typeof gitOperationSchema>;
export type GitOperationResult = z.infer<typeof gitOperationResultSchema>;
export type GitRevertPathResult = z.infer<typeof gitRevertPathResultSchema>;
export type RecoveryNotice = z.infer<typeof recoveryNoticeSchema>;
export type TerminalEvent = z.infer<typeof terminalEventSchema>;
export type ImageGenerationSettings = z.infer<typeof imageGenerationSettingsSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type UpdateCheckResult = z.infer<typeof updateCheckResultSchema>;
export type MusicStatus = z.infer<typeof musicStatusSchema>;
export type MusicTrack = z.infer<typeof musicTrackSchema>;
export type MusicQueue = z.infer<typeof musicQueueSchema>;
export type MusicStream = z.infer<typeof musicStreamSchema>;
export type MusicDurationUpdate = z.infer<typeof musicDurationUpdateSchema>;
export type MusicDurationsEvent = z.infer<typeof musicDurationsEventSchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type LogEntry = z.infer<typeof logEntrySchema>;
export type AppCommand = z.infer<typeof appCommandSchema>;
export type WindowControlAction = z.infer<typeof windowControlInputSchema>['action'];
export type WindowState = z.infer<typeof windowStateSchema>;

export type ModelsDevManagedProvider = z.infer<typeof modelsDevManagedProviderSchema>;
export type ModelsDevProviderSummary = z.infer<typeof modelsDevProviderSummarySchema>;
export type ModelsDevProviderDetail = z.infer<typeof modelsDevProviderDetailSchema>;
export type ModelsDevModelSummary = z.infer<typeof modelsDevModelSummarySchema>;
export type ModelsDevListResult = z.infer<typeof modelsDevListResultSchema>;
export type ModelsDevAddInput = z.infer<typeof modelsDevAddInputSchema>;
export type ModelsDevRemoveInput = z.infer<typeof modelsDevRemoveInputSchema>;
export type ModelsDevMutationResult = z.infer<typeof modelsDevMutationResultSchema>;

export interface PiDesktopApi {
  getAppInfo: () => Promise<AppInfo>;
  controlWindow: (action: WindowControlAction) => Promise<WindowState>;
  getWindowState: () => Promise<WindowState>;
  newWindow: () => Promise<void>;
  onWindowState: (listener: (state: WindowState) => void) => () => void;
  selectProject: () => Promise<RuntimeState>;
  openProject: (projectPath: string) => Promise<RuntimeState>;
  focusProject: (projectPath: string) => Promise<RuntimeState>;
  closeProjectRuntime: (projectPath: string) => Promise<void>;
  selectProjectFile: () => Promise<string | null>;
  revealProject: () => Promise<z.infer<typeof revealProjectResultSchema>>;
  revealProjectPath: (projectPath: string) => Promise<z.infer<typeof revealProjectResultSchema>>;
  readLocalImage: (path: string) => Promise<RuntimeImage>;
  saveImageAs: (input: ImageSaveInput) => Promise<ImageSaveResult>;
  writeClipboardText: (text: string) => Promise<void>;
  initializeBrowser: () => Promise<BrowserState>;
  getBrowserState: () => Promise<BrowserState>;
  setBrowserBounds: (bounds: BrowserBounds) => Promise<BrowserState>;
  setBrowserVisible: (visible: boolean) => Promise<BrowserState>;
  setBrowserOverlayBlocked: (blocked: boolean) => Promise<BrowserState>;
  navigateBrowser: (url: string) => Promise<BrowserState>;
  showBrowserLinkContextMenu: (url: string) => Promise<void>;
  onBrowserLinkOpen: (listener: (url: string) => void) => () => void;
  openBrowserLocalFile: () => Promise<BrowserState | null>;
  createBrowserTab: (initialUrl?: string) => Promise<BrowserState>;
  activateBrowserTab: (tabId: string) => Promise<BrowserState>;
  closeBrowserTab: (tabId: string) => Promise<BrowserState>;
  controlBrowserHistory: (action: 'back' | 'forward' | 'reload' | 'stop') => Promise<BrowserState>;
  setBrowserMode: (mode: BrowserUiMode) => Promise<BrowserState>;
  setBrowserDeviceEmulation: (emulation: BrowserDeviceEmulation | null) => Promise<BrowserState>;
  setBrowserControlLevel: (level: BrowserControlLevel) => Promise<BrowserState>;
  setBrowserOriginGrant: (grant: BrowserOriginGrant) => Promise<BrowserState>;
  revokeBrowserOriginGrant: (origin: string) => Promise<BrowserState>;
  snapshotBrowser: (input?: { mode?: BrowserSnapshotMode; scopeRef?: string; query?: string }) => Promise<SemanticPageSnapshot>;
  selectBrowserAnnotation: (kind: 'element' | 'region', comment: string) => Promise<BrowserAnnotation>;
  listBrowserAnnotations: () => Promise<BrowserAnnotation[]>;
  updateBrowserAnnotation: (id: string, comment: string) => Promise<BrowserAnnotation>;
  removeBrowserAnnotation: (id: string) => Promise<boolean>;
  dismissBrowserAnnotations: (ids: string[]) => Promise<boolean>;
  highlightBrowserAnnotation: (id: string) => Promise<boolean>;
  respondToBrowserConfirmation: (id: BrowserConfirmation['id'], approved: boolean) => Promise<boolean>;
  onBrowserEvents: (listener: (events: BrowserEvent[]) => void) => () => void;
  listAutomations: () => Promise<AutomationDefinition[]>;
  createAutomation: (input: AutomationCreateInput) => Promise<AutomationDefinition>;
  updateAutomation: (input: AutomationUpdateInput) => Promise<AutomationDefinition>;
  deleteAutomation: (id: string) => Promise<void>;
  recordAutomationLaunch: (id: string, outcome: AutomationLaunchOutcome) => Promise<AutomationDefinition>;
  prepareAutomationSession: (id: string) => Promise<AutomationSessionPreparationResult>;
  getRuntimeState: () => Promise<RuntimeState>;
  prompt: (input: PromptInput) => Promise<PromptAcceptance>;
  optimizePrompt: (text: string, options?: PromptOptimizationOptions) => Promise<PromptOptimizationResult>;
  abort: () => Promise<{ aborted: boolean }>;
  controlSubagent: (input: SubagentControlInput) => Promise<RuntimeState>;
  controlAgentTeam: (input: AgentTeamControlInput) => Promise<RuntimeState>;
  setModel: (provider: string, id: string) => Promise<RuntimeState>;
  setThinkingLevel: (level: ThinkingLevel) => Promise<RuntimeState>;
  setPermissionLevel: (level: PermissionLevel) => Promise<RuntimeState>;
  initializeProviderLogin: () => Promise<RuntimeState>;
  startProviderLogin: (input: ProviderLoginStartInput) => Promise<RuntimeState>;
  respondProviderLogin: (input: ProviderLoginRespondInput) => Promise<RuntimeState>;
  cancelProviderLogin: () => Promise<RuntimeState>;
  logoutProvider: (providerId: string) => Promise<RuntimeState>;
  listModelsDevProviders: () => Promise<z.infer<typeof modelsDevListResultSchema>>;
  getModelsDevProvider: (providerId: string) => Promise<z.infer<typeof modelsDevProviderDetailSchema>>;
  addModelsDevProvider: (input: z.infer<typeof modelsDevAddInputSchema>) => Promise<z.infer<typeof modelsDevMutationResultSchema>>;
  removeModelsDevProvider: (providerId: string) => Promise<z.infer<typeof modelsDevMutationResultSchema>>;
  mutateQueuedMessage: (input: QueueMutationInput) => Promise<QueueMutationResult>;
  getGoalMax: () => Promise<GoalMaxState | null>;
  createGoalMax: (input: GoalMaxCreateInput) => Promise<GoalMaxState>;
  controlGoalMax: (input: GoalMaxControlInput) => Promise<GoalMaxState>;
  updateGoalMax: (input: GoalMaxUpdateInput) => Promise<GoalMaxState>;
  clearGoalMax: () => Promise<GoalMaxClearResult>;
  editGoalMaxSteering: (input: GoalMaxSteeringEditInput) => Promise<GoalMaxState>;
  removeGoalMaxSteering: (input: GoalMaxSteeringRemoveInput) => Promise<GoalMaxState>;
  onGoalMaxEvents: (listener: (events: GoalMaxEvent[]) => void) => () => void;
  getTaskList: () => Promise<TaskList | null>;
  createTask: (input: TaskCreateInput) => Promise<TaskList>;
  updateTask: (input: TaskUpdateInput) => Promise<TaskList>;
  reorderTasks: (input: TaskReorderInput) => Promise<TaskList>;
  deleteTask: (input: TaskDeleteInput) => Promise<TaskList>;
  clearTasks: () => Promise<TaskList>;
  onTaskEvents: (listener: (events: TaskEvent[]) => void) => () => void;
  newSession: () => Promise<RuntimeState>;
  listSessions: (query?: string) => Promise<SessionSummary[]>;
  listProjectSessions: (projectPath: string, query?: string) => Promise<SessionSummary[]>;
  deleteProjectSessions: (projectPath: string) => Promise<z.infer<typeof projectDeleteSessionsResultSchema>>;
  switchSession: (sessionId: string) => Promise<RuntimeState>;
  sendSessionMessage: (input: SessionDirectMessageInput) => Promise<RuntimeState>;
  renameSession: (sessionId: string, name: string) => Promise<RuntimeState>;
  deleteSession: (sessionId: string) => Promise<RuntimeState>;
  forkSession: (entryId: string) => Promise<z.infer<typeof forkSessionResultSchema>>;
  navigateSessionBranch: (entryId: string) => Promise<z.infer<typeof navigateSessionBranchResultSchema>>;
  deleteSessionBranch: (entryId: string) => Promise<z.infer<typeof deleteSessionBranchResultSchema>>;
  cloneSession: () => Promise<RuntimeState>;
  importSession: () => Promise<RuntimeState | null>;
  compact: (instructions?: string) => Promise<RuntimeState>;
  listFiles: (path?: string) => Promise<FileList>;
  searchFiles: (query: string, limit?: number) => Promise<{ entries: FileEntry[]; truncated: boolean }>;
  readFile: (path: string) => Promise<FilePreview>;
  openFile: (path: string) => Promise<{ opened: boolean; error?: string | undefined }>;
  getGitStatus: () => Promise<GitStatus>;
  getGitDiff: (path: string) => Promise<GitDiff>;
  getGitCombinedDiff: () => Promise<GitCombinedDiff>;
  listGitWorktrees: () => Promise<GitWorktree[]>;
  switchGitWorktree: (path: string) => Promise<RuntimeState>;
  createWorktreeSession: (entryId: string) => Promise<z.infer<typeof gitWorktreeSessionResultSchema>>;
  getGitHistory: () => Promise<GitHistory>;
  getGitCommitDetails: (hash: string) => Promise<GitCommitDetails>;
  runGitOperation: (operation: GitOperation) => Promise<GitOperationResult>;
  revertGitPath: (path: string) => Promise<z.infer<typeof gitRevertPathResultSchema>>;
  consumeRecovery: () => Promise<z.infer<typeof recoveryNoticeResultSchema>>;
  exportSession: () => Promise<z.infer<typeof sessionExportResultSchema>>;
  createTerminal: (cols: number, rows: number) => Promise<z.infer<typeof terminalCreateResultSchema>>;
  writeTerminal: (id: string, data: string) => Promise<void>;
  acknowledgeTerminal: (id: string, characters: number) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (id: string) => Promise<void>;
  getSettings: () => Promise<AppSettings>;
  setSettings: (settings: AppSettings) => Promise<AppSettings>;
  checkForUpdates: () => Promise<UpdateCheckResult>;
  openUpdateDownload: () => Promise<void>;
  downloadAndInstallUpdate: (version: string) => Promise<void>;
  onUpdatesProgress: (listener: (progress: { downloaded: number; total: number; percent: number; version: string }) => void) => () => void;
  getThemes: () => Promise<ThemeDefinition[]>;
  getSpeechStatus: () => Promise<SpeechStatus>;
  ensureSpeechModel: (modelId: SpeechModelId) => Promise<void>;
  downloadSpeechModel: (modelId: SpeechModelId) => Promise<SpeechStatus>;
  cancelSpeechModelDownload: (modelId: SpeechModelId) => Promise<boolean>;
  removeSpeechModel: (modelId: SpeechModelId) => Promise<SpeechStatus>;
  transcribeSpeech: (modelId: SpeechModelId, audio: ArrayBuffer, language?: string) => Promise<SpeechTranscription>;
  cancelSpeechTranscription: () => Promise<boolean>;
  startSpeechStream: (modelId: SpeechModelId, language?: string, refine?: boolean) => Promise<void>;
  feedSpeechStream: (audio: ArrayBuffer) => Promise<void>;
  stopSpeechStream: () => Promise<void>;
  cancelSpeechStream: () => Promise<void>;
  getSpeechHotkeyStatus: () => Promise<SpeechHotkeyStatus>;
  onSpeechDownload: (listener: (progress: SpeechDownloadProgress) => void) => () => void;
  onSpeechStreamUpdate: (listener: (update: SpeechStreamUpdate) => void) => () => void;
  onVoiceHotkey: (listener: (event: VoiceHotkeyEvent) => void) => () => void;
  getMusicStatus: () => Promise<MusicStatus>;
  loadMusic: (url: string) => Promise<MusicQueue>;
  resolveMusicTrack: (trackId: string) => Promise<MusicStream>;
  clearMusicQueue: () => Promise<void>;
  onMusicDurations: (handler: (event: MusicDurationsEvent) => void) => () => void;
  getDiagnostics: () => Promise<Diagnostics>;
  getLogs: () => Promise<LogEntry[]>;
  queryAttestations: (request?: AttestationQueryRequestInput) => Promise<AttestationQueryResult>;
  onEvents: (listener: (events: PiEvent[]) => void) => () => void;
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => () => void;
  onAppCommand: (listener: (command: AppCommand) => void) => () => void;
}
