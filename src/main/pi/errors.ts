import { z } from 'zod';
import type { AppError } from '../../shared/contracts/ipc';

const zodMessage = (error: z.ZodError) => error.issues.map((issue) => issue.message).join('; ');

export function normalizeError(error: unknown, fallbackCode: AppError['code'] = 'PI_RUNTIME_ERROR'): AppError {
  if (isAppError(error)) return error;
  if (error instanceof z.ZodError) {
    return { code: 'INVALID_REQUEST', message: zodMessage(error), retryable: false };
  }
  const message = error instanceof Error
    ? error.message || error.name
    : typeof error === 'string' && error.trim()
      ? error.trim()
      : null;
  if (!message) return { code: 'UNKNOWN', message: 'An unknown error occurred.', retryable: true };

  const lower = message.toLowerCase();
  if ((error instanceof Error && error.name === 'AbortError') || lower.includes('aborted')) {
    return { code: 'ABORTED', message: 'The active Pi run was stopped.', retryable: true };
  }
  if (lower.includes('nothing to compact') || lower.includes('already compacted')) {
    return {
      code: 'INVALID_REQUEST',
      message: lower.includes('already compacted') ? 'This conversation is already compacted.' : 'There is not enough conversation context to compact yet.',
      actionable: 'Continue working, then compact when the session has more history.',
      retryable: true,
    };
  }
  if (
    lower.includes('api key')
    || lower.includes('authentication')
    || lower.includes('auth configured')
    || lower.includes('unauthorized')
    || lower.includes('401')
  ) {
    return authRequiredError();
  }
  return { code: fallbackCode, message, retryable: true };
}

export function authRequiredError(): AppError {
  return {
    code: 'AUTH_REQUIRED',
    message: 'Pi could not find authentication for an available model provider.',
    actionable: 'Open the Pi CLI, run /login, then reopen this project. Environment credentials supported by Pi also work.',
    retryable: true,
  };
}

function isAppError(value: unknown): value is AppError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AppError>;
  return typeof candidate.code === 'string' && typeof candidate.message === 'string' && typeof candidate.retryable === 'boolean';
}

export class PiDesktopError extends Error {
  constructor(readonly normalized: AppError) {
    super(normalized.message);
    this.name = 'PiDesktopError';
  }
}
