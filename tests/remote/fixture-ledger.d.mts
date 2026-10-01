export function appendInvocationLedger(file: string, entries: readonly unknown[]): Promise<void>;
export function readInvocationLedger(file: string): Promise<{ kind: string; [key: string]: unknown }[]>;
