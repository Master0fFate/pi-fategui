import { describe, expect, it } from 'vitest';
import { manageParameters, workflowParameters } from './SubagentProtocol';

describe('SubagentProtocol tool schemas', () => {
  it('uses object-root schemas that OpenAI-compatible providers can accept', () => {
    expect(manageParameters).toMatchObject({
      type: 'object',
      required: ['action'],
      properties: { action: { type: 'string', enum: ['list', 'status', 'wait', 'steer', 'retarget', 'followup', 'close', 'cancel'] } },
      additionalProperties: false,
    });
    expect(workflowParameters).toMatchObject({
      type: 'object',
      required: ['action'],
      properties: { action: { type: 'string', enum: ['start', 'list', 'status', 'cancel', 'resume'] } },
      additionalProperties: false,
    });
    expect(manageParameters).not.toHaveProperty('anyOf');
    expect(workflowParameters).not.toHaveProperty('anyOf');
  });
});
