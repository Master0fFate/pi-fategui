import { expect } from 'vitest';

/** A transport supplies its trusted identity. No case contains a client-chosen owner ID. */
export interface AbortContractTransport {
  abort(): Promise<{ aborted: boolean }>;
  calls(): number;
}

export async function runAbortContract(transport: AbortContractTransport): Promise<void> {
  const before = transport.calls();
  expect(await transport.abort()).toEqual({ aborted: true });
  expect(transport.calls()).toBe(before + 1);
}

/** The next transport can project a wire receipt to its own public result. */
export async function runPromptContract(transport: { prompt(text: string): Promise<{ accepted: boolean }>;
  calls(): number }): Promise<void> {
  const before = transport.calls();
  expect(await transport.prompt('contract prompt')).toMatchObject({ accepted: true });
  expect(transport.calls()).toBe(before + 1);
}

export async function runSelectionContract(transport: { select(sessionId: string): Promise<{ sessionId: string | null }>;
  calls(): number }, sessionId: string): Promise<void> {
  const before = transport.calls();
  expect(await transport.select(sessionId)).toMatchObject({ sessionId });
  expect(transport.calls()).toBe(before + 1);
}
