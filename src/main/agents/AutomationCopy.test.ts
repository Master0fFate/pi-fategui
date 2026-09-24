import { describe, expect, it } from 'vitest';
import { previewAutomationCopy, restoreAutomationCopy } from './AutomationCopy';
import { effectivePermission } from './RoutinePolicy';

const automation = {
  id: '62e5f3dc-d0d7-4ec9-8b69-2c193f001167', projectPath: '/project', name: 'Audit',
  prompt: 'Review the project', permissionLevel: 'edit', createdAt: 1, updatedAt: 2,
  lastLaunchedAt: 2, lastLaunchOutcome: 'failed', launchCount: 12,
};

describe('D0-06 non-destructive Automation copy proof', () => {
  it.each(['read-only', 'edit'] as const)('preserves every source byte and %s permissions', (permissionLevel) => {
    const source = `${JSON.stringify({ ...automation, permissionLevel }, null, '\t')}\r\n`;
    const copy = previewAutomationCopy(source);
    expect(restoreAutomationCopy(copy)).toBe(source);
    expect(previewAutomationCopy(source)).toEqual(copy);
    expect(copy.task.messageRole).toBe('user');
    expect(copy.task.prompt).toBe(automation.prompt);
    expect(copy.task.permissionCeiling).toBe(permissionLevel);
    expect(effectivePermission('read-only', copy.task.permissionCeiling)).toBe('read-only');
    expect(copy.routine).toBeNull();
    expect(JSON.parse(copy.source)).toEqual({ ...automation, permissionLevel });
  });
  it('preserves a 200,000-character prompt without turning it into instructions', () => {
    const prefix = '/command @live ~saved\n';
    const prompt = prefix + 'x'.repeat(200_000 - prefix.length);
    const copy = previewAutomationCopy(JSON.stringify({ ...automation, prompt }));
    expect(copy.task.prompt).toBe(prompt);
    expect(copy.task).not.toHaveProperty('instructions');
    expect(() => previewAutomationCopy(JSON.stringify({ ...automation, prompt: 'x'.repeat(200_001) }))).toThrow();
  });
  it('refuses modified archive bytes and unknown source fields rather than silently dropping them', () => {
    const copy = previewAutomationCopy(JSON.stringify(automation));
    expect(() => restoreAutomationCopy({ ...copy, source: copy.source + ' ' })).toThrow(/integrity/);
    expect(() => previewAutomationCopy(JSON.stringify({ ...automation, futureField: true }))).toThrow();
  });
});
