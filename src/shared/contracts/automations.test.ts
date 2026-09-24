import { describe, expect, it } from 'vitest';
import { automationDefinitionSchema, automationListSchema } from './automations';

const definition = {
  id: '00000000-0000-4000-8000-000000000001',
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

describe('legacy automation contracts', () => {
  it('accepts a valid archived definition and list', () => {
    expect(automationDefinitionSchema.parse(definition)).toEqual(definition);
    expect(automationListSchema.parse([definition])).toEqual([definition]);
  });

  it('rejects Full access, malformed IDs, control characters, oversized fields, and extra keys', () => {
    expect(() => automationDefinitionSchema.parse({ ...definition, permissionLevel: 'full-access' })).toThrow();
    expect(() => automationDefinitionSchema.parse({ ...definition, id: 'not-an-id' })).toThrow();
    expect(() => automationDefinitionSchema.parse({ ...definition, name: 'Bad\nname' })).toThrow();
    expect(() => automationDefinitionSchema.parse({ ...definition, prompt: 'x'.repeat(200_001) })).toThrow();
    expect(() => automationDefinitionSchema.parse({ ...definition, schedule: '*' })).toThrow();
  });
});
