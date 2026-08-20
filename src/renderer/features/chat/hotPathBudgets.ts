import { MAX_LIVE_TIMELINE_ENTITIES, MAX_LIVE_TOOL_OUTPUT } from '../../stores/runtimeStore';

/** Visible running-tool preview. Full output stays collapsed until the user opens the card. */
export const TOOL_OUTPUT_PREVIEW_CHARS = 600;

export const hotPathBudgets = {
  liveToolOutputChars: MAX_LIVE_TOOL_OUTPUT,
  liveTimelineEntities: MAX_LIVE_TIMELINE_ENTITIES,
  toolPreviewChars: TOOL_OUTPUT_PREVIEW_CHARS,
} as const;

export function previewHotPathText(value: string, limit = TOOL_OUTPUT_PREVIEW_CHARS): { text: string; clipped: boolean } {
  if (value.length <= limit) return { text: value, clipped: false };
  return { text: `${value.slice(0, Math.max(0, limit - 1))}…`, clipped: true };
}

export function shouldAutoShowRunningOutput(output: string): boolean {
  return output.length > 0 && output.length <= TOOL_OUTPUT_PREVIEW_CHARS;
}
