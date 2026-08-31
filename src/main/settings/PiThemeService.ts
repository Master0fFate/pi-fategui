import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  getPackageDir,
} from '@earendil-works/pi-coding-agent';
import { themeDefinitionSchema, type ThemeDefinition } from '../../shared/themes';

export const MAX_PI_THEME_FILE_BYTES = 256 * 1024;
export const MAX_PI_THEME_CANDIDATES = 128;
export const MAX_PI_THEME_RESULTS = 96;
export const MAX_PI_THEME_DIAGNOSTICS = 32;
export const DEFAULT_PI_THEME_CACHE_TTL_MS = 2_000;

const MAX_CACHE_TTL_MS = 10_000;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 512;
const MAX_DIAGNOSTIC_PATH_LENGTH = 1_024;
const MAX_VARIABLE_DEPTH = 64;

export const PI_THEME_REQUIRED_COLOR_KEYS = [
  'accent', 'border', 'borderAccent', 'borderMuted', 'success', 'error', 'warning', 'muted', 'dim', 'text', 'thinkingText',
  'selectedBg', 'userMessageBg', 'userMessageText', 'customMessageBg', 'customMessageText', 'customMessageLabel',
  'toolPendingBg', 'toolSuccessBg', 'toolErrorBg', 'toolTitle', 'toolOutput',
  'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock', 'mdCodeBlockBorder', 'mdQuote', 'mdQuoteBorder', 'mdHr', 'mdListBullet',
  'toolDiffAdded', 'toolDiffRemoved', 'toolDiffContext',
  'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable', 'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator', 'syntaxPunctuation',
  'thinkingOff', 'thinkingMinimal', 'thinkingLow', 'thinkingMedium', 'thinkingHigh', 'thinkingXhigh', 'bashMode',
] as const;

export type PiThemeColorValue = string | number;

export interface PiThemeJson {
  readonly name: string;
  readonly vars?: Readonly<Record<string, PiThemeColorValue>>;
  readonly colors: Readonly<Record<string, PiThemeColorValue>>;
  readonly export?: Readonly<{
    pageBg?: PiThemeColorValue;
    cardBg?: PiThemeColorValue;
    infoBg?: PiThemeColorValue;
  }>;
}

export interface PiThemeDiagnostic {
  readonly type: 'warning' | 'error';
  readonly message: string;
  readonly path?: string;
}

export interface PiThemeDiscoveryRequest {
  /** The project directory whose .pi settings/resources Pi should resolve. */
  readonly cwd: string;
  /** Must be the explicit Fate UI trust decision; omitted/implicit trust is rejected. */
  readonly projectTrusted: boolean;
}

export interface PiThemeDiscoveryResult {
  readonly themes: ThemeDefinition[];
  readonly diagnostics: PiThemeDiagnostic[];
}

interface ResolvedThemeCandidate {
  readonly path: string;
  readonly enabled: boolean;
  readonly metadata: { readonly scope: string };
}

interface PackageThemeResolver {
  resolve(onMissing?: (source: string) => Promise<'install' | 'skip' | 'error'>): Promise<{
    readonly themes: readonly ResolvedThemeCandidate[];
  }>;
}

export interface PiThemeServiceOptions {
  readonly agentDir?: string;
  readonly packageDir?: string;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
  readonly settingsManagerFactory?: (
    cwd: string,
    agentDir: string,
    projectTrusted: boolean,
  ) => SettingsManager;
  readonly packageManagerFactory?: (options: {
    cwd: string;
    agentDir: string;
    settingsManager: SettingsManager;
  }) => PackageThemeResolver;
}

export interface PiThemeMappingOptions {
  readonly sourceIdentity?: string;
  readonly tone?: ThemeDefinition['tone'];
}

interface ThemeCandidate {
  readonly path: string;
  readonly identity: string;
}

class DiagnosticCollector {
  readonly values: PiThemeDiagnostic[] = [];
  private truncated = false;

  add(type: PiThemeDiagnostic['type'], message: string, candidatePath?: string): void {
    if (this.truncated) return;
    if (this.values.length >= MAX_PI_THEME_DIAGNOSTICS - 1) {
      this.truncated = true;
      this.values.push({ type: 'warning', message: 'Additional Pi theme diagnostics were omitted.' });
      return;
    }
    const boundedMessage = message.replace(/\s+/gu, ' ').trim().slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH)
      || 'Pi theme discovery failed.';
    if (candidatePath) {
      this.values.push({
        type,
        message: boundedMessage,
        path: candidatePath.slice(-MAX_DIAGNOSTIC_PATH_LENGTH),
      });
    } else {
      this.values.push({ type, message: boundedMessage });
    }
  }
}

const ANSI_BASIC_COLORS = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertColorValue(value: unknown, label: string): asserts value is PiThemeColorValue {
  if (typeof value === 'string') return;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255) return;
  throw new Error(`${label} must be a string or an ANSI color index from 0 to 255.`);
}

function resolveColorValue(
  value: PiThemeColorValue,
  vars: Readonly<Record<string, PiThemeColorValue>>,
  visited: Set<string>,
  depth: number,
): PiThemeColorValue {
  assertColorValue(value, 'Color');
  if (typeof value === 'number' || value === '') return value;
  if (value.startsWith('#')) {
    if (!/^#[0-9a-fA-F]{6}$/u.test(value)) throw new Error(`Invalid six-digit hex color: ${value.slice(0, 32)}`);
    return value.toLowerCase();
  }
  if (depth >= MAX_VARIABLE_DEPTH) throw new Error('Pi theme variable references are too deeply nested.');
  if (visited.has(value)) throw new Error(`Circular Pi theme variable reference: ${value.slice(0, 64)}`);
  if (!Object.hasOwn(vars, value)) throw new Error(`Unknown Pi theme variable: ${value.slice(0, 64)}`);
  const referenced = vars[value];
  assertColorValue(referenced, `Variable ${value.slice(0, 64)}`);
  visited.add(value);
  try {
    return resolveColorValue(referenced, vars, visited, depth + 1);
  } finally {
    visited.delete(value);
  }
}

/** Resolve a Pi variable reference while preserving ANSI indices and empty terminal-default values. */
export function resolvePiColorValue(
  value: PiThemeColorValue,
  vars: Readonly<Record<string, PiThemeColorValue>> = {},
): PiThemeColorValue {
  return resolveColorValue(value, vars, new Set(), 0);
}

/** Convert Pi's ANSI 0-255 palette to the same deterministic RGB approximations Pi uses for HTML. */
export function ansi256ToHex(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new Error('ANSI color index must be an integer from 0 to 255.');
  }
  if (index < 16) return ANSI_BASIC_COLORS[index]!;
  if (index < 232) {
    const cubeIndex = index - 16;
    const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40).toString(16).padStart(2, '0');
    return `#${channel(Math.floor(cubeIndex / 36))}${channel(Math.floor((cubeIndex % 36) / 6))}${channel(cubeIndex % 6)}`;
  }
  const gray = (8 + (index - 232) * 10).toString(16).padStart(2, '0');
  return `#${gray}${gray}${gray}`;
}

/** Resolve and convert any Pi color value to a Fate-compatible six-digit hex color. */
export function piColorToHex(
  value: PiThemeColorValue,
  vars: Readonly<Record<string, PiThemeColorValue>> = {},
  emptyFallback = '#000000',
): string {
  if (!/^#[0-9a-fA-F]{6}$/u.test(emptyFallback)) throw new Error('Empty-color fallback must be a six-digit hex color.');
  const resolved = resolvePiColorValue(value, vars);
  if (typeof resolved === 'number') return ansi256ToHex(resolved);
  return resolved === '' ? emptyFallback.toLowerCase() : resolved;
}

/** Validate the public JSON theme format without invoking Pi's unbounded synchronous file loader. */
export function validatePiThemeJson(input: unknown): PiThemeJson {
  if (!isRecord(input)) throw new Error('Pi theme must be a JSON object.');
  if (typeof input.name !== 'string' || input.name.trim() === '') throw new Error('Pi theme name is required.');
  if (input.name.includes('/')) throw new Error('Pi theme name cannot contain "/".');
  if (input.$schema !== undefined && typeof input.$schema !== 'string') throw new Error('Pi theme $schema must be a string.');
  if (!isRecord(input.colors)) throw new Error('Pi theme colors must be an object.');

  let vars: Record<string, PiThemeColorValue> | undefined;
  if (input.vars !== undefined) {
    if (!isRecord(input.vars)) throw new Error('Pi theme vars must be an object.');
    vars = Object.create(null) as Record<string, PiThemeColorValue>;
    for (const [name, value] of Object.entries(input.vars)) {
      assertColorValue(value, `Variable ${name.slice(0, 64)}`);
      vars[name] = value;
    }
  }

  const colors = Object.create(null) as Record<string, PiThemeColorValue>;
  for (const key of PI_THEME_REQUIRED_COLOR_KEYS) {
    if (!Object.hasOwn(input.colors, key)) throw new Error(`Pi theme is missing required color: ${key}`);
    const value = input.colors[key];
    assertColorValue(value, `Color ${key}`);
    colors[key] = value;
  }
  if (Object.hasOwn(input.colors, 'thinkingMax')) {
    const value = input.colors.thinkingMax;
    assertColorValue(value, 'Color thinkingMax');
    colors.thinkingMax = value;
  }

  const resolvedVars = vars ?? {};
  for (const [key, value] of Object.entries(colors)) {
    try {
      resolvePiColorValue(value, resolvedVars);
    } catch (error) {
      throw new Error(`Invalid Pi theme color ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let exportColors: { pageBg?: PiThemeColorValue; cardBg?: PiThemeColorValue; infoBg?: PiThemeColorValue } | undefined;
  if (input.export !== undefined) {
    if (!isRecord(input.export)) throw new Error('Pi theme export must be an object.');
    exportColors = {};
    for (const key of ['pageBg', 'cardBg', 'infoBg'] as const) {
      if (!Object.hasOwn(input.export, key)) continue;
      const value = input.export[key];
      assertColorValue(value, `Export color ${key}`);
      resolvePiColorValue(value, resolvedVars);
      exportColors[key] = value;
    }
  }

  return {
    name: input.name,
    colors,
    ...(vars ? { vars } : {}),
    ...(exportColors ? { export: exportColors } : {}),
  };
}

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function mix(first: string, second: string, secondWeight: number): string {
  const a = rgb(first);
  const b = rgb(second);
  const channel = (index: 0 | 1 | 2) => Math.round(a[index] * (1 - secondWeight) + b[index] * secondWeight)
    .toString(16).padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function optionalHex(value: PiThemeColorValue | undefined, vars: Readonly<Record<string, PiThemeColorValue>>): string | undefined {
  if (value === undefined) return undefined;
  const resolved = resolvePiColorValue(value, vars);
  if (resolved === '') return undefined;
  return typeof resolved === 'number' ? ansi256ToHex(resolved) : resolved;
}

function inferValidatedTone(theme: PiThemeJson): ThemeDefinition['tone'] {
  const vars = theme.vars ?? {};
  const pageBackground = optionalHex(theme.export?.pageBg, vars);
  if (pageBackground) return luminance(pageBackground) >= 0.5 ? 'light' : 'dark';

  const backgrounds = [
    theme.colors.userMessageBg,
    theme.colors.customMessageBg,
    theme.colors.toolPendingBg,
    theme.colors.selectedBg,
  ].map((value) => optionalHex(value, vars)).filter((value): value is string => value !== undefined);
  if (backgrounds.length > 0) {
    const average = backgrounds.reduce((total, color) => total + luminance(color), 0) / backgrounds.length;
    return average >= 0.5 ? 'light' : 'dark';
  }

  if (/(?:^|[\s_-])(?:light|day|latte)(?:$|[\s_-])/iu.test(theme.name)) return 'light';
  const text = optionalHex(theme.colors.text, vars) ?? optionalHex(theme.colors.userMessageText, vars);
  if (text) return luminance(text) >= 0.5 ? 'dark' : 'light';
  return 'dark';
}

/** Infer Fate's tone from resolved Pi backgrounds, then name/text fallbacks. */
export function inferPiThemeTone(input: unknown): ThemeDefinition['tone'] {
  return inferValidatedTone(validatePiThemeJson(input));
}

function truncateCodeUnits(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let result = '';
  for (const character of value) {
    if (result.length + character.length > maximum - 1) break;
    result += character;
  }
  return `${result}…`;
}

/** Build a deterministic Fate-safe ID without depending on an installation-specific Pi package path. */
export function createPiThemeId(name: string, _sourceIdentity = ''): string {
  const slug = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'theme';
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 12);
  return `pi-${slug.slice(0, 32).replace(/-+$/u, '') || 'theme'}-${hash}`;
}

/** Map a validated Pi theme into Fate's complete 18-token theme contract. */
export function mapPiThemeToFateTheme(
  input: unknown,
  options: PiThemeMappingOptions | string = {},
): ThemeDefinition {
  const theme = validatePiThemeJson(input);
  const mappingOptions: PiThemeMappingOptions = typeof options === 'string' ? { sourceIdentity: options } : options;
  const tone = mappingOptions.tone ?? inferValidatedTone(theme);
  const vars = theme.vars ?? {};
  const defaultCanvas = tone === 'dark' ? '#101218' : '#f5f7fb';
  const defaultText = tone === 'dark' ? '#f0f2f7' : '#171b26';
  const edge = tone === 'dark' ? '#000000' : '#ffffff';
  const fromColor = (key: string, fallback: string) => optionalHex(theme.colors[key], vars) ?? fallback;

  const pageBackground = optionalHex(theme.export?.pageBg, vars);
  const cardBackground = optionalHex(theme.export?.cardBg, vars);
  const panelSeed = cardBackground
    ?? optionalHex(theme.colors.userMessageBg, vars)
    ?? optionalHex(theme.colors.customMessageBg, vars)
    ?? optionalHex(theme.colors.toolPendingBg, vars);
  const canvas = pageBackground ?? (panelSeed ? mix(panelSeed, edge, 0.25) : defaultCanvas);
  const text = optionalHex(theme.colors.text, vars) ?? defaultText;
  const panel = cardBackground ?? panelSeed ?? mix(canvas, text, tone === 'dark' ? 0.05 : 0.03);
  const raised = optionalHex(theme.colors.customMessageBg, vars)
    ?? optionalHex(theme.colors.toolPendingBg, vars)
    ?? mix(panel, text, 0.06);
  const selected = optionalHex(theme.colors.selectedBg, vars);
  const accent = fromColor('accent', tone === 'dark' ? '#7c6cff' : '#5f50d8');
  const border = fromColor('border', mix(panel, text, 0.18));
  const muted = fromColor('muted', mix(text, canvas, 0.42));

  const normalizedName = theme.name.replace(/\s+/gu, ' ').trim();
  const identity = mappingOptions.sourceIdentity ?? normalizedName;
  const definition = {
    id: createPiThemeId(normalizedName, identity),
    name: truncateCodeUnits(`Pi · ${normalizedName}`, 48),
    tone,
    colors: {
      canvas,
      panel,
      raised,
      raisedHover: selected ?? mix(raised, text, 0.1),
      border,
      borderStrong: fromColor('borderAccent', mix(border, text, 0.22)),
      text,
      textSoft: fromColor('thinkingText', fromColor('userMessageText', mix(text, canvas, 0.16))),
      muted,
      subtle: fromColor('dim', mix(muted, canvas, 0.3)),
      accent,
      accentHover: fromColor('borderAccent', mix(accent, tone === 'dark' ? '#ffffff' : '#000000', 0.15)),
      accentSoft: selected ?? mix(canvas, accent, 0.18),
      currentSession: selected ?? mix(raised, accent, 0.17),
      lastActiveSession: raised,
      onAccent: luminance(accent) > 0.179 ? '#000000' : '#ffffff',
      success: fromColor('success', '#55c78a'),
      warning: fromColor('warning', '#d2a94b'),
      danger: fromColor('error', '#e35d6a'),
      shadow: tone === 'dark' ? '#000000' : mix(canvas, '#000000', 0.45),
    },
  };
  return themeDefinitionSchema.parse(definition);
}

async function readBoundedFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Theme candidate is not a regular file.');
    if (stat.size > MAX_PI_THEME_FILE_BYTES) throw new Error(`Theme candidate exceeds ${MAX_PI_THEME_FILE_BYTES} bytes.`);

    const buffer = Buffer.allocUnsafe(MAX_PI_THEME_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PI_THEME_FILE_BYTES) throw new Error(`Theme candidate exceeds ${MAX_PI_THEME_FILE_BYTES} bytes.`);
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

function shortError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function cloneResult(result: PiThemeDiscoveryResult): PiThemeDiscoveryResult {
  return {
    themes: result.themes.map((theme) => ({ ...theme, colors: { ...theme.colors } })),
    diagnostics: result.diagnostics.map((diagnostic) => (
      diagnostic.path
        ? { type: diagnostic.type, message: diagnostic.message, path: diagnostic.path }
        : { type: diagnostic.type, message: diagnostic.message }
    )),
  };
}

function normalizedPathKey(candidatePath: string): string {
  const normalized = path.normalize(path.resolve(candidatePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export class PiThemeService {
  private readonly agentDir: string;
  private readonly packageDir: string;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly settingsManagerFactory: NonNullable<PiThemeServiceOptions['settingsManagerFactory']>;
  private readonly packageManagerFactory: NonNullable<PiThemeServiceOptions['packageManagerFactory']>;
  private cache: { key: string; expiresAt: number; result: PiThemeDiscoveryResult } | undefined;
  private readonly inFlight = new Map<string, Promise<PiThemeDiscoveryResult>>();

  constructor(options: PiThemeServiceOptions = {}) {
    this.agentDir = path.resolve(options.agentDir ?? getAgentDir());
    this.packageDir = path.resolve(options.packageDir ?? getPackageDir());
    const requestedTtl = options.cacheTtlMs ?? DEFAULT_PI_THEME_CACHE_TTL_MS;
    this.cacheTtlMs = Number.isFinite(requestedTtl) ? Math.max(0, Math.min(MAX_CACHE_TTL_MS, requestedTtl)) : DEFAULT_PI_THEME_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.settingsManagerFactory = options.settingsManagerFactory
      ?? ((cwd, agentDir, projectTrusted) => SettingsManager.create(cwd, agentDir, { projectTrusted }));
    this.packageManagerFactory = options.packageManagerFactory
      ?? ((managerOptions) => new DefaultPackageManager(managerOptions));
  }

  /** Discover mapped themes plus bounded, non-fatal diagnostics. */
  discover(request: PiThemeDiscoveryRequest): Promise<PiThemeDiscoveryResult> {
    if (!request || typeof request.cwd !== 'string' || request.cwd.trim() === '') {
      return Promise.reject(new Error('Pi theme discovery requires a project cwd.'));
    }
    if (typeof request.projectTrusted !== 'boolean') {
      return Promise.reject(new Error('Pi theme discovery requires an explicit projectTrusted decision.'));
    }

    const cwd = path.resolve(request.cwd);
    const key = `${normalizedPathKey(cwd)}\0${request.projectTrusted ? 'trusted' : 'untrusted'}`;
    const cached = this.cache;
    if (cached?.key === key && cached.expiresAt > this.now()) return Promise.resolve(cloneResult(cached.result));

    const running = this.inFlight.get(key);
    if (running) return running.then(cloneResult);

    const discovery = this.discoverFresh(cwd, request.projectTrusted).then((result) => {
      this.cache = { key, expiresAt: this.now() + this.cacheTtlMs, result: cloneResult(result) };
      return result;
    }).finally(() => {
      if (this.inFlight.get(key) === discovery) this.inFlight.delete(key);
    });
    this.inFlight.set(key, discovery);
    return discovery.then(cloneResult);
  }

  /** SettingsService-friendly projection when diagnostics are logged separately. */
  loadThemes(request: PiThemeDiscoveryRequest): Promise<ThemeDefinition[]> {
    return this.discover(request).then((result) => result.themes);
  }

  clearCache(): void {
    this.cache = undefined;
  }

  private async discoverFresh(cwd: string, projectTrusted: boolean): Promise<PiThemeDiscoveryResult> {
    const diagnostics = new DiagnosticCollector();
    const candidates: ThemeCandidate[] = [];
    const seenPaths = new Set<string>();
    let candidateLimitReached = false;
    const addCandidate = (candidate: ThemeCandidate): void => {
      let candidateKey: string;
      try {
        candidateKey = normalizedPathKey(candidate.path);
      } catch (error) {
        diagnostics.add('warning', `Pi theme path was skipped: ${shortError(error, 'invalid path')}`);
        return;
      }
      if (seenPaths.has(candidateKey)) return;
      if (candidates.length >= MAX_PI_THEME_CANDIDATES) {
        candidateLimitReached = true;
        return;
      }
      seenPaths.add(candidateKey);
      candidates.push(candidate);
    };
    for (const candidate of await this.builtinCandidates(diagnostics)) addCandidate(candidate);

    try {
      const settingsManager = this.settingsManagerFactory(cwd, this.agentDir, projectTrusted);
      for (const settingError of settingsManager.drainErrors()) {
        diagnostics.add('warning', `Pi ${settingError.scope} settings were ignored: ${shortError(settingError.error, 'invalid settings')}`);
      }
      const packageManager = this.packageManagerFactory({ cwd, agentDir: this.agentDir, settingsManager });
      const resolved = await packageManager.resolve(async (source) => {
        diagnostics.add('warning', `Pi package is unavailable and was not installed: ${source}`);
        return 'skip';
      });
      for (const resource of resolved.themes) {
        if (!resource.enabled) continue;
        // Defense in depth for injected/adapted resolvers: project resources never cross an untrusted request.
        if (!projectTrusted && resource.metadata.scope === 'project') continue;
        let identity: string;
        try {
          identity = `file:${normalizedPathKey(resource.path)}`;
        } catch (error) {
          diagnostics.add('warning', `Pi theme path was skipped: ${shortError(error, 'invalid path')}`);
          continue;
        }
        addCandidate({ path: resource.path, identity });
        if (candidateLimitReached) break;
      }
      for (const settingError of settingsManager.drainErrors()) {
        diagnostics.add('warning', `Pi ${settingError.scope} settings were ignored: ${shortError(settingError.error, 'invalid settings')}`);
      }
    } catch (error) {
      diagnostics.add('error', `Pi theme paths could not be resolved: ${shortError(error, 'resolution failed')}`);
    }

    if (candidateLimitReached) {
      diagnostics.add('warning', `Pi theme candidate limit reached; only the first ${MAX_PI_THEME_CANDIDATES} candidates were inspected.`);
    }

    const themes: ThemeDefinition[] = [];
    const seenNames = new Set<string>();
    const seenIds = new Set<string>();
    for (let index = 0; index < candidates.length; index += 1) {
      if (themes.length >= MAX_PI_THEME_RESULTS) {
        diagnostics.add('warning', `Pi theme result limit reached; only the first ${MAX_PI_THEME_RESULTS} valid themes were returned.`);
        break;
      }
      const candidate = candidates[index]!;
      if (!candidate.path.endsWith('.json')) {
        diagnostics.add('warning', 'Pi theme candidate is not a .json file.', candidate.path);
        continue;
      }
      try {
        const input: unknown = JSON.parse(await readBoundedFile(candidate.path));
        const parsed = validatePiThemeJson(input);
        if (seenNames.has(parsed.name)) {
          diagnostics.add('warning', `Duplicate Pi theme name was skipped: ${parsed.name}`, candidate.path);
          continue;
        }
        const mapped = mapPiThemeToFateTheme(parsed, { sourceIdentity: candidate.identity });
        if (seenIds.has(mapped.id)) {
          diagnostics.add('warning', `Pi theme ID collision was skipped: ${mapped.id}`, candidate.path);
          continue;
        }
        seenNames.add(parsed.name);
        seenIds.add(mapped.id);
        themes.push(mapped);
      } catch (error) {
        diagnostics.add('warning', `Pi theme was skipped: ${shortError(error, 'invalid theme')}`, candidate.path);
      }
    }

    themes.sort((first, second) => first.name.localeCompare(second.name, 'en'));
    return { themes, diagnostics: diagnostics.values };
  }

  private async builtinCandidates(diagnostics: DiagnosticCollector): Promise<ThemeCandidate[]> {
    const result: ThemeCandidate[] = [];
    for (const name of ['dark', 'light'] as const) {
      const possiblePaths = [
        path.join(this.packageDir, 'theme', `${name}.json`),
        path.join(this.packageDir, 'dist', 'modes', 'interactive', 'theme', `${name}.json`),
        path.join(this.packageDir, 'src', 'modes', 'interactive', 'theme', `${name}.json`),
        path.join(this.packageDir, 'modes', 'interactive', 'theme', `${name}.json`),
      ];
      let found: string | undefined;
      for (const possiblePath of possiblePaths) {
        try {
          const stat = await fs.stat(possiblePath);
          if (stat.isFile()) {
            found = possiblePath;
            break;
          }
        } catch {
          // Try the next public-package layout.
        }
      }
      if (found) result.push({ path: found, identity: `builtin:${name}` });
      else diagnostics.add('warning', `Bundled Pi theme could not be found: ${name}`);
    }
    return result;
  }
}
