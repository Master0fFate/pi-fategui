import { z } from 'zod';

export const MAX_SKIN_FONT_BYTES = 256 * 1024;
export const builtInInterfaceFontSchema = z.enum(['noto-sans', 'system', 'inter', 'poppins', 'montserrat', 'jetbrains-mono']);
export const builtInCodeFontSchema = z.enum(['jetbrains-mono', 'noto-sans-mono', 'system-mono']);
export type BuiltInInterfaceFont = z.infer<typeof builtInInterfaceFontSchema>;
export type BuiltInCodeFont = z.infer<typeof builtInCodeFontSchema>;
export const localFontIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/u);
export const skinFontIdSchema = z.string().regex(/^skin-font:[a-z][a-z0-9-]{1,31}:[a-z][a-z0-9-]{0,23}$/u);
export const interfaceFontSchema = z.union([builtInInterfaceFontSchema, skinFontIdSchema]);
export const codeFontSchema = z.union([builtInCodeFontSchema, skinFontIdSchema]);
export const localFontReferenceSchema = z.string().regex(/^local:[a-z][a-z0-9-]{0,23}$/u);
export const skinFontManifestSchema = z.object({
  id: localFontIdSchema,
  name: z.string().trim().min(1).max(48).regex(/^[^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u),
  file: z.string().regex(/^[a-z][a-z0-9-]{0,23}\.woff2?$/u),
  monospace: z.boolean().default(false),
}).strict();
export const skinFontDefinitionSchema = z.object({
  id: skinFontIdSchema,
  name: skinFontManifestSchema.shape.name,
  format: z.enum(['woff', 'woff2']),
  monospace: z.boolean(),
  data: z.string().min(1).max(Math.ceil(MAX_SKIN_FONT_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
}).strict();
export type SkinFontDefinition = z.infer<typeof skinFontDefinitionSchema>;
export function packFontId(pack: string, local: string): string { return `skin-font:${pack}:${local}`; }
