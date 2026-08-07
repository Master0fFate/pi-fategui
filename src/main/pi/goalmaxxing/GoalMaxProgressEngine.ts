import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { GoalMaxEvidence } from '../../../shared/contracts/goalmaxxing';

const execFileAsync = promisify(execFile);
const MAX_CHANGED_PATHS = 2_000;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const GIT_STATUS_TIMEOUT_MS = 15_000;
const STAT_CONCURRENCY = 32;

export interface WorkspaceSnapshot {
  fingerprint: string;
  changedFileCount: number;
  paths: string[];
  repository: boolean;
}

export class GoalMaxProgressEngine {
  async capture(projectPath: string): Promise<WorkspaceSnapshot> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        cwd: projectPath,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT,
        timeout: GIT_STATUS_TIMEOUT_MS,
        windowsHide: true,
      });
      const entries = parseGoalMaxPorcelain(stdout).slice(0, MAX_CHANGED_PATHS);
      const facts = await mapWithConcurrency(entries, STAT_CONCURRENCY, async ({ status, filePath }) => {
        try {
          const stat = await fs.lstat(path.resolve(projectPath, filePath));
          return `${status}\0${filePath}\0${stat.size}\0${Math.round(stat.mtimeMs)}\0${Math.round(stat.ctimeMs)}`;
        } catch {
          return `${status}\0${filePath}\0missing`;
        }
      });
      return {
        fingerprint: createHash('sha256').update(facts.join('\n')).digest('hex'),
        changedFileCount: entries.length,
        paths: entries.map((entry) => entry.filePath),
        repository: true,
      };
    } catch {
      return {
        fingerprint: createHash('sha256').update(`no-git\0${path.resolve(projectPath)}`).digest('hex'),
        changedFileCount: 0,
        paths: [],
        repository: false,
      };
    }
  }
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, visit: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await visit(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export function parseGoalMaxPorcelain(output: string): Array<{ status: string; filePath: string }> {
  const fields = output.split('\0').filter(Boolean);
  const entries: Array<{ status: string; filePath: string }> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    let filePath = field.slice(3);
    // In -z mode Git reverses rename fields: the current path comes first and
    // the original path follows as a second NUL-delimited field.
    if ((status[0] === 'R' || status[0] === 'C') && fields[index + 1]) index += 1;
    const normalized = filePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
    if (!normalized || normalized.split('/').includes('..') || path.isAbsolute(normalized)) continue;
    entries.push({ status, filePath: normalized });
  }
  return entries;
}

export interface ToolObservation {
  kind: GoalMaxEvidence['kind'];
  title: string;
  summary: string;
  command?: string;
  path?: string;
  exitCode?: number;
  output?: string;
  meaningful: boolean;
  investigation: boolean;
  verification: boolean;
  failureFingerprint: string | null;
}

export function classifyGoalMaxTool(name: string, input: string, output: string, error: boolean): ToolObservation | null {
  const normalizedName = name.toLocaleLowerCase();
  if (normalizedName === 'goalmax_status' || normalizedName === 'goalmax_report' || normalizedName === 'goalmax_complete') return null;
  const parsed = safeObject(input);
  const command = typeof parsed?.command === 'string' ? parsed.command.trim() : undefined;
  const filePath = typeof parsed?.path === 'string' ? parsed.path.replace(/\\/gu, '/').slice(0, 4_096) : undefined;
  const failureFingerprint = error
    ? createHash('sha256').update(`${normalizedName}\0${input}\0${output.slice(-2_000)}`).digest('hex')
    : null;
  if (normalizedName === 'write' || normalizedName === 'edit') {
    return {
      kind: 'file',
      title: `${error ? 'Failed' : 'Changed'} ${filePath ?? 'project file'}`,
      summary: output.slice(-8_000),
      ...(filePath ? { path: filePath } : {}),
      ...(error ? { exitCode: 1 } : { exitCode: 0 }),
      meaningful: !error,
      investigation: false,
      verification: false,
      failureFingerprint,
    };
  }
  if (normalizedName === 'bash' && command) {
    const kind = commandKind(command);
    const verification = !error && (kind === 'test' || kind === 'build' || kind === 'lint');
    return {
      kind,
      title: `${error ? 'Failed' : 'Passed'} ${commandTitle(command, kind)}`,
      summary: output.slice(-8_000),
      command: command.slice(0, 8_000),
      exitCode: error ? 1 : 0,
      output: output.slice(-8_000),
      meaningful: verification,
      investigation: !error && kind === 'command' && readOnlyInvestigationCommand(command),
      verification,
      failureFingerprint,
    };
  }
  if (['read', 'grep', 'find', 'ls'].includes(normalizedName)) {
    const subject = filePath ?? investigationSubject(parsed) ?? 'project state';
    return {
      kind: 'runtime',
      title: `${error ? 'Failed to inspect' : 'Inspected'} ${subject}`,
      summary: output.slice(-8_000),
      ...(filePath ? { path: filePath } : {}),
      exitCode: error ? 1 : 0,
      meaningful: false,
      investigation: !error,
      verification: false,
      failureFingerprint,
    };
  }
  if (normalizedName === 'generate_image') {
    return {
      kind: 'screenshot', title: error ? 'Image generation failed' : 'Generated visual evidence', summary: output.slice(-8_000),
      ...(error ? { exitCode: 1 } : { exitCode: 0 }), meaningful: !error, investigation: false, verification: false, failureFingerprint,
    };
  }
  return error ? {
    kind: 'runtime', title: `${name} failed`, summary: output.slice(-8_000), exitCode: 1,
    meaningful: false, investigation: false, verification: false, failureFingerprint,
  } : null;
}

function commandKind(command: string): ToolObservation['kind'] {
  const normalized = command.toLocaleLowerCase();
  if (/(?:^|[\s;&|])(?:pnpm|npm|yarn|bun|npx)?\s*(?:(?:run|exec)\s+)?(?:test(?:[:\w-]*)?|vitest|jest|playwright|pytest|go\s+test|cargo\s+test)(?:\s|$)/u.test(normalized)) return 'test';
  if (/(?:^|[\s;&|])(?:pnpm|npm|yarn|bun)?\s*(?:(?:run|exec)\s+)?(?:build(?:[:\w-]*)?|package|dist)(?:\s|$)|\b(?:vite\s+build|cargo\s+build|go\s+build)\b/u.test(normalized)) return 'build';
  if (/(?:^|[\s;&|])(?:pnpm|npm|yarn|bun|npx)?\s*(?:(?:run|exec)\s+)?(?:lint(?:[:\w-]*)?|typecheck(?:[:\w-]*)?|tsc)(?:\s|$)|\b(?:eslint|ruff|mypy)\b/u.test(normalized)) return 'lint';
  return 'command';
}

function commandTitle(command: string, kind: ToolObservation['kind']): string {
  const label = kind === 'test' ? 'tests' : kind === 'build' ? 'build' : kind === 'lint' ? 'validation' : 'command';
  const compact = command.replace(/\s+/gu, ' ').trim();
  return `${label}: ${compact.length <= 120 ? compact : `${compact.slice(0, 117).trimEnd()}…`}`;
}

function readOnlyInvestigationCommand(command: string): boolean {
  const segments = command.toLocaleLowerCase().split(/(?:&&|\|\||\||;|\r?\n)/u).map((part) => part.trim()).filter(Boolean);
  return segments.length > 0 && segments.every((segment) => /^(?:git\s+(?:status|diff|show|log|grep|ls-files)\b|rg\b|grep\b|find\b|ls\b|pwd\b|wc\b|head\b|tail\b|type\s+[^>]+$)/u.test(segment));
}

function investigationSubject(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  for (const key of ['query', 'pattern', 'glob']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/gu, ' ').slice(0, 160);
  }
  return null;
}

function safeObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
