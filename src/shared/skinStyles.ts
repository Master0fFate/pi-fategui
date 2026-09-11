import { z } from 'zod';
import { builtInCodeFontSchema, builtInInterfaceFontSchema, codeFontSchema, interfaceFontSchema, localFontReferenceSchema } from './skinFonts';

export const skinSurfaceNames = ['global', 'shell', 'sidebar', 'conversation', 'composer', 'queue', 'tasks', 'goal', 'agents', 'tools', 'activity', 'notifications', 'context', 'resources', 'music', 'settings', 'dialogs', 'modelPicker', 'tooltips', 'files', 'changes', 'browser', 'learning', 'automations'] as const;
export type SkinSurfaceName = typeof skinSurfaceNames[number];
export const skinSurfaceStyleSchema = z.object({
  controlRadius: z.number().int().min(0).max(12).optional(),
  surfaceRadius: z.number().int().min(0).max(16).optional(),
  padding: z.number().int().min(4).max(24).optional(),
  rowHeight: z.number().int().min(24).max(48).optional(),
  fontSize: z.number().int().min(11).max(16).optional(),
  surface: z.enum(['canvas', 'panel', 'raised']).optional(),
  border: z.enum(['border', 'borderStrong', 'textSoft']).optional(),
}).strict();
const surfaceMap = z.object(Object.fromEntries(skinSurfaceNames.map((name) => [name, skinSurfaceStyleSchema.optional()])) as Record<SkinSurfaceName, z.ZodOptional<typeof skinSurfaceStyleSchema>>).strict();
export const skinStylesSchema = z.object({ normal: surfaceMap.optional(), compact: surfaceMap.optional(), compactSessions: surfaceMap.optional() }).strict();
export type SkinStyles = z.infer<typeof skinStylesSchema>;
export type SkinSurfaceStyle = z.infer<typeof skinSurfaceStyleSchema>;
const visualFlags = { compactMode: z.boolean().optional(), compactSessions: z.boolean().optional(), performanceMode: z.boolean().optional(), reduceMotion: z.boolean().optional(), holyShitMode: z.boolean().optional() };
export const skinAppearanceSchema = z.object({ interfaceFont: interfaceFontSchema.optional(), codeFont: codeFontSchema.optional(), ...visualFlags }).strict();
export const skinAppearanceManifestSchema = z.object({
  interfaceFont: z.union([builtInInterfaceFontSchema, localFontReferenceSchema]).optional(),
  codeFont: z.union([builtInCodeFontSchema, localFontReferenceSchema]).optional(),
  ...visualFlags,
}).strict();
export type SkinAppearance = z.infer<typeof skinAppearanceSchema>;
export const skinAppearanceOverridesSchema = z.record(z.string().regex(/^(default|dreamcore|pack:[a-z][a-z0-9-]{1,31})$/u), skinAppearanceSchema).refine((value) => Object.keys(value).length <= 18, 'At most 18 skin preferences can be retained.');
