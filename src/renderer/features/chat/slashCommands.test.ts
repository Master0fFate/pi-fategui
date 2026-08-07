import { describe, expect, it } from 'vitest';
import { findSlashCommands, slashCommandContext, slashCommandDescription, slashCommandLabel } from './slashCommands';

const commands = [
  { name: 'parallax', description: 'Control the Parallax engineering protocol', source: 'extension' as const },
  { name: 'skill:vibesecurity', description: 'Defensive, evidence-first security review for code the user owns or is authorized to assess.', source: 'skill' as const },
  { name: 'parallax-debug', description: 'Run a post-build review', source: 'prompt' as const },
];

describe('slash command suggestions', () => {
  it('finds a slash token at the caret at prompt start or after existing text', () => {
    expect(slashCommandContext('/', 1)).toEqual({ query: '', start: 0, end: 1, commandPosition: true });
    expect(slashCommandContext('/vibe', 5)).toEqual({ query: 'vibe', start: 0, end: 5, commandPosition: true });
    expect(slashCommandContext('ask /vibe', 9)).toEqual({ query: 'vibe', start: 4, end: 9, commandPosition: false });
    expect(slashCommandContext('ask /vibe later', 7)).toEqual({ query: 'vibe', start: 4, end: 9, commandPosition: false });
    expect(slashCommandContext('/vibe now', 9)).toBeNull();
    expect(slashCommandContext('//vibe', 6)).toBeNull();
    expect(slashCommandContext('https://example.com', 19)).toBeNull();
  });

  it('lists the complete catalog and removes extensions from inline discovery', () => {
    const completeCatalog = Array.from({ length: 24 }, (_value, index) => ({
      name: `skill:item-${index}`,
      description: `Skill ${index}`,
      source: 'skill' as const,
    }));
    expect(findSlashCommands(completeCatalog, '')).toHaveLength(24);
    expect(findSlashCommands(commands, '', { includeExtensions: false })).toEqual([commands[1], commands[2]]);
  });

  it('finds canonical skill commands by their human name and tolerates a small typo', () => {
    expect(findSlashCommands(commands, 'vibe')).toEqual([commands[1]]);
    expect(findSlashCommands(commands, 'wipesecurity')).toEqual([commands[1]]);
    expect(slashCommandLabel(commands[1]!)).toBe('vibesecurity');
  });

  it('preserves Pi invocation names and ranks exact extension commands first', () => {
    expect(findSlashCommands(commands, 'parallax').map((command) => command.name)).toEqual([
      'parallax',
      'parallax-debug',
    ]);
  });

  it('bounds long descriptions without cutting a useful phrase too early', () => {
    const description = slashCommandDescription({
      name: 'skill:long',
      source: 'skill',
      description: 'A '.repeat(100),
    });
    expect(description.length).toBeLessThanOrEqual(93);
    expect(description).toMatch(/…$/u);
  });
});
