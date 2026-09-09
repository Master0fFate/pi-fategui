import type { LessonContent } from './contracts/learning';

export function learningMarkdown(content: LessonContent): string {
  if (content.kind === 'note') return `# ${content.title}\n\n${content.body.guidance}\n\n## Rationale\n\n${content.body.rationale}\n\n## Exceptions\n\n${content.body.exceptions.map((line) => `- ${line}`).join('\n')}`;
  if (content.kind === 'user-profile' || content.kind === 'project-brief') {
    const entries = Object.entries(content.body).map(([key, value]) => `## ${key.replace(/([A-Z])/gu, ' $1')}\n\n${Array.isArray(value) ? value.map((item) => `- ${item}`).join('\n') : value}`);
    return `# ${content.title}\n\n${entries.join('\n\n')}`;
  }
  const { body } = content;
  const sections: [string, string[]][] = [['Use when', body.useWhen], ['Do not use when', body.doNotUseWhen], ['Preconditions', body.preconditions], ['Steps', body.steps], ['Verification', body.verification], ['Stop conditions', body.stopConditions]];
  return `# ${content.title}\n\n## Purpose\n\n${body.purpose}\n\n${sections.map(([title, items]) => `## ${title}\n\n${items.map((line, index) => title === 'Steps' ? `${index + 1}. ${line}` : `- ${line}`).join('\n')}`).join('\n\n')}`;
}
