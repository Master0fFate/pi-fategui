import { z } from 'zod';
import { themeColorsSchema, themeDefinitionSchema } from './themes';
import { skinFontManifestSchema, skinFontDefinitionSchema } from './skinFonts';
import { skinAppearanceManifestSchema, skinAppearanceSchema, skinStylesSchema } from './skinStyles';

export const MAX_SKIN_PACKS = 16;
export const MAX_SKIN_MANIFEST_BYTES = 32 * 1024;
export const MAX_SKIN_V2_MANIFEST_BYTES = 6 * 1024 * 1024;
export const MAX_SKIN_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_SKIN_MASK_BYTES = 128 * 1024;
const safeText = (maximum: number) => z.string().trim().min(1).max(maximum).regex(/^[^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u, 'Control characters are not allowed.');
export const builtInSkinIdSchema = z.enum(['default', 'dreamcore']);
export type BuiltInSkinId = z.infer<typeof builtInSkinIdSchema>;
export const skinPackFolderIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).refine((id) => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9]|default|dreamcore|angelcore)$/u.test(id), 'This pack ID is reserved.');
export const skinPackIdSchema = z.string().startsWith('pack:').max(37).refine((id) => skinPackFolderIdSchema.safeParse(id.slice(5)).success, 'Invalid skin pack ID.');
const strictSkinIdSchema = z.union([builtInSkinIdSchema, skinPackIdSchema]);
export const skinIdSchema = strictSkinIdSchema.catch('default');
export type SkinId = z.infer<typeof skinIdSchema>;

export const skinLayoutSchema = z.object({
  contentWidth: z.number().int().min(720).max(1120).optional(),
  contentPadding: z.number().int().min(16).max(48).optional(),
  controlRadius: z.number().int().min(0).max(8).optional(),
  ruleContrast: z.enum(['subtle', 'strong']).optional(),
}).strict();
const backgroundOpacity = z.union([z.literal(0.06), z.literal(0.1), z.literal(0.16)]).default(0.1);
const backgroundManifest = z.union([
  z.object({ file: z.literal('background.png'), opacity: backgroundOpacity }).strict(),
  z.object({ data: z.string().min(1).max(Math.ceil(MAX_SKIN_IMAGE_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/u), opacity: backgroundOpacity }).strict(),
]);
export const skinPackManifestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  id: skinPackFolderIdSchema,
  name: safeText(48),
  version: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.-]{1,20})?$/u),
  description: safeText(240),
  author: safeText(80).optional(),
  base: builtInSkinIdSchema,
  layout: skinLayoutSchema.optional(),
  palette: z.object({ tone: z.enum(['dark', 'light']), colors: themeColorsSchema }).strict().optional(),
  background: backgroundManifest.optional(),
  fonts: z.array(skinFontManifestSchema).max(2).optional(),
  appearance: skinAppearanceManifestSchema.optional(),
  styles: skinStylesSchema.optional(),
}).strict().superRefine((pack, context) => {
  if (pack.schemaVersion === 1 && (pack.fonts || pack.appearance || pack.styles || (pack.background && 'data' in pack.background))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Fonts, embedded images, and appearance presets require schemaVersion 2.' });
  }
  const fonts = pack.fonts ?? [];
  if (new Set(fonts.map((font) => font.id)).size !== fonts.length || new Set(fonts.map((font) => font.file)).size !== fonts.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Font IDs and filenames must be unique.' });
  for (const role of ['interfaceFont', 'codeFont'] as const) {
    const value = pack.appearance?.[role];
    if (value?.startsWith('local:') && !fonts.some((font) => font.id === value.slice(6) && (role !== 'codeFont' || font.monospace))) context.addIssue({ code: z.ZodIssueCode.custom, path: ['appearance', role], message: 'Declare the local font; code fonts must be marked monospace.' });
  }
});
export type SkinPackManifest = z.infer<typeof skinPackManifestSchema>;

export const skinDefinitionSchema = z.object({
  id: strictSkinIdSchema,
  name: safeText(48),
  description: safeText(240),
  base: builtInSkinIdSchema,
  origin: z.enum(['built-in', 'pack']),
  version: z.string().max(32).optional(),
  author: safeText(80).optional(),
  layout: skinLayoutSchema.optional(),
  appearance: skinAppearanceSchema.optional(),
  styles: skinStylesSchema.optional(),
  fonts: z.array(skinFontDefinitionSchema).max(2).optional(),
  palette: themeDefinitionSchema.optional(),
  background: z.object({
    data: z.string().min(1).max(Math.ceil(MAX_SKIN_MASK_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
    opacity: z.union([z.literal(0.06), z.literal(0.1), z.literal(0.16)]),
  }).strict().optional(),
}).strict().refine((skin) => skin.origin === 'built-in' ? skin.id === skin.base : skin.id.startsWith('pack:'), 'Skin origin and ID must agree.');
export type SkinDefinition = z.infer<typeof skinDefinitionSchema>;
export const skinCatalogSchema = z.object({
  skins: z.array(skinDefinitionSchema).min(2).max(MAX_SKIN_PACKS + 2),
  storagePath: z.string().max(4096),
  diagnostics: z.array(z.string().max(500)).max(MAX_SKIN_PACKS + 1),
}).strict();
export type SkinCatalog = z.infer<typeof skinCatalogSchema>;
export const skinPackRequestSchema = z.object({ id: skinPackIdSchema }).strict();
export const skinImportResultSchema = z.object({ catalog: skinCatalogSchema, importedId: skinPackIdSchema }).strict().nullable();
export const skinExportResultSchema = z.object({ path: z.string().max(4096) }).strict().nullable();

export const builtInSkins: readonly SkinDefinition[] = [
  { id: 'default', base: 'default', origin: 'built-in', name: 'Default', description: 'The focused, continuous Fate UI workbench.' },
  { id: 'dreamcore', base: 'dreamcore', origin: 'built-in', name: 'Angelcore', description: 'Terminal-style controls, command input, and an open transcript.', appearance: { interfaceFont: 'jetbrains-mono' }, styles: { normal: { sidebar: { padding: 14 }, settings: { padding: 18 }, music: { padding: 12 }, tooltips: { padding: 8 } }, compact: { sidebar: { padding: 8 }, settings: { padding: 12 }, music: { padding: 8 } } } },
];
export function builtInSkinName(id: BuiltInSkinId): string { return builtInSkins.find((skin) => skin.id === id)!.name; }
export function resolveSkinId(value: unknown): SkinId { return skinIdSchema.parse(value); }
export function skinPackThemeId(id: string): string { return `pack-${skinPackIdSchema.parse(id).slice(5)}`; }
