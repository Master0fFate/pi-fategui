export const SUBAGENT_HANDLE_MAX_LENGTH = 64;
export const SUBAGENT_DISPLAY_NAME_MAX_LENGTH = 80;
export const SUBAGENT_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

interface IdentitySource {
  id?: string | undefined;
  role?: string | undefined;
  task?: string | undefined;
  handle?: string | undefined;
  displayName?: string | undefined;
}

interface AllocateIdentityOptions {
  preferredHandle?: string;
  numbered?: boolean;
}

export interface SubagentIdentity {
  handle: string;
  displayName: string;
}

const genericRoles = new Set(['agent', 'assistant', 'child', 'direct', 'subagent', 'worker']);
const functionalRoles = new Set(['auditor', 'implementer', 'planner', 'researcher', 'reviewer', 'runner', 'scout', 'tester', 'verifier']);
const abbreviations = new Map([
  ['api', 'API'], ['ci', 'CI'], ['cli', 'CLI'], ['css', 'CSS'], ['db', 'DB'], ['html', 'HTML'],
  ['ipc', 'IPC'], ['qa', 'QA'], ['sql', 'SQL'], ['ui', 'UI'], ['ux', 'UX'],
]);

const taskDomains: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:auth|authentication|authorization|login|oauth|session)\b/iu, 'Auth'],
  [/\b(?:security|secure|vulnerability|threat|permission)\b/iu, 'Security'],
  [/\b(?:architecture|architectural|boundary|data flow|system design)\b/iu, 'Architecture'],
  [/\b(?:performance|latency|throughput|memory|rendering)\b/iu, 'Performance'],
  [/\b(?:accessibility|a11y|wcag)\b/iu, 'Accessibility'],
  [/\b(?:database|schema|query|sql|storage)\b/iu, 'Data'],
  [/\b(?:frontend|interface|\bui\b|\bux\b|component|layout)\b/iu, 'UI'],
  [/\b(?:backend|server|endpoint|\bapi\b)\b/iu, 'API'],
  [/\b(?:test|tests|testing|spec|coverage|playwright|vitest)\b/iu, 'Test'],
  [/\b(?:documentation|docs|readme)\b/iu, 'Docs'],
];

function titleWord(word: string): string {
  const lower = word.toLocaleLowerCase();
  return abbreviations.get(lower) ?? `${lower.charAt(0).toLocaleUpperCase()}${lower.slice(1)}`;
}

function words(value: string): string[] {
  return value
    .normalize('NFKC')
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function title(value: string): string {
  return words(value).map(titleWord).join(' ');
}

function taskDomain(task: string): string | undefined {
  return taskDomains.find(([pattern]) => pattern.test(task))?.[1];
}

function functionalRole(role: string, task: string): string {
  if (!genericRoles.has(role)) return title(role);
  if (/\b(?:test|tests|testing|spec|coverage|playwright|vitest)\b/iu.test(task)) return 'Test Runner';
  if (/\b(?:review|audit|verify|critique|check)\b/iu.test(task)) return 'Reviewer';
  if (/\b(?:implement|build|create|code|fix|refactor|migrate)\b/iu.test(task)) return 'Implementer';
  if (/\b(?:plan|design|roadmap|decompose)\b/iu.test(task)) return 'Planner';
  if (/\b(?:research|inspect|investigate|map|analy[sz]e|trace|explore)\b/iu.test(task)) return 'Scout';
  return 'Agent';
}

export function sanitizeSubagentDisplayName(value: string): string | null {
  const clean = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!clean) return null;
  return Array.from(clean).slice(0, SUBAGENT_DISPLAY_NAME_MAX_LENGTH).join('').trim() || null;
}

export function deriveSubagentDisplayName(role = 'agent', task = ''): string {
  const normalizedRole = role.trim().toLocaleLowerCase() || 'agent';
  const roleLabel = functionalRole(normalizedRole, task);
  const domain = taskDomain(task);
  if (!domain || roleLabel.toLocaleLowerCase().includes(domain.toLocaleLowerCase())) return roleLabel;
  if (roleLabel === 'Agent') return `${domain} Agent`;
  if (roleLabel === 'Test Runner' && domain === 'Test') return roleLabel;
  return `${domain} ${roleLabel}`;
}

export function subagentHandleBase(value: string, fallback = 'agent'): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/([a-z\d])([A-Z])/gu, '$1-$2')
    .toLocaleLowerCase()
    .replace(/&/gu, '-and-')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
  const bounded = slug.slice(0, SUBAGENT_HANDLE_MAX_LENGTH - 8).replace(/-+$/u, '');
  return bounded || fallback;
}

export function normalizeSubagentHandle(value: string): string | null {
  const normalized = value.trim().replace(/^@/u, '').toLocaleLowerCase();
  return normalized.length <= SUBAGENT_HANDLE_MAX_LENGTH && SUBAGENT_HANDLE_PATTERN.test(normalized) ? normalized : null;
}

function uniqueHandle(base: string, usedHandles: ReadonlySet<string>, numbered: boolean): { handle: string; ordinal: number } {
  if (!numbered && !usedHandles.has(base)) return { handle: base, ordinal: 1 };
  for (let ordinal = 1; ordinal < Number.MAX_SAFE_INTEGER; ordinal += 1) {
    const suffix = `-${ordinal}`;
    const candidate = `${base.slice(0, SUBAGENT_HANDLE_MAX_LENGTH - suffix.length).replace(/-+$/u, '')}${suffix}`;
    if (!usedHandles.has(candidate)) return { handle: candidate, ordinal };
  }
  throw new Error('Could not allocate a unique subagent handle.');
}

export function allocateSubagentIdentity(
  source: Pick<IdentitySource, 'role' | 'task' | 'displayName'>,
  usedHandles: ReadonlySet<string>,
  { preferredHandle, numbered = true }: AllocateIdentityOptions = {},
): SubagentIdentity {
  const baseDisplayName = sanitizeSubagentDisplayName(source.displayName ?? '')
    ?? deriveSubagentDisplayName(source.role, source.task);
  const baseHandle = subagentHandleBase(preferredHandle ?? baseDisplayName);
  const { handle, ordinal } = uniqueHandle(baseHandle, usedHandles, numbered);
  const displayName = ordinal > 1 && !numbered
    ? sanitizeSubagentDisplayName(`${baseDisplayName} ${ordinal}`) ?? baseDisplayName
    : baseDisplayName;
  return { handle, displayName };
}

export function ensureSubagentIdentity(source: IdentitySource, usedHandles: ReadonlySet<string>): SubagentIdentity {
  const existingHandle = source.handle ? normalizeSubagentHandle(source.handle) : null;
  const displayName = sanitizeSubagentDisplayName(source.displayName ?? '')
    ?? deriveSubagentDisplayName(source.role, source.task);
  if (existingHandle && !usedHandles.has(existingHandle)) return { handle: existingHandle, displayName };
  return allocateSubagentIdentity({ ...source, displayName }, usedHandles);
}

function stableShortId(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(-6);
}

export function subagentDisplayName(source: IdentitySource): string {
  return sanitizeSubagentDisplayName(source.displayName ?? '')
    ?? deriveSubagentDisplayName(source.role, source.task);
}

export function subagentHandle(source: IdentitySource): string {
  const stored = source.handle ? normalizeSubagentHandle(source.handle) : null;
  if (stored) return stored;
  const base = subagentHandleBase(subagentDisplayName(source));
  return `${base.slice(0, SUBAGENT_HANDLE_MAX_LENGTH - 7)}-${stableShortId(source.id ?? `${source.role}\0${source.task}`)}`;
}
