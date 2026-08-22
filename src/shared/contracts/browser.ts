import { z } from 'zod';

export const BROWSER_MAX_SNAPSHOT_CHARACTERS = 48_000;
export const BROWSER_MAX_ANNOTATIONS = 24;

const browserIdSchema = z.string().trim().min(1).max(160).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  'Browser identifiers cannot contain control characters.',
);
const boundedUrlSchema = z.string().trim().min(1).max(8_192);
const boundedOriginSchema = z.string().trim().min(1).max(2_048);
const bareLocalhostUrlPattern = /^(?:localhost|(?:[a-z\d-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d+)?(?:[/?#]|$)/iu;

/** Normalize a web link that is safe to send to the built-in or system browser. */
export function normalizeBrowserWebUrl(value: string): string | null {
  const input = value.trim();
  if (!input || input.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(input)) return null;
  const candidate = bareLocalhostUrlPattern.test(input) ? `http://${input}` : input;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export const browserWebUrlSchema = z.string().transform((value, context) => {
  const normalized = normalizeBrowserWebUrl(value);
  if (normalized) return normalized;
  context.addIssue({ code: z.ZodIssueCode.custom, message: 'Links must be credential-free HTTP(S) URLs.' });
  return z.NEVER;
});
const finiteNumberSchema = z.number().finite();

export const browserControlLevelSchema = z.enum(['off', 'observe', 'interact']);
export const browserUiModeSchema = z.enum(['agent', 'annotate']);
export const browserDeviceEmulationSchema = z.object({
  width: finiteNumberSchema.int().min(220).max(4_000),
  height: finiteNumberSchema.int().min(320).max(8_000),
  mobile: z.boolean().default(true),
  touch: z.boolean().default(true),
}).strict();
export const browserSetDeviceEmulationInputSchema = z.object({
  emulation: browserDeviceEmulationSchema.nullable(),
}).strict();
export const browserGrantScopeSchema = z.enum(['once', 'task', 'always']);
export const browserOriginGrantSchema = z.object({
  origin: boundedOriginSchema,
  read: z.boolean(),
  interact: z.boolean(),
  scope: browserGrantScopeSchema,
  allowPrivateNetwork: z.boolean().default(false),
}).strict().refine((value) => !value.interact || value.read, 'Interactive browser access also requires read access.');

export const browserBoundsSchema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  width: finiteNumberSchema.nonnegative().max(100_000),
  height: finiteNumberSchema.nonnegative().max(100_000),
}).strict();

export const browserCreateTabInputSchema = z.object({
  tabId: browserIdSchema,
  profileId: browserIdSchema,
  initialUrl: boundedUrlSchema.optional(),
}).strict();
export const browserNewTabInputSchema = z.object({ initialUrl: boundedUrlSchema.optional() }).strict();
export const browserTabIdInputSchema = z.object({ tabId: browserIdSchema }).strict();
export const browserNavigateInputSchema = z.object({
  url: boundedUrlSchema,
}).strict();
export const browserLinkContextMenuInputSchema = z.object({
  url: browserWebUrlSchema,
}).strict();
export const browserLinkContextMenuResultSchema = z.object({ shown: z.literal(true) }).strict();
export const browserSnapshotModeSchema = z.enum(['interactive', 'content', 'full']);
export const browserSnapshotInputSchema = z.object({
  mode: browserSnapshotModeSchema.default('interactive'),
  scopeRef: browserIdSchema.optional(),
  query: z.string().trim().min(1).max(500).optional(),
}).strict();
export const browserVisibilityInputSchema = z.object({ visible: z.boolean() }).strict();
export const browserControlLevelInputSchema = z.object({ level: browserControlLevelSchema }).strict();
export const browserUiModeInputSchema = z.object({ mode: browserUiModeSchema }).strict();
export const browserHistoryInputSchema = z.object({ action: z.enum(['back', 'forward', 'reload', 'stop']) }).strict();
export const browserOriginInputSchema = z.object({ origin: boundedOriginSchema }).strict();
export const browserOverlayInputSchema = z.object({ blocked: z.boolean() }).strict();

export const browserRectSchema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  width: finiteNumberSchema.nonnegative(),
  height: finiteNumberSchema.nonnegative(),
}).strict();

export const semanticNodeSchema = z.object({
  ref: browserIdSchema.optional(),
  role: z.string().max(120),
  name: z.string().max(1_000),
  value: z.string().max(1_000).optional(),
  depth: z.number().int().nonnegative().max(1_000),
  disabled: z.boolean().optional(),
  filled: z.boolean().optional(),
  box: browserRectSchema.optional(),
}).strict();
export const semanticPageSnapshotSchema = z.object({
  tabId: browserIdSchema,
  documentEpoch: z.number().int().nonnegative().safe(),
  revision: z.number().int().positive().safe(),
  url: boundedUrlSchema,
  title: z.string().max(4_000),
  mode: browserSnapshotModeSchema,
  nodes: z.array(semanticNodeSchema).max(4_000),
  serialized: z.string().max(BROWSER_MAX_SNAPSHOT_CHARACTERS),
  nodeCount: z.number().int().nonnegative().max(4_000),
  truncated: z.boolean(),
}).strict();

export const browserConsequenceSchema = z.enum([
  'none', 'account', 'communication', 'destructive', 'financial', 'external-data-transfer',
]);
export const browserActionKindSchema = z.enum([
  'navigate', 'click', 'type', 'press', 'scroll', 'select', 'upload', 'download', 'submit',
]);
export const browserTextClassificationSchema = z.enum(['public', 'personal', 'secret']);
export const proposedBrowserActionSchema = z.object({
  kind: browserActionKindSchema,
  origin: boundedOriginSchema,
  frameOrigin: boundedOriginSchema,
  targetRole: z.string().max(120).optional(),
  targetName: z.string().max(1_000).optional(),
  destinationUrl: boundedUrlSchema.optional(),
  textClassification: browserTextClassificationSchema.optional(),
  consequence: browserConsequenceSchema,
}).strict();
export const browserActionDecisionSchema = z.object({
  outcome: z.enum(['allow', 'confirm', 'block']),
  reason: z.string().min(1).max(1_000),
}).strict();

export const browserClickInputSchema = z.object({
  ref: browserIdSchema,
}).strict();
export const browserTypeInputSchema = z.object({
  ref: browserIdSchema,
  text: z.string().max(100_000),
}).strict();
export const browserPressInputSchema = z.object({
  tabId: browserIdSchema,
  key: z.string().min(1).max(40),
}).strict();
export const browserScrollInputSchema = z.object({
  tabId: browserIdSchema,
  deltaX: finiteNumberSchema.min(-100_000).max(100_000),
  deltaY: finiteNumberSchema.min(-100_000).max(100_000),
}).strict();
export const browserActionResultSchema = z.object({
  tabId: browserIdSchema,
  kind: browserActionKindSchema,
  target: z.string().max(1_200),
  confirmed: z.boolean(),
}).strict();
export const browserTabStateSchema = z.object({
  id: browserIdSchema,
  profileId: browserIdSchema,
  url: boundedUrlSchema,
  title: z.string().max(4_000),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  documentEpoch: z.number().int().nonnegative().safe(),
  semanticAvailable: z.boolean(),
}).strict();
export const browserStateSchema = z.object({
  activeTabId: browserIdSchema.nullable(),
  visible: z.boolean(),
  viewBlocked: z.boolean().default(false),
  sessionFullAccess: z.boolean().default(false),
  controlLevel: browserControlLevelSchema,
  mode: browserUiModeSchema.default('agent'),
  deviceEmulation: browserDeviceEmulationSchema.nullable().default(null),
  tabs: z.array(browserTabStateSchema).max(32),
  grants: z.array(browserOriginGrantSchema).max(256),
}).strict();
export const browserWorkLogActionSchema = z.enum([
  'navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'annotate', 'grant', 'revoke', 'blocked',
]);
export const browserConfirmationSchema = z.object({
  id: z.string().uuid(),
  tabId: browserIdSchema,
  documentEpoch: z.number().int().nonnegative().safe(),
  action: z.object({
    kind: browserActionKindSchema,
    origin: boundedOriginSchema,
    frameOrigin: boundedOriginSchema,
    targetRole: z.string().max(120).optional(),
    targetName: z.string().max(1_000).optional(),
    destinationUrl: boundedUrlSchema.optional(),
    consequence: browserConsequenceSchema,
  }).strict(),
  reason: z.string().min(1).max(1_000),
  expiresAt: z.number().int().positive().safe(),
}).strict();
export const browserConfirmationResponseSchema = z.object({ id: z.string().uuid(), approved: z.boolean() }).strict();
export const browserOperationResultSchema = z.object({ ok: z.boolean() }).strict();
export const browserEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), state: browserStateSchema }).strict(),
  z.object({ type: z.literal('navigation-blocked'), tabId: browserIdSchema, url: boundedUrlSchema, reason: z.string().max(1_000) }).strict(),
  z.object({ type: z.literal('cdp-availability'), tabId: browserIdSchema, available: z.boolean(), reason: z.string().max(1_000).optional() }).strict(),
  z.object({ type: z.literal('work-log'), tabId: browserIdSchema, action: browserWorkLogActionSchema, target: z.string().max(1_200), timestamp: z.number().int().nonnegative().safe() }).strict(),
  z.object({
    type: z.literal('annotation-created'),
    projectPath: z.string().min(1).max(32_000),
    sessionId: browserIdSchema,
    annotation: z.lazy(() => browserAnnotationSchema),
  }).strict(),
  z.object({ type: z.literal('annotation-error'), message: z.string().min(1).max(1_000) }).strict(),
  z.object({ type: z.literal('confirmation-requested'), confirmation: browserConfirmationSchema }).strict(),
  z.object({ type: z.literal('confirmation-cleared'), id: z.string().uuid(), approved: z.boolean() }).strict(),
]);
export const browserEventBatchSchema = z.array(browserEventSchema).min(1).max(100);

export const browserAnnotationKindSchema = z.enum(['element', 'region', 'text', 'style', 'asset']);
export const browserAnnotationSchema = z.object({
  id: browserIdSchema,
  tabId: browserIdSchema,
  url: boundedUrlSchema,
  origin: boundedOriginSchema,
  documentEpoch: z.number().int().nonnegative().safe(),
  pageRevision: z.number().int().positive().safe(),
  kind: browserAnnotationKindSchema,
  target: z.object({
    frameId: browserIdSchema,
    backendNodeId: z.number().int().positive().safe().optional(),
    semanticRef: browserIdSchema.optional(),
    role: z.string().max(120).optional(),
    accessibleName: z.string().max(1_000).optional(),
    tagName: z.string().max(120).optional(),
    rectCssPx: browserRectSchema,
    rectNormalized: browserRectSchema,
    locatorHints: z.record(z.string().max(500)).default({}),
    fingerprint: z.object({
      attributesHash: z.string().max(128),
      nearbyTextHash: z.string().max(128),
      ancestorHash: z.string().max(128),
    }).strict(),
  }).strict(),
  comment: z.string().trim().max(8_000),
  domExcerpt: z.string().max(8_000).optional(),
  computedStyle: z.record(z.string().max(2_000)).optional(),
  semanticCoverage: z.number().min(0).max(1),
  reattachConfidence: z.number().min(0).max(1),
  createdAt: z.number().int().nonnegative().safe(),
}).strict();
export const browserAnnotationReferenceSchema = z.object({ id: browserIdSchema }).strict();
export const browserAnnotationCreateInputSchema = z.object({
  kind: z.enum(['element', 'region']),
  comment: z.string().trim().max(8_000).default(''),
}).strict();
export const browserAnnotationRemoveInputSchema = z.object({ id: browserIdSchema }).strict();
export const browserAnnotationDismissInputSchema = z.object({
  ids: z.array(browserIdSchema).min(1).max(BROWSER_MAX_ANNOTATIONS),
}).strict();
export const browserAnnotationUpdateInputSchema = z.object({
  id: browserIdSchema,
  comment: z.string().trim().max(8_000),
}).strict();
export const browserAnnotationListSchema = z.array(browserAnnotationSchema).max(500);

export type BrowserControlLevel = z.infer<typeof browserControlLevelSchema>;
export type BrowserUiMode = z.infer<typeof browserUiModeSchema>;
export type BrowserDeviceEmulation = z.infer<typeof browserDeviceEmulationSchema>;
export type BrowserOriginGrant = z.infer<typeof browserOriginGrantSchema>;
export type BrowserBounds = z.infer<typeof browserBoundsSchema>;
export type BrowserSnapshotMode = z.infer<typeof browserSnapshotModeSchema>;
export type SemanticNode = z.infer<typeof semanticNodeSchema>;
export type SemanticPageSnapshot = z.infer<typeof semanticPageSnapshotSchema>;
export type BrowserConsequence = z.infer<typeof browserConsequenceSchema>;
export type BrowserTextClassification = z.infer<typeof browserTextClassificationSchema>;
export type ProposedBrowserAction = z.infer<typeof proposedBrowserActionSchema>;
export type BrowserActionDecision = z.infer<typeof browserActionDecisionSchema>;
export type BrowserActionResult = z.infer<typeof browserActionResultSchema>;
export type BrowserTabState = z.infer<typeof browserTabStateSchema>;
export type BrowserState = z.infer<typeof browserStateSchema>;
export type BrowserEvent = z.infer<typeof browserEventSchema>;
export type BrowserConfirmation = z.infer<typeof browserConfirmationSchema>;
export type BrowserWorkLogAction = z.infer<typeof browserWorkLogActionSchema>;
export type BrowserAnnotation = z.infer<typeof browserAnnotationSchema>;
