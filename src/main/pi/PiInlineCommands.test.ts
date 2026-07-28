import { describe, expect, it } from 'vitest';
import { promoteInlineResourceCommand } from './PiInlineCommands';

const commands = [
  { name: 'parallax', description: 'Control Parallax', source: 'extension' as const },
  { name: 'review', description: 'Review changes', source: 'prompt' as const },
  { name: 'skill:vibesecurity', description: 'Run a security review', source: 'skill' as const },
];

describe('inline Pi resource commands', () => {
  it('promotes inline skills and prompt templates so Pi can expand them', () => {
    expect(promoteInlineResourceCommand('Inspect this with /skill:vibesecurity please', commands))
      .toBe('/skill:vibesecurity Inspect this with please');
    expect(promoteInlineResourceCommand('Review this /review', commands))
      .toBe('/review Review this');
  });

  it('preserves leading commands, inline extensions, URLs, and unknown slash text', () => {
    expect(promoteInlineResourceCommand('/review current changes', commands)).toBe('/review current changes');
    expect(promoteInlineResourceCommand('Check this /parallax status', commands)).toBe('Check this /parallax status');
    expect(promoteInlineResourceCommand('Open https://example.com/review', commands)).toBe('Open https://example.com/review');
    expect(promoteInlineResourceCommand('Use /not-a-command here', commands)).toBe('Use /not-a-command here');
  });

  it('promotes commands after leading whitespace to true command position', () => {
    expect(promoteInlineResourceCommand('  /skill:vibesecurity inspect', commands))
      .toBe('/skill:vibesecurity inspect');
  });
});
