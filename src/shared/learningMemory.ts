import { emptyActivation, type LearningScope, type LessonContent } from './contracts/learning';

export const memoryKindLabel = (kind: LessonContent['kind']): string => ({ 'user-profile': 'User coding profile', 'project-brief': 'Project briefing', note: 'Note', procedure: 'Project skill' })[kind];
export const isCoreMemory = (content: LessonContent): boolean => content.kind === 'user-profile' || content.kind === 'project-brief';
export function newCoreMemory(scope: LearningScope): LessonContent {
  return scope === 'global'
    ? { kind: 'user-profile', title: 'My coding preferences', body: { communication: [], workflow: [], codingPreferences: [], designPreferences: [], decisionMaking: [], learningStyle: [], likes: [], dislikes: [] }, activation: { ...emptyActivation } }
    : { kind: 'project-brief', title: 'Project briefing', body: { overview: '', architecture: [], decisions: [], currentWork: [], nextSteps: [] }, activation: { ...emptyActivation } };
}
export function memoryScopeError(content: LessonContent, scope: LearningScope): string | null {
  if (scope === 'global' && content.kind !== 'user-profile') return 'GLOBAL memory is your user coding profile. Review shared legacy lessons as profile preferences; repository knowledge belongs in PROJECT.';
  if (scope === 'project' && content.kind === 'user-profile') return 'User profiles belong in GLOBAL. Use a project briefing, note, or procedure for this repository.';
  return null;
}
export function mergeProfileAdditions(previous: LessonContent, incoming: LessonContent): LessonContent {
  if (previous.kind !== 'user-profile' || incoming.kind !== 'user-profile') return incoming;
  const body = { ...previous.body };
  for (const key of Object.keys(body) as (keyof typeof body)[]) body[key] = [...new Set([...body[key], ...incoming.body[key]])];
  return { ...previous, body };
}
