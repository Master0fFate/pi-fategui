import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_PROMPT_MAX_LENGTH,
  automationCreateInputSchema,
  automationDefinitionSchema,
  automationLaunchRecordInputSchema,
  automationUpdateInputSchema,
} from './automations';

const id = '00000000-0000-4000-8000-000000000001';

function definition() {
  return {
    id,
    projectPath: 'C:/project',
    name: 'Review auth changes',
    prompt: 'Review the authentication changes and run focused tests.',
    permissionLevel: 'read-only' as const,
    createdAt: 1,
    updatedAt: 1,
    lastLaunchedAt: null,
    lastLaunchOutcome: null,
    launchCount: 0,
  };
}

describe('automation contracts', () => {
  it('normalizes bounded definitions and excludes Full access', () => {
    expect(automationCreateInputSchema.parse({
      name: '  Review auth changes  ',
      prompt: '  Review the authentication changes.  ',
    })).toEqual({
      name: 'Review auth changes',
      prompt: 'Review the authentication changes.',
      permissionLevel: 'read-only',
    });
    expect(automationDefinitionSchema.parse(definition())).toEqual(definition());
    expect(() => automationCreateInputSchema.parse({
      name: 'Unsafe',
      prompt: 'Run anything',
      permissionLevel: 'full-access',
    })).toThrow();
  });

  it('rejects malformed IDs, control characters, oversized fields, and extra keys', () => {
    expect(() => automationUpdateInputSchema.parse({
      id: 'not-an-id',
      name: 'Review',
      prompt: 'Run tests',
      permissionLevel: 'edit',
    })).toThrow();
    expect(() => automationCreateInputSchema.parse({ name: 'Bad\nname', prompt: 'Run tests' })).toThrow();
    expect(() => automationCreateInputSchema.parse({ name: 'x'.repeat(AUTOMATION_NAME_MAX_LENGTH + 1), prompt: 'Run tests' })).toThrow();
    expect(() => automationCreateInputSchema.parse({ name: 'Review', prompt: 'x'.repeat(AUTOMATION_PROMPT_MAX_LENGTH + 1) })).toThrow();
    expect(() => automationCreateInputSchema.parse({ name: 'Review', prompt: 'Run tests', schedule: '*' })).toThrow();
  });

  it('records only explicit bounded launch outcomes', () => {
    expect(automationLaunchRecordInputSchema.parse({ id, outcome: 'accepted' })).toEqual({ id, outcome: 'accepted' });
    expect(() => automationLaunchRecordInputSchema.parse({ id, outcome: 'running' })).toThrow();
  });
});
