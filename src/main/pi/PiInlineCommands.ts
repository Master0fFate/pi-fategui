import type { RuntimeState } from '../../shared/contracts/ipc';

type RuntimeCommand = NonNullable<RuntimeState['commands']>[number];

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
