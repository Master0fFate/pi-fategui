import { z } from 'zod';

export const ipcChannels = {
  systemGetInfo: 'system:get-info',
  projectSelect: 'project:select',
  projectSelectFile: 'project:select-file',
  runtimeGetState: 'runtime:get-state',
  runtimePrompt: 'runtime:prompt',
  runtimeAbort: 'runtime:abort',
  runtimeSetModel: 'runtime:set-model',
  runtimeSetThinking: 'runtime:set-thinking',
  runtimeNewSession: 'runtime:new-session',
  runtimeListSessions: 'runtime:list-sessions',
  runtimeSwitchSession: 'runtime:switch-session',
  runtimeForkSession: 'runtime:fork-session',
  runtimeCloneSession: 'runtime:clone-session',
  runtimeImportSession: 'runtime:import-session',
  runtimeCompact: 'runtime:compact',
  runtimeEvents: 'runtime:events',
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalEvents: 'terminal:events',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  diagnosticsGet: 'diagnostics:get',
  logsGet: 'logs:get',
  appCommand: 'app:command',
  filesList: 'files:list',
  filesSearch: 'files:search',
  filesRead: 'files:read',
  filesOpen: 'files:open',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
} as const;

export const getAppInfoInputSchema = z.object({}).strict();
export const emptyInputSchema = z.object({}).strict();

export const appInfoSchema = z.object({
  name: z.literal('Pi Desktop'),
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
    'ABORTED',
    'UNKNOWN',
  ]),
  message: z.string().min(1),
  actionable: z.string().min(1).optional(),
  retryable: z.boolean(),
});

export const thinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const modelInfoSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  reasoning: z.boolean(),
  contextWindow: z.number().int().positive(),
  supportsImages: z.boolean().optional(),
});

export const projectStateSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  trusted: z.boolean(),
});
export const projectFileReferenceSchema = z.string().min(1).max(4_096).nullable();

export const relativePathSchema = z.string().max(4_096);
export const filePathInputSchema = z.object({ path: relativePathSchema }).strict();
export const fileListInputSchema = z.object({ path: relativePathSchema.default('') }).strict();
export const fileSearchInputSchema = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(500).default(300) }).strict();
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
  state: z.enum(['text', 'binary', 'large']),
  content: z.string().optional(),
  language: z.string(),
  openable: z.boolean(),
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
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  changes: z.array(gitChangeSchema).max(10_000),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export const gitDiffSchema = z.object({
  path: z.string().min(1),
  state: z.enum(['text', 'binary', 'large', 'unavailable']),
  original: z.string().optional(),
  modified: z.string().optional(),
  language: z.string(),
  openable: z.boolean(),
  message: z.string().optional(),
});

export const runtimeMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'tool']),
  text: z.string(),
  reasoning: z.string().optional(),
  timestamp: z.number().finite(),
  error: z.boolean().optional(),
});

export const slashCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
});
export const skillInfoSchema = z.object({ name: z.string().min(1), description: z.string() });
export const contextUsageSchema = z.object({ tokens: z.number().int().nonnegative().nullable(), contextWindow: z.number().int().positive(), percent: z.number().nonnegative().nullable() });

export const sessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  firstMessage: z.string(),
  path: z.string().min(1),
  createdAt: z.string().datetime(),
  modifiedAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
  parentSessionPath: z.string().optional(),
  active: z.boolean(),
});

export const sessionBranchSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  depth: z.number().int().nonnegative(),
  label: z.string().optional(),
  preview: z.string(),
  kind: z.string().min(1),
  active: z.boolean(),
});

export const sessionCapabilitiesSchema = z.object({
  fork: z.boolean(),
  clone: z.boolean(),
  import: z.boolean(),
  compact: z.boolean(),
});

export const forkPointSchema = z.object({ entryId: z.string().min(1), text: z.string() });

export const runtimeStateSchema = z.object({
  status: z.enum(['disconnected', 'initializing', 'ready', 'auth-required', 'error']),
  project: projectStateSchema.nullable(),
  sessionId: z.string().min(1).nullable(),
  sessionFile: z.string().nullable(),
  streaming: z.boolean(),
  model: modelInfoSchema.nullable(),
  models: z.array(modelInfoSchema),
  thinkingLevel: thinkingLevelSchema,
  messages: z.array(runtimeMessageSchema),
  commands: z.array(slashCommandSchema).optional(),
  skills: z.array(skillInfoSchema).optional(),
  objective: z.string().optional(),
  contextUsage: contextUsageSchema.optional(),
  sessions: z.array(sessionSummarySchema).optional(),
  branches: z.array(sessionBranchSchema).optional(),
  forkPoints: z.array(forkPointSchema).optional(),
  sessionCapabilities: sessionCapabilitiesSchema.optional(),
  sessionOperation: z.boolean().optional(),
  error: appErrorSchema.nullable(),
});

const eventBaseSchema = z.object({ timestamp: z.number().finite() });
export const piEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema.extend({ type: z.literal('run.accepted'), runId: z.string().min(1) }),
  eventBaseSchema.extend({ type: z.literal('run.started'), runId: z.string().min(1) }),
  eventBaseSchema.extend({ type: z.literal('run.completed'), runId: z.string().min(1), aborted: z.boolean() }),
  eventBaseSchema.extend({ type: z.literal('message.started'), messageId: z.string().min(1), role: z.enum(['user', 'assistant', 'tool']) }),
  eventBaseSchema.extend({ type: z.literal('message.completed'), messageId: z.string().min(1), role: z.enum(['user', 'assistant', 'tool']), text: z.string(), error: z.boolean().optional() }),
  eventBaseSchema.extend({ type: z.literal('assistant.text'), messageId: z.string().min(1), delta: z.string().min(1) }),
  eventBaseSchema.extend({ type: z.literal('assistant.reasoning'), messageId: z.string().min(1), delta: z.string().min(1) }),
  eventBaseSchema.extend({ type: z.literal('tool.started'), toolCallId: z.string().min(1), name: z.string().min(1), input: z.string() }),
  eventBaseSchema.extend({ type: z.literal('tool.updated'), toolCallId: z.string().min(1), output: z.string() }),
  eventBaseSchema.extend({ type: z.literal('tool.completed'), toolCallId: z.string().min(1), name: z.string().min(1), output: z.string(), error: z.boolean() }),
  eventBaseSchema.extend({ type: z.literal('queue.changed'), steering: z.number().int().nonnegative(), followUp: z.number().int().nonnegative() }),
  eventBaseSchema.extend({ type: z.literal('context.compaction'), phase: z.enum(['started', 'completed']), aborted: z.boolean().optional() }),
  eventBaseSchema.extend({ type: z.literal('state.changed'), state: runtimeStateSchema, messagesIncluded: z.boolean() }),
  eventBaseSchema.extend({ type: z.literal('error'), error: appErrorSchema }),
]);

export const piEventBatchSchema = z.array(piEventSchema).min(1).max(100);
export const promptImageSchema = z.object({
  data: z.string().min(1).max(20_000_000),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  name: z.string().min(1).max(255),
}).strict();
export const promptInputSchema = z.object({
  text: z.string().trim().min(1).max(200_000),
  behavior: z.enum(['prompt', 'steer', 'followUp']).default('prompt'),
  images: z.array(promptImageSchema).max(4).optional(),
}).strict();
export const promptAcceptanceSchema = z.object({ accepted: z.boolean(), runId: z.string().min(1) });
export const abortResultSchema = z.object({ aborted: z.boolean() });
export const setModelInputSchema = z.object({ provider: z.string().min(1), id: z.string().min(1) }).strict();
export const setThinkingInputSchema = z.object({ level: thinkingLevelSchema }).strict();
export const sessionSearchInputSchema = z.object({ query: z.string().max(500).default('') }).strict();
export const sessionIdInputSchema = z.object({ sessionId: z.string().min(1).max(500) }).strict();
export const sessionEntryInputSchema = z.object({ entryId: z.string().min(1).max(500) }).strict();
export const compactInputSchema = z.object({ instructions: z.string().trim().max(20_000).optional() }).strict();
export const sessionListSchema = z.array(sessionSummarySchema);

export const terminalIdSchema = z.string().uuid();
export const terminalCreateInputSchema = z.object({ cols: z.number().int().min(2).max(400), rows: z.number().int().min(1).max(200) }).strict();
export const terminalCreateResultSchema = z.object({ id: terminalIdSchema, shell: z.string().min(1), cwd: z.string().min(1) });
export const terminalWriteInputSchema = z.object({ id: terminalIdSchema, data: z.string().max(65_536) }).strict();
export const terminalResizeInputSchema = z.object({ id: terminalIdSchema, cols: z.number().int().min(2).max(400), rows: z.number().int().min(1).max(200) }).strict();
export const terminalCloseInputSchema = z.object({ id: terminalIdSchema }).strict();
export const terminalEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), id: terminalIdSchema, data: z.string().max(131_072) }),
  z.object({ type: z.literal('exit'), id: terminalIdSchema, exitCode: z.number().int(), signal: z.number().int().optional() }),
]);
export const appSettingsSchema = z.object({
  appearance: z.enum(['dark', 'system']),
  defaultModel: z.string().max(500).nullable(),
  thinkingLevel: thinkingLevelSchema,
  confirmRiskyCommands: z.boolean(),
  terminalShell: z.string().max(4_096).nullable(),
  reduceMotion: z.boolean(),
}).strict();
export const diagnosticsSchema = z.object({
  appVersion: z.string(), electronVersion: z.string(), nodeVersion: z.string(), chromeVersion: z.string(),
  piVersion: z.string(), platform: z.string(), arch: z.string(), agentDirectory: z.string(), projectPath: z.string().nullable(),
  runtimeStatus: z.string(), sessionId: z.string().nullable(), packaged: z.boolean(),
});
export const logEntrySchema = z.object({ timestamp: z.string().datetime(), level: z.enum(['info', 'warn', 'error']), scope: z.string(), message: z.string() });
export const logListSchema = z.array(logEntrySchema).max(500);
export const appCommandSchema = z.enum(['open-project', 'new-session', 'focus-composer', 'stop-generation', 'toggle-sidebar', 'toggle-inspector', 'open-settings', 'open-terminal', 'open-palette']);

export type AppInfo = z.infer<typeof appInfoSchema>;
export type AppError = z.infer<typeof appErrorSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export type ProjectState = z.infer<typeof projectStateSchema>;
export type RuntimeMessage = z.infer<typeof runtimeMessageSchema>;
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionBranch = z.infer<typeof sessionBranchSchema>;
export type PiEvent = z.infer<typeof piEventSchema>;
export type PromptInput = z.infer<typeof promptInputSchema>;
export type PromptAcceptance = z.infer<typeof promptAcceptanceSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type FileList = z.infer<typeof fileListSchema>;
export type FilePreview = z.infer<typeof filePreviewSchema>;
export type GitChange = z.infer<typeof gitChangeSchema>;
export type GitStatus = z.infer<typeof gitStatusSchema>;
export type GitDiff = z.infer<typeof gitDiffSchema>;
export type TerminalEvent = z.infer<typeof terminalEventSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type LogEntry = z.infer<typeof logEntrySchema>;
export type AppCommand = z.infer<typeof appCommandSchema>;

export interface PiDesktopApi {
  getAppInfo: () => Promise<AppInfo>;
  selectProject: () => Promise<RuntimeState>;
  selectProjectFile: () => Promise<string | null>;
  getRuntimeState: () => Promise<RuntimeState>;
  prompt: (input: PromptInput) => Promise<PromptAcceptance>;
  abort: () => Promise<{ aborted: boolean }>;
  setModel: (provider: string, id: string) => Promise<RuntimeState>;
  setThinkingLevel: (level: ThinkingLevel) => Promise<RuntimeState>;
  newSession: () => Promise<RuntimeState>;
  listSessions: (query?: string) => Promise<SessionSummary[]>;
  switchSession: (sessionId: string) => Promise<RuntimeState>;
  forkSession: (entryId: string) => Promise<RuntimeState>;
  cloneSession: () => Promise<RuntimeState>;
  importSession: () => Promise<RuntimeState | null>;
  compact: (instructions?: string) => Promise<RuntimeState>;
  listFiles: (path?: string) => Promise<FileList>;
  searchFiles: (query: string, limit?: number) => Promise<{ entries: FileEntry[]; truncated: boolean }>;
  readFile: (path: string) => Promise<FilePreview>;
  openFile: (path: string) => Promise<{ opened: boolean; error?: string | undefined }>;
  getGitStatus: () => Promise<GitStatus>;
  getGitDiff: (path: string) => Promise<GitDiff>;
  createTerminal: (cols: number, rows: number) => Promise<z.infer<typeof terminalCreateResultSchema>>;
  writeTerminal: (id: string, data: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (id: string) => Promise<void>;
  getSettings: () => Promise<AppSettings>;
  setSettings: (settings: AppSettings) => Promise<AppSettings>;
  getDiagnostics: () => Promise<Diagnostics>;
  getLogs: () => Promise<LogEntry[]>;
  onEvents: (listener: (events: PiEvent[]) => void) => () => void;
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => () => void;
  onAppCommand: (listener: (command: AppCommand) => void) => () => void;
}
