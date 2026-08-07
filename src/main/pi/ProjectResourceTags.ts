import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_TAGGED_FILES = 500;
const MAX_TAGGED_VISITED_ENTRIES = 2_000;
const MAX_TAGGED_DEPTH = 64;
const MAX_TAGGED_CONTEXT_CHARACTERS = 48_000;
const SCAN_YIELD_INTERVAL = 128;
const ignoredDirectories = new Set(['.git', 'node_modules']);

interface ScanBudget {
  visited: number;
  truncated: boolean;
}

interface PendingPath {
  relative: string;
  depth: number;
}

function taggedPaths(text: string): string[] {
  const matches = text.matchAll(/(?:^|\s)#(?:"((?:\\.|[^"\\])*)"|([^\s#]+))/gu);
  const paths = new Set<string>();
  for (const match of matches) {
    const value = match[1] === undefined
      ? match[2] ?? ''
      : match[1].replace(/\\(["\\])/gu, '$1');
    if (value) paths.add(value);
  }
  return [...paths];
}

function relativePath(value: string): string | null {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value) || value.includes('\\') || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^[/\\]{2}/u.test(value)) return null;
  const segments = value.split('/');
  return segments.some((segment) => !segment || segment === '.' || segment === '..') ? null : value;
}

function confined(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function yieldToMainLoop(budget: ScanBudget): Promise<void> {
  if (budget.visited > 0 && budget.visited % SCAN_YIELD_INTERVAL === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function collectFiles(root: string, initialRelative: string, output: Set<string>, budget: ScanBudget): Promise<void> {
  const pending: PendingPath[] = [{ relative: initialRelative, depth: 0 }];
  budget.visited += 1;

  while (pending.length > 0) {
    if (output.size >= MAX_TAGGED_FILES) {
      budget.truncated = true;
      return;
    }
    const current = pending.pop()!;
    if (current.depth > MAX_TAGGED_DEPTH) {
      budget.truncated = true;
      continue;
    }
    await yieldToMainLoop(budget);

    const absolute = path.resolve(root, ...current.relative.split('/'));
    const canonical = await fs.realpath(absolute).catch(() => null);
    if (!canonical || !confined(root, canonical)) continue;
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat || stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      output.add(current.relative);
      continue;
    }
    if (!stat.isDirectory()) continue;

    const children: PendingPath[] = [];
    let directory;
    try {
      directory = await fs.opendir(absolute);
    } catch {
      continue;
    }
    try {
      for await (const child of directory) {
        if (budget.visited >= MAX_TAGGED_VISITED_ENTRIES) {
          budget.truncated = true;
          break;
        }
        budget.visited += 1;
        await yieldToMainLoop(budget);
        if (child.isSymbolicLink() || (child.isDirectory() && ignoredDirectories.has(child.name))) continue;
        if (!child.isFile() && !child.isDirectory()) continue;
        children.push({
          relative: `${current.relative}/${child.name}`,
          depth: current.depth + 1,
        });
      }
    } catch {
      // Concurrently removed or unreadable children are omitted from the manifest.
    }
    children.sort((left, right) => right.relative.localeCompare(left.relative, undefined, { numeric: true, sensitivity: 'base' }));
    pending.push(...children);
    if (budget.truncated) return;
  }
}

export function hasProjectResourceTags(text: string): boolean {
  return taggedPaths(text).length > 0;
}

/** Builds bounded, project-confined context for canonical #file and #folder tags. */
export async function appendProjectResourceContext(text: string, projectRoot: string | null, tagSource = text): Promise<string> {
  const tags = taggedPaths(tagSource);
  if (!projectRoot || tags.length === 0) return text;
  const root = await fs.realpath(projectRoot).catch(() => null);
  if (!root) return text;

  const files = new Set<string>();
  const budget: ScanBudget = { visited: 0, truncated: false };
  for (const tag of tags) {
    const relative = relativePath(tag);
    if (!relative) continue;
    if (budget.visited >= MAX_TAGGED_VISITED_ENTRIES || files.size >= MAX_TAGGED_FILES) {
      budget.truncated = true;
      break;
    }
    await collectFiles(root, relative, files, budget);
  }

  const sorted = [...files].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
  if (sorted.length === 0) return text;
  const lines: string[] = [];
  let characters = 0;
  for (const entry of sorted) {
    const line = `- ${entry}`;
    if (characters + line.length + 1 > MAX_TAGGED_CONTEXT_CHARACTERS) {
      budget.truncated = true;
      break;
    }
    lines.push(line);
    characters += line.length + 1;
  }
  if (budget.truncated) lines.push('- … additional project entries omitted');

  return `${text}\n\n[Tagged project resources (project-relative; use project tools to inspect; folders include descendants)]\n${lines.join('\n')}\n[/Tagged project resources]`;
}
