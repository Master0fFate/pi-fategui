import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandMultipleSkillCommands, promoteInlineResourceCommand } from './PiInlineCommands';

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

  it('expands every skill when multiple skills are tagged in one prompt', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fate-inline-skills-'));
    const firstPath = path.join(directory, 'first.md');
    const secondPath = path.join(directory, 'second.md');
    try {
      writeFileSync(firstPath, '---\nname: first\ndescription: First skill\n---\n\n# First instructions\n\nFollow the first workflow.');
      writeFileSync(secondPath, '---\nname: second\ndescription: Second skill\n---\n\n# Second instructions\n\nFollow the second workflow.');

      const skills = [
        { name: 'first', filePath: firstPath, baseDir: directory },
        { name: 'second', filePath: secondPath, baseDir: directory },
      ];
      expect(expandMultipleSkillCommands('/skill:first /skill:second Fix the issue', skills)).toBe([
        `<skill name="first" location="${firstPath}">`,
        `References are relative to ${directory}.`,
        '',
        '# First instructions',
        '',
        'Follow the first workflow.',
        '</skill>',
        '',
        `<skill name="second" location="${secondPath}">`,
        `References are relative to ${directory}.`,
        '',
        '# Second instructions',
        '',
        'Follow the second workflow.',
        '</skill>',
        '',
        'Fix the issue',
      ].join('\n'));
      expect(expandMultipleSkillCommands('Use /skill:first and /skill:second together', skills))
        .toMatch(/<skill name="first"[\s\S]*<skill name="second"[\s\S]*Use \/skill:first and \/skill:second together$/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('leaves a single skill tag for Pi native expansion', () => {
    expect(expandMultipleSkillCommands('/skill:vibesecurity inspect', [
      { name: 'vibesecurity', filePath: '/skills/vibesecurity/SKILL.md', baseDir: '/skills/vibesecurity' },
    ])).toBeNull();
  });

  it('preserves a leading non-skill command instead of intercepting it', () => {
    const skills = [
      { name: 'first', filePath: '/skills/first/SKILL.md', baseDir: '/skills/first' },
      { name: 'second', filePath: '/skills/second/SKILL.md', baseDir: '/skills/second' },
    ];
    expect(expandMultipleSkillCommands('/review /skill:first /skill:second', skills)).toBeNull();
  });
});
