import { randomUUID } from 'node:crypto';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { PendingQuestionnaire, QuestionnaireAnswerInput } from '../../shared/contracts/ipc';

const MAX_QUESTIONS = 8;
const MAX_ANSWER_LENGTH = 2_000;

type Question = { question: string; options: Array<{ label: string; description?: string }> };
type Answer = { index: number; question: string; answer: string; source: 'option' | 'custom' };
type Pending = {
  view: PendingQuestionnaire;
  resolve: (answer: Answer | null) => void;
};

/** One outstanding question per root session. Results retain the original question order. */
export class QuestionnaireCoordinator {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly changed: (sessionId: string) => void) {}

  get(sessionId: string): PendingQuestionnaire | null {
    return this.pending.get(sessionId)?.view ?? null;
  }

  cancel(sessionId: string): boolean {
    const current = this.pending.get(sessionId);
    if (!current) return false;
    this.pending.delete(sessionId);
    current.resolve(null);
    this.changed(sessionId);
    return true;
  }

  respond(sessionId: string, input: QuestionnaireAnswerInput): void {
    const current = this.pending.get(sessionId);
    if (!current || current.view.id !== input.id || current.view.index !== input.index) {
      throw new Error('That question is no longer active.');
    }
    const answer = input.answer.trim();
    if (!answer || answer.length > MAX_ANSWER_LENGTH) throw new Error('Enter a shorter, non-empty answer.');
    if (input.source === 'option' && !current.view.options.some((option) => option.label === answer)) {
      throw new Error('Select one of the current answers.');
    }
    this.pending.delete(sessionId);
    current.resolve({ index: input.index, question: current.view.question, answer, source: input.source });
    this.changed(sessionId);
  }

  createTool(isCurrent: (sessionId: string) => boolean): ToolDefinition {
    return defineTool({
      name: 'ask_user_question',
      label: 'Ask user question',
      promptSnippet: 'Ask the user ordered multiple-choice questions and wait for their answers',
      description: 'Ask the user one or more ordered single-choice questions when their preference is needed. Each question has 2–4 options; the UI always adds “Write your own answer...”. Waits for the user and returns their answers in the same order. Do not use for rhetorical questions.',
      parameters: Type.Object({
        questions: Type.Array(Type.Object({
          question: Type.String({ minLength: 1, maxLength: 500, description: 'The exact question to show the user.' }),
          options: Type.Array(Type.Object({
            label: Type.String({ minLength: 1, maxLength: 100 }),
            description: Type.Optional(Type.String({ maxLength: 160 })),
          }, { additionalProperties: false }), { minItems: 2, maxItems: 4 }),
        }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_QUESTIONS }),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const sessionId = ctx.sessionManager.getSessionId();
        const questions: Question[] = params.questions.map((item) => ({
          question: item.question.trim(),
          options: item.options.map((option) => ({ label: option.label.trim(), ...(option.description ? { description: option.description.trim() } : {}) })),
        }));
        for (const item of questions) {
          if (!item.question || item.options.some((option) => !option.label)
            || new Set(item.options.map((option) => option.label.toLocaleLowerCase())).size !== item.options.length
            || item.options.some((option) => option.label.toLocaleLowerCase() === 'write your own answer...')) {
            throw new Error('Each question needs text and unique, non-empty answer labels. “Write your own answer...” is supplied by the UI.');
          }
        }
        if (!isCurrent(sessionId) || this.pending.has(sessionId)) throw new Error('A live root session with no active question is required.');
        const answers: Answer[] = [];
        const abort = () => this.cancel(sessionId);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          for (const [index, question] of questions.entries()) {
            if (signal?.aborted || !isCurrent(sessionId)) break;
            const answer = await new Promise<Answer | null>((resolve) => {
              const view: PendingQuestionnaire = {
                id: randomUUID(), sessionId, index, total: questions.length,
                question: question.question, options: question.options,
              };
              this.pending.set(sessionId, { view, resolve });
              this.changed(sessionId);
              if (signal?.aborted || !isCurrent(sessionId)) this.cancel(sessionId);
            });
            if (!answer) break;
            answers.push(answer);
          }
        } finally {
          signal?.removeEventListener('abort', abort);
          this.cancel(sessionId);
        }
        const result = answers.length === questions.length
          ? { status: 'answered' as const, answers }
          : { status: 'cancelled' as const, answers: [] as Answer[] };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
      },
    });
  }
}
