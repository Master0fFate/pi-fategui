export type ParsedGoalMaxCommand =
  | { kind: 'view' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'create'; objective: string };

/** Renderer-owned, thread-scoped GoalMax lifecycle commands. */
export function parseGoalMaxCommand(draft: string): ParsedGoalMaxCommand | null {
  if (!draft.startsWith('/goalmax')) return null;
  const boundary = draft['/goalmax'.length];
  if (boundary !== undefined && !/\s/u.test(boundary)) return null;
  const argument = draft.slice('/goalmax'.length).trim();
  if (!argument || argument.toLocaleLowerCase() === 'status') return { kind: 'view' };
  const lifecycle = argument.toLocaleLowerCase();
  if (lifecycle === 'pause') return { kind: 'pause' };
  if (lifecycle === 'resume') return { kind: 'resume' };
  if (lifecycle === 'clear') return { kind: 'clear' };
  return { kind: 'create', objective: argument };
}
