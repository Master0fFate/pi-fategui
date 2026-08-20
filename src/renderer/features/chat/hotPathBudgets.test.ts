import { describe, expect, it } from 'vitest';
import { MAX_LIVE_TIMELINE_ENTITIES, MAX_LIVE_TOOL_OUTPUT } from '../../stores/runtimeStore';
import { hotPathBudgets, previewHotPathText, shouldAutoShowRunningOutput, TOOL_OUTPUT_PREVIEW_CHARS } from './hotPathBudgets';

describe('hot-path budgets', () => {
  it('keeps live store caps and a smaller collapsed preview', () => {
    expect(hotPathBudgets.liveToolOutputChars).toBe(MAX_LIVE_TOOL_OUTPUT);
    expect(hotPathBudgets.liveTimelineEntities).toBe(MAX_LIVE_TIMELINE_ENTITIES);
    expect(hotPathBudgets.toolPreviewChars).toBeLessThan(hotPathBudgets.liveToolOutputChars);
    expect(TOOL_OUTPUT_PREVIEW_CHARS).toBe(600);
  });

  it('clips previews without expanding the live store cap', () => {
    expect(previewHotPathText('short')).toEqual({ text: 'short', clipped: false });
    const long = 'x'.repeat(TOOL_OUTPUT_PREVIEW_CHARS + 20);
    const preview = previewHotPathText(long);
    expect(preview.clipped).toBe(true);
    expect(preview.text.length).toBe(TOOL_OUTPUT_PREVIEW_CHARS);
    expect(shouldAutoShowRunningOutput('ok')).toBe(true);
    expect(shouldAutoShowRunningOutput(long)).toBe(false);
    expect(shouldAutoShowRunningOutput('')).toBe(false);
  });
});
