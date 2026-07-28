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
  const label = normalize(slashCommandLabel(command));
  const canonical = normalize(command.name);
  const description = normalize(command.description);
  if (label === query || canonical === query) return 100;
  if (label.startsWith(query)) return 90;
  if (canonical.startsWith(query)) return 85;
  if (label.split(/[^a-z0-9]+/u).some((part) => part.startsWith(query))) return 80;
  if (label.includes(query) || canonical.includes(query)) return 70;
  if (isSubsequence(query, label)) return 55;
  if (query.length >= 3 && editDistanceAtMost(label, query, 2)) return 45;
  if (description.includes(query)) return 25;
  return -1;
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
