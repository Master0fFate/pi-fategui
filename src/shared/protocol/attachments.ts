import { z } from 'zod';

/** Text-only transport DTOs. An authenticated adapter creates scope; JSON never grants ownership. */
export const TEXT_ATTACHMENT_BYTES = 256 * 1024;
export const TEXT_ATTACHMENT_TOTAL_BYTES = 2 * 1024 * 1024;
export const TEXT_ATTACHMENT_COUNT = 8;
export const TEXT_ATTACHMENT_TTL_MS = 5 * 60_000;
export const TEXT_ATTACHMENT_REQUEST_BYTES = 1024 * 1024;

export const attachmentScopeSchema = z.object({
  principalId: z.string().min(1).max(250), clientId: z.string().min(1).max(250),
  workspaceId: z.string().uuid(), workspaceGeneration: z.number().int().nonnegative().safe(),
  sessionId: z.string().uuid(), serverEpoch: z.string().uuid(),
}).strict();
export type AttachmentScope = z.infer<typeof attachmentScopeSchema>;

// The encoded length is bounded before decoding; canonical base64 forbids alternate byte encodings.
export const attachmentNameSchema = z.string().min(1).max(255).refine((name) => !/[\\/:\u0000-\u001f\u007f]/u.test(name)).refine(isStrictUnicode);
export function isStrictUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return !text.includes('\0');
}
export const textAttachmentInputSchema = z.object({
  name: attachmentNameSchema.optional(),
  contentType: z.literal('text/plain'), encoding: z.literal('base64'),
  data: z.string().min(1).max(4 * Math.ceil(TEXT_ATTACHMENT_BYTES / 3))
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
}).strict();
export const textAttachmentIdSchema = z.string().regex(/^ta1_[A-Za-z0-9_-]{43}$/u);
export const textAttachmentReceiptSchema = z.object({
  attachmentId: textAttachmentIdSchema, byteLength: z.number().int().min(1).max(TEXT_ATTACHMENT_BYTES),
  expiresAt: z.number().int().positive().safe(),
}).strict();
export type TextAttachmentReceipt = z.infer<typeof textAttachmentReceiptSchema>;
const projectTextExtensions = new Set(['txt', 'md', 'mdx', 'rst', 'csv', 'tsv', 'log', 'json', 'jsonl', 'json5', 'yaml', 'yml',
  'toml', 'ini', 'conf', 'cfg', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp',
  'cs', 'java', 'kt', 'kts', 'swift', 'sh', 'bash', 'ps1', 'sql', 'css', 'scss', 'less', 'html', 'htm', 'xml']);
const projectTextDotfiles = new Set(['.env', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc']);
export function isSupportedProjectTextReference(value: string): boolean {
  const leaf = (value.split('/').at(-1) ?? '').toLowerCase();
  if (projectTextDotfiles.has(leaf) || leaf.startsWith('.env.')) return true;
  const dot = leaf.lastIndexOf('.');
  return dot < 0 || projectTextExtensions.has(leaf.slice(dot + 1));
}
export const projectFileReferenceSchema = z.string().min(1).max(4096).refine((value) => !value.includes('\\')
  && !value.startsWith('/') && !value.includes(':') && !/[\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')).refine(isStrictUnicode).refine(isSupportedProjectTextReference);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
export const networkPromptInputSchema = z.object({
  text: z.string().trim().min(1).max(200_000).refine(isStrictUnicode),
  attachments: z.array(textAttachmentIdSchema).max(TEXT_ATTACHMENT_COUNT).refine(unique).optional(),
  projectFiles: z.array(projectFileReferenceSchema).max(TEXT_ATTACHMENT_COUNT).refine(unique).optional(),
}).strict().refine((input) => (input.attachments?.length ?? 0) + (input.projectFiles?.length ?? 0) <= TEXT_ATTACHMENT_COUNT);
export const textUploadDisplaySchema = z.object({ name: attachmentNameSchema,
  text: z.string().min(1).max(TEXT_ATTACHMENT_BYTES).refine(isStrictUnicode)
    .refine((text) => new TextEncoder().encode(text).length <= TEXT_ATTACHMENT_BYTES) }).strict();
