import type { RuntimeState } from '../../../shared/contracts/ipc';

export type SlashCommand = NonNullable<RuntimeState['commands']>[number];

export interface SlashCommandContext {
  query: string;
  start: number;
  end: number;
  commandPosition: boolean;
}

export interface SlashCommandFilter {
  includeExtensions?: boolean;
}

interface SlashCommandSearchIndex {
  name: string;
  description: SlashCommand['description'];
  source: SlashCommand['source'];
  label: string;
  canonical: string;
  normalizedDescription: string;
  labelParts: string[];
}

const slashCommandSearchCache = new WeakMap<SlashCommand, SlashCommandSearchIndex>();

export function slashCommandContext(draft: string, caret: number): SlashCommandContext | null {
  const boundedCaret = Math.max(0, Math.min(draft.length, caret));
  const beforeCaret = draft.slice(0, boundedCaret);
  const match = /(^|\s)\/([^\s/]*)$/u.exec(beforeCaret);
  if (!match) return null;

  const queryBeforeCaret = match[2] ?? '';
  const start = boundedCaret - queryBeforeCaret.length - 1;
  const queryAfterCaret = /^[^\s/]*/u.exec(draft.slice(boundedCaret))?.[0] ?? '';
  return {
    query: `${queryBeforeCaret}${queryAfterCaret}`,
    start,
    end: boundedCaret + queryAfterCaret.length,
    commandPosition: draft.slice(0, start).trim().length === 0,
  };
}

export function slashCommandLabel(command: SlashCommand): string {
  return command.source === 'skill' && command.name.startsWith('skill:')
    ? command.name.slice('skill:'.length)
    : command.name;
}

export function slashCommandDescription(command: SlashCommand): string {
  const fallback = command.source === 'skill'
    ? 'Load skill instructions'
    : command.source === 'extension'
      ? 'Run extension command'
      : command.source === 'builtin'
        ? 'Use Fate UI command'
        : 'Use prompt template';
  const clean = (command.description || fallback).replace(/\s+/g, ' ').trim();
  if (clean.length <= 92) return clean;
  const candidate = clean.slice(0, 89);
  const boundary = candidate.lastIndexOf(' ');
  return `${candidate.slice(0, boundary > 60 ? boundary : candidate.length).trimEnd()}…`;
}

export function findSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  { includeExtensions = true }: SlashCommandFilter = {},
): SlashCommand[] {
  const normalizedQuery = normalize(query);
  return commands
    .filter((command) => includeExtensions || command.source !== 'extension')
    .map((command, index) => ({ command, index, score: commandScore(command, normalizedQuery) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ command }) => command);
}

function commandScore(command: SlashCommand, query: string): number {
  if (!query) return 1;
  const indexed = searchIndexForCommand(command);
  if (indexed.label === query || indexed.canonical === query) return 100;
  if (indexed.label.startsWith(query)) return 90;
  if (indexed.canonical.startsWith(query)) return 85;
  if (indexed.labelParts.some((part) => part.startsWith(query))) return 80;
  if (indexed.label.includes(query) || indexed.canonical.includes(query)) return 70;
  if (isSubsequence(query, indexed.label)) return 55;
  if (query.length >= 3 && editDistanceAtMost(indexed.label, query, 2)) return 45;
  if (indexed.normalizedDescription.includes(query)) return 25;
  return -1;
}

function searchIndexForCommand(command: SlashCommand): SlashCommandSearchIndex {
  const cached = slashCommandSearchCache.get(command);
  if (cached
    && cached.name === command.name
    && cached.description === command.description
    && cached.source === command.source) return cached;
  const label = normalize(slashCommandLabel(command));
  const indexed: SlashCommandSearchIndex = {
    name: command.name,
    description: command.description,
    source: command.source,
    label,
    canonical: normalize(command.name),
    normalizedDescription: normalize(command.description),
    labelParts: label.split(/[^a-z0-9]+/u),
  };
  slashCommandSearchCache.set(command, indexed);
  return indexed;
}

function normalize(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase().replace(/[\u0300-\u036f]/gu, '').replace(/^skill:/u, '');
}

function isSubsequence(query: string, value: string): boolean {
  let queryIndex = 0;
  for (const character of value) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function editDistanceAtMost(value: string, query: string, maximum: number): boolean {
  if (Math.abs(value.length - query.length) > maximum) return false;
  let previous = Array.from({ length: query.length + 1 }, (_value, index) => index);
  for (let valueIndex = 1; valueIndex <= value.length; valueIndex += 1) {
    const current = [valueIndex];
    let rowMinimum = valueIndex;
    for (let queryIndex = 1; queryIndex <= query.length; queryIndex += 1) {
      const cost = value[valueIndex - 1] === query[queryIndex - 1] ? 0 : 1;
      const distance = Math.min(
        (current[queryIndex - 1] ?? 0) + 1,
        (previous[queryIndex] ?? 0) + 1,
        (previous[queryIndex - 1] ?? 0) + cost,
      );
      current.push(distance);
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > maximum) return false;
    previous = current;
  }
  return (previous[query.length] ?? maximum + 1) <= maximum;
}
