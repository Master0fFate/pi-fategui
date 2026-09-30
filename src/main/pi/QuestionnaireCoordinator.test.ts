import { describe, expect, it, vi } from 'vitest';
import { questionnaireAnswerInputSchema, pendingQuestionnaireSchema } from '../../shared/contracts/ipc';
import { QuestionnaireCoordinator } from './QuestionnaireCoordinator';

const questions = [
  { question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres', description: 'Shared server' }, { label: 'Other DB' }] },
  { question: 'Which theme?', options: [{ label: 'Dark' }, { label: 'Light' }, { label: 'System' }] },
  { question: 'Which scope?', options: [{ label: 'Local' }, { label: 'All users' }, { label: 'Ask later' }] },
];

function fixture() {
  const changed = vi.fn();
  let current = true;
  const coordinator = new QuestionnaireCoordinator(changed);
  const tool = coordinator.createTool(() => current);
  const call = (items: unknown = questions, sessionId = 'session-1', signal?: AbortSignal) => tool.execute('call-1', { questions: items }, signal, undefined, {
    sessionManager: { getSessionId: () => sessionId },
  } as never);
  return { coordinator, call, changed, invalidate: () => { current = false; } };
}

async function pendingQuestion(coordinator: QuestionnaireCoordinator, sessionId = 'session-1') {
  await vi.waitFor(() => expect(coordinator.get(sessionId)).not.toBeNull());
  return pendingQuestionnaireSchema.parse(coordinator.get(sessionId));
}

describe('ask_user_question', () => {
  it('returns three answers in original order, with a custom fourth choice on the second question', async () => {
    const { call, coordinator } = fixture();
    const result = call();
    const first = await pendingQuestion(coordinator);
    expect(first).toMatchObject({ index: 0, total: 3, question: 'Which database?', options: questions[0]!.options });
    coordinator.respond('session-1', { id: first.id, index: 0, answer: 'Postgres', source: 'option' });
    const second = await pendingQuestion(coordinator);
    expect(second).toMatchObject({ index: 1, total: 3, question: 'Which theme?' });
    coordinator.respond('session-1', { id: second.id, index: 1, answer: '  My custom theme  ', source: 'custom' });
    const third = await pendingQuestion(coordinator);
    expect(third).toMatchObject({ index: 2, total: 3, question: 'Which scope?' });
    coordinator.respond('session-1', { id: third.id, index: 2, answer: 'Local', source: 'option' });
    await expect(result).resolves.toMatchObject({ details: {
      status: 'answered', answers: [
        { index: 0, question: 'Which database?', answer: 'Postgres', source: 'option' },
        { index: 1, question: 'Which theme?', answer: 'My custom theme', source: 'custom' },
        { index: 2, question: 'Which scope?', answer: 'Local', source: 'option' },
      ],
    } });
    expect(coordinator.get('session-1')).toBeNull();
  });

  it('refuses stale indices, forged choices, blank custom input, and answers from another session', async () => {
    const { call, coordinator } = fixture();
    const result = call();
    const first = await pendingQuestion(coordinator);
    expect(() => coordinator.respond('session-2', { id: first.id, index: 0, answer: 'SQLite', source: 'option' })).toThrow(/no longer active/);
    expect(() => coordinator.respond('session-1', { id: first.id, index: 1, answer: 'SQLite', source: 'option' })).toThrow(/no longer active/);
    expect(() => coordinator.respond('session-1', { id: first.id, index: 0, answer: 'Forged', source: 'option' })).toThrow(/Select one/);
    expect(() => coordinator.respond('session-1', { id: first.id, index: 0, answer: ' ', source: 'custom' })).toThrow(/non-empty/);
    coordinator.respond('session-1', { id: first.id, index: 0, answer: 'SQLite', source: 'option' });
    const second = await pendingQuestion(coordinator);
    expect(() => coordinator.respond('session-1', { id: first.id, index: 0, answer: 'SQLite', source: 'option' })).toThrow(/no longer active/);
    expect(second.id).not.toBe(first.id);
    coordinator.cancel('session-1');
    await expect(result).resolves.toMatchObject({ details: { status: 'cancelled', answers: [] } });
  });

  it('cancels on session abort and isolates simultaneous sessions', async () => {
    const { call, coordinator } = fixture();
    const controller = new AbortController();
    const first = call(questions, 'session-1', controller.signal);
    const other = call([questions[0]], 'session-2');
    const firstView = await pendingQuestion(coordinator);
    const otherView = await pendingQuestion(coordinator, 'session-2');
    controller.abort();
    await expect(first).resolves.toMatchObject({ details: { status: 'cancelled', answers: [] } });
    expect(coordinator.get('session-1')).toBeNull();
    expect(coordinator.get('session-2')).toEqual(otherView);
    coordinator.respond('session-2', { id: otherView.id, index: 0, answer: 'SQLite', source: 'option' });
    await expect(other).resolves.toMatchObject({ details: { status: 'answered' } });
    expect(() => coordinator.respond('session-1', { id: firstView.id, index: 0, answer: 'SQLite', source: 'option' })).toThrow();
  });

  it('does not show invalid or duplicate options and enforces bounded IPC input', async () => {
    const { call, coordinator, invalidate } = fixture();
    await expect(call([{ question: 'Pick?', options: [{ label: 'A' }, { label: ' a ' }] }])).rejects.toThrow(/unique/);
    await expect(call([{ question: 'Pick?', options: [{ label: 'A' }, { label: 'Write your own answer...' }] }])).rejects.toThrow(/supplied by the UI/);
    expect(coordinator.get('session-1')).toBeNull();
    invalidate();
    await expect(call()).rejects.toThrow(/live root session/);
    expect(questionnaireAnswerInputSchema.safeParse({ id: crypto.randomUUID(), index: 0, answer: ' ', source: 'custom' }).success).toBe(false);
  });
});
