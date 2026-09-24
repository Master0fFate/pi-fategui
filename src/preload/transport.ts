import { ipcRenderer } from 'electron';
import { z } from 'zod';
import { ipcChannels } from '../shared/contracts/ipc';

type Channel = typeof ipcChannels[keyof typeof ipcChannels];

export const ignoreResult = z.unknown().transform(() => undefined);
export const discardResult = <S extends z.ZodTypeAny>(schema: S) => schema.transform(() => undefined);

export async function invoke<S extends z.ZodTypeAny>(channel: Channel, inputSchema: z.ZodTypeAny, outputSchema: S, ...input: [] | [unknown]): Promise<z.output<S>> {
  const result: unknown = await ipcRenderer.invoke(channel, inputSchema.parse(input.length ? input[0] : {}));
  return outputSchema.parse(result);
}

export function subscribe<S extends z.ZodTypeAny>(channel: Channel, schema: S, listener: (payload: z.output<S>) => void, onInvalid?: (error: z.ZodError) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
    if (!onInvalid) {
      listener(schema.parse(payload));
      return;
    }
    const parsed = schema.safeParse(payload);
    if (parsed.success) listener(parsed.data);
    else onInvalid(parsed.error);
  };
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

export function unwrapResult<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
