import { z } from 'zod';
import type { AppSettings } from '../contracts/ipc';

/** Client-owned presentation only. Never merge an untrusted object into SettingsService.set. */
export const clientPreferencesSchema = z.object({
  appearance: z.enum(['dark', 'system']),
  themeId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/u),
  reduceMotion: z.boolean(),
  performanceMode: z.boolean(),
  compactMode: z.boolean(),
  compactSessions: z.boolean(),
  sendMessageWithModifier: z.boolean(),
}).strict();
export type ClientPreferences = z.infer<typeof clientPreferencesSchema>;
export const clientPreferencesUpdateSchema = clientPreferencesSchema.partial().strict();

/** This allowlist is a one-way copy of legacy desktop appearance defaults. */
export function projectClientPreferences(settings: AppSettings): ClientPreferences {
  return clientPreferencesSchema.parse({
    appearance: settings.appearance,
    themeId: settings.themeId,
    reduceMotion: settings.reduceMotion,
    performanceMode: settings.performanceMode,
    compactMode: settings.compactMode,
    compactSessions: settings.compactSessions,
    sendMessageWithModifier: settings.sendMessageWithModifier,
  });
}

/** No host write: callers persist this result on the client, not in the host settings service. */
export function updateClientPreferences(current: ClientPreferences, input: unknown): ClientPreferences {
  const update = clientPreferencesUpdateSchema.parse(input);
  return clientPreferencesSchema.parse({ ...clientPreferencesSchema.parse(current), ...update });
}
