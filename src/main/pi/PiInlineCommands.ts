import { readFileSync } from 'node:fs';
import { stripFrontmatter } from '@earendil-works/pi-coding-agent';
import type { RuntimeState } from '../../shared/contracts/ipc';

type RuntimeCommand = NonNullable<RuntimeState['commands']>[number];

export interface InlineSkill {
  name: string;
  filePath: string;
  baseDir: string;
}

interface SkillInvocation {
  skill: InlineSkill;
  start: number;
  end: number;
}

/**
 * Pi expands skills and prompt templates only when their slash command starts
 * the prompt. Promote an exact inline resource invocation while leaving
 * extension commands and ordinary slash-like text untouched.
 */
export function promoteInlineResourceCommand(text: string, commands: readonly RuntimeCommand[]): string {
  if (text.startsWith('/')) return text;

  const resources = new Set(
    commands
      .filter((command) => command.source !== 'extension')
      .map((command) => command.name),
  );
  const tokens = text.matchAll(/(^|\s)\/([^\s/]+)/gu);

  for (const match of tokens) {
    const commandName = match[2];
    if (!commandName || !resources.has(commandName)) continue;

    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const end = start + commandName.length + 1;
    const before = text.slice(0, start).trim();
    const after = text.slice(end).trim();
    const argumentsText = [before, after].filter(Boolean).join(' ');
    return `/${commandName}${argumentsText ? ` ${argumentsText}` : ''}`;
  }

  return text;
}

/**
 * Pi expands only one leading /skill command. When a prompt tags two or more
 * available skills, compose the same skill blocks Pi would have produced so
 * every tagged skill reaches the model in the same turn.
 */
export function expandMultipleSkillCommands(text: string, skills: readonly InlineSkill[]): string | null {
  const skillsByCommand = new Map(skills.map((skill) => [`skill:${skill.name}`, skill]));
  const leadingCommand = /^\s*\/([^\s/]+)/u.exec(text)?.[1];
  if (leadingCommand && !skillsByCommand.has(leadingCommand)) return null;

  const invocations: SkillInvocation[] = [];
  for (const match of text.matchAll(/(^|\s)\/([^\s/]+)/gu)) {
    const commandName = match[2];
    if (!commandName) continue;
    const skill = skillsByCommand.get(commandName);
    if (!skill) continue;
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    invocations.push({ skill, start, end: start + commandName.length + 1 });
  }
  if (invocations.length < 2) return null;

  const selected = invocations.filter((invocation, index) => (
    invocations.findIndex((candidate) => candidate.skill.name === invocation.skill.name) === index
  ));
  const blocks = selected.map(({ skill }) => {
    let content: string;
    try {
      content = readFileSync(skill.filePath, 'utf8');
    } catch (cause) {
      throw new Error(`Could not load tagged skill "${skill.name}" from ${skill.filePath}.`, { cause });
    }
    const body = stripFrontmatter(content).trim();
    return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  });

  let requestStart = text.search(/\S/u);
  for (const invocation of invocations) {
    if (invocation.start !== requestStart) {
      requestStart = -1;
      break;
    }
    requestStart = invocation.end;
    requestStart += (/^\s*/u.exec(text.slice(requestStart))?.[0].length ?? 0);
  }
  const request = (requestStart >= 0 ? text.slice(requestStart) : text).trim();
  return `${blocks.join('\n\n')}${request ? `\n\n${request}` : ''}`;
}
