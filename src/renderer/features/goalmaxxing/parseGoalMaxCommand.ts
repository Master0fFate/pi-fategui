export type ParsedGoalMaxCommand =
  | { kind: 'create'; objective: string }
  | { kind: 'invalid'; message: string };

/** Strict renderer-owned routing. Only `/goalmaxxing <objective>` is a command. */
export function parseGoalMaxCommand(draft: string): ParsedGoalMaxCommand | null {
  if (!draft.startsWith('/goalmaxxing')) return null;
  const boundary = draft['/goalmaxxing'.length];
  if (boundary !== undefined && !/\s/u.test(boundary)) return null;
  const objective = draft.slice('/goalmaxxing'.length).trim();
  if (!objective) return { kind: 'invalid', message: 'Add an objective after /goalmaxxing.' };
  return { kind: 'create', objective };
}
