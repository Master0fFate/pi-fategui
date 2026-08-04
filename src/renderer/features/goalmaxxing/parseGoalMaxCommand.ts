export type ParsedGoalMaxCommand =
  | { kind: 'create'; objective: string }
  | { kind: 'invalid'; message: string };

/** Strict renderer-owned routing. Only `/goalmax <objective>` is a command. */
export function parseGoalMaxCommand(draft: string): ParsedGoalMaxCommand | null {
  if (!draft.startsWith('/goalmax')) return null;
  const boundary = draft['/goalmax'.length];
  if (boundary !== undefined && !/\s/u.test(boundary)) return null;
  const objective = draft.slice('/goalmax'.length).trim();
  if (!objective) return { kind: 'invalid', message: 'Add an objective after /goalmax.' };
  return { kind: 'create', objective };
}
