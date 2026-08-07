import { describe, expect, it } from 'vitest';
import { AUTOMATION_PROMPT_PREVIEW_CHARACTERS, automationPromptPreview, automationSearchPattern } from './automationText';

describe('automation text helpers', () => {
  it('keeps list previews compact without changing the saved prompt', () => {
    const prompt = `Review\n\n${'authorization '.repeat(40)}`;
    const preview = automationPromptPreview(prompt);

    expect(preview.length).toBeLessThanOrEqual(AUTOMATION_PROMPT_PREVIEW_CHARACTERS);
    expect(preview).toMatch(/^Review authorization/u);
    expect(preview).toMatch(/…$/u);
    expect(prompt).toContain('\n\n');
  });

  it('treats automation search as a case-insensitive literal query', () => {
    const pattern = automationSearchPattern('Auth.* [check]');

    expect(pattern.test('Run an AUTH.* [CHECK] before release')).toBe(true);
    expect(pattern.test('Run an auth wildcard check before release')).toBe(false);
  });
});
