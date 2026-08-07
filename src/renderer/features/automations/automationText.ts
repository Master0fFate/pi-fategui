export const AUTOMATION_PROMPT_PREVIEW_CHARACTERS = 240;

export function automationPromptPreview(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (compact.length <= AUTOMATION_PROMPT_PREVIEW_CHARACTERS) return compact;
  return `${compact.slice(0, AUTOMATION_PROMPT_PREVIEW_CHARACTERS - 1).trimEnd()}…`;
}

export function automationSearchPattern(query: string): RegExp {
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(escaped, 'iu');
}
