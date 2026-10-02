import { z } from 'zod';
/** Process-start/host-profile choice. Never accepted from workspace or request data. */
export const statePersistenceBackendSchema = z.enum(['legacy-json', 'native-durable']);
export type StatePersistenceBackend = z.infer<typeof statePersistenceBackendSchema>;
export function resolveStatePersistenceBackend(value: unknown): StatePersistenceBackend {
  return statePersistenceBackendSchema.parse(value === undefined ? 'legacy-json' : value);
}
