import { z } from 'zod';

export const ipcChannels = {
  systemGetInfo: 'system:get-info',
} as const;

export const getAppInfoInputSchema = z.object({}).strict();

export const appInfoSchema = z.object({
  name: z.literal('Pi Desktop'),
  version: z.string().min(1),
  platform: z.enum(['win32', 'darwin', 'linux']),
  packaged: z.boolean(),
});

export type AppInfo = z.infer<typeof appInfoSchema>;

export interface PiDesktopApi {
  getAppInfo: () => Promise<AppInfo>;
}
