import type { BrowserSnapshotMode, SemanticNode, SemanticPageSnapshot } from '../../shared/contracts/browser';
import { BROWSER_MAX_SNAPSHOT_CHARACTERS, semanticPageSnapshotSchema } from '../../shared/contracts/browser';
import type { BrowserCdpClient } from './CdpClient';
import { BrowserError } from './BrowserErrors';
import { BrowserRefRegistry, fingerprintHash, type BrowserElementFingerprint } from './BrowserRefRegistry';

const SEMANTIC_VISIBILITY_STYLE_PROPERTIES = ['display', 'visibility', 'opacity'] as const;

export const SNAPSHOT_STYLE_PROPERTIES = [
  ...SEMANTIC_VISIBILITY_STYLE_PROPERTIES, 'position', 'overflow', 'width', 'height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap',
  'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-radius',
] as const;

interface CdpValue { value?: unknown }
interface AxProperty { name: string; value?: CdpValue }
interface AxNode {
  nodeId: string;
  ignored?: boolean;
  parentId?: string;
  backendDOMNodeId?: number;
  role?: CdpValue;
  name?: CdpValue;
  value?: CdpValue;
  properties?: AxProperty[];
}
interface AxTreeResult { nodes: AxNode[] }
interface DomNodes {
  parentIndex?: number[];
  backendNodeId?: number[];
  nodeName?: number[];
  attributes?: number[][];
}
interface DomLayout { nodeIndex?: number[]; bounds?: number[][]; styles?: number[][] }
interface DomDocument {
  documentURL?: number;
  frameId?: number;
  nodes?: DomNodes;
  layout?: DomLayout;
}
interface DomSnapshotResult { strings: string[]; documents: DomDocument[] }
interface FrameTreeResult {
  frameTree?: { frame: { id: string; loaderId?: string }; childFrames?: FrameTreeResult['frameTree'][] };
}
interface LayoutMetricsResult {
  cssVisualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number };
}
interface TargetListResult { targetInfos?: Array<{ type?: string }> }

interface DomDetails {
  backendNodeId: number;
  frameId: string;
  origin: string;
  tagName: string;
  attributes: Record<string, string>;
  box?: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

const ACTIONABLE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem', 'option', 'radio',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
]);
const CONTENT_CHROME_ROLES = new Set(['banner', 'navigation', 'complementary']);
const SECRET_AUTOCOMPLETE = /(?:^|\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(?:-month|-year)?)(?:\s|$)/iu;
const SECRET_ATTRIBUTE = /(?:password|passwd|otp|one.?time|secret|token|verification.?code|credit.?card|card.?number|\bcvv\b|\bcvc\b|security.?code|card.?expir|\bpin\b)/iu;

export interface SemanticCaptureInput {
  tabId: string;
  documentEpoch: number;
  url: string;
  title: string;
  mode: BrowserSnapshotMode;
  scopeRef?: string;
  query?: string;
  targetId: string;
  sessionId?: string;
  canReadOrigin?: (origin: string) => boolean;
  oopifOmitted?: boolean;
}

export class SemanticSnapshotEngine {
  private readonly revisions = new Map<string, number>();
  private captureInFlight: Promise<void> | null = null;

  constructor(
    private readonly cdp: BrowserCdpClient,
    private readonly refs: BrowserRefRegistry,
  ) {}

  async capture(input: SemanticCaptureInput): Promise<SemanticPageSnapshot> {
    if (!this.cdp.supports('Accessibility') || !this.cdp.supports('DOMSnapshot')) {
      throw new BrowserError('CDP_UNAVAILABLE', 'This Chromium build does not provide the semantic snapshot domains.', true);
    }
    if (this.captureInFlight) throw new BrowserError('ACTION_BLOCKED', 'A semantic snapshot is already being captured.', true);
    this.refs.beginDocument(input.tabId, input.documentEpoch);
    const operation = Promise.all([
      this.cdp.send<AxTreeResult>('Accessibility.getFullAXTree'),
      this.cdp.send<DomSnapshotResult>('DOMSnapshot.captureSnapshot', {
        computedStyles: [...SEMANTIC_VISIBILITY_STYLE_PROPERTIES], includeDOMRects: true,
      }),
      this.cdp.send<FrameTreeResult>('Page.getFrameTree'),
      this.cdp.send<LayoutMetricsResult>('Page.getLayoutMetrics'),
      this.cdp.supports('Target')
        ? this.cdp.send<TargetListResult>('Target.getTargets').catch(() => ({ targetInfos: [] }))
        : Promise.resolve({ targetInfos: [] } as TargetListResult),
    ]);
    const tracked = operation.then(() => undefined, () => undefined).finally(() => {
      if (this.captureInFlight === tracked) this.captureInFlight = null;
    });
    this.captureInFlight = tracked;
    const [axResult, domResult, frameTree, metrics, targets] = await withTimeout(
      operation,
      10_000,
      'The semantic page snapshot timed out.',
    );
    return this.compact({
      ...input,
      oopifOmitted: targets.targetInfos?.some((target) => target.type === 'iframe') ?? false,
    }, axResult, domResult, frameTree, metrics);
  }

  compact(
    input: SemanticCaptureInput,
    axResult: AxTreeResult,
    domResult: DomSnapshotResult,
    frameTree: FrameTreeResult = {},
    metrics: LayoutMetricsResult = {},
  ): SemanticPageSnapshot {
    const limits = limitsFor(input.mode);
    const domByBackendId = indexDom(domResult);
    const loadersByFrame = indexFrameLoaders(frameTree.frameTree);
    const axById = new Map(axResult.nodes.map((node) => [node.nodeId, node]));
    const scopeBackendId = input.scopeRef
      ? this.refs.resolve(input.scopeRef, { tabId: input.tabId, documentEpoch: input.documentEpoch }).backendNodeId
      : undefined;
    const scopeAxId = scopeBackendId === undefined
      ? undefined
      : axResult.nodes.find((node) => node.backendDOMNodeId === scopeBackendId)?.nodeId;
    const query = input.query?.toLocaleLowerCase();
    const candidates: SemanticNode[] = [];
    let omitted = 0;

    for (const axNode of axResult.nodes) {
      if (axNode.ignored || !axNode.backendDOMNodeId) continue;
      if (scopeAxId && !isAxDescendant(axNode, scopeAxId, axById)) continue;
      const dom = domByBackendId.get(axNode.backendDOMNodeId);
      if (!dom) continue;
      if (input.canReadOrigin && !input.canReadOrigin(dom.origin)) continue;

      const role = textValue(axNode.role) || inferRole(dom);
      const rawName = boundedText(textValue(axNode.name), limits.maxTextPerNode);
      const rawValue = boundedText(textValue(axNode.value), limits.maxTextPerNode);
      const name = redactPotentialSecretText(rawName, limits.maxTextPerNode);
      const safeValue = redactPotentialSecretText(rawValue, limits.maxTextPerNode);
      const properties = new Map((axNode.properties ?? []).map((property) => [property.name, property.value?.value]));
      const secret = isSecretNode(role, rawName, dom.attributes, properties);
      if (!includeNode(input.mode, role, name, dom, safeValue, metrics.cssVisualViewport)) continue;
      const searchableValue = secret ? '' : safeValue;
      if (query && !`${role}\n${name}\n${searchableValue}`.toLocaleLowerCase().includes(query)) continue;

      const disabled = properties.get('disabled') === true;
      const interactive = ACTIONABLE_ROLES.has(role) || dom.attributes.contenteditable === 'true';
      const fingerprint = createFingerprint(axNode, dom, role, rawName, axById);
      const ref = interactive
        ? this.refs.register({
            tabId: input.tabId,
            targetId: input.targetId,
            sessionId: input.sessionId ?? '',
            frameId: dom.frameId,
            frameOrigin: dom.origin,
            documentEpoch: input.documentEpoch,
            frameEpoch: input.documentEpoch,
            loaderId: loadersByFrame.get(dom.frameId) ?? `epoch:${input.documentEpoch}`,
            backendNodeId: dom.backendNodeId,
            fingerprint,
          })
        : undefined;
      const node: SemanticNode = {
        ...(ref ? { ref } : {}),
        role,
        name,
        depth: axDepth(axNode, axById),
        ...(disabled ? { disabled: true } : {}),
        ...(dom.box ? { box: dom.box } : {}),
      };
      if (rawValue) {
        if (secret) node.filled = true;
        else node.value = safeValue;
      }
      candidates.push(node);
      if (candidates.length >= limits.maxNodes) {
        omitted = axResult.nodes.length - candidates.length;
        break;
      }
    }

    const revision = (this.revisions.get(input.tabId) ?? 0) + 1;
    this.revisions.set(input.tabId, revision);
    const safeUrl = redactSnapshotUrl(input.url);
    const safeTitle = redactPotentialSecretText(input.title, 4_000);
    const oopifNotice = input.oopifOmitted
      ? '\nnote="Out-of-process frame semantics are omitted; use human takeover for that frame."'
      : '';
    const header = `page tab=${safeToken(input.tabId)} document=${input.documentEpoch} revision=${revision}\nurl=${JSON.stringify(safeUrl)}\ntitle=${JSON.stringify(safeTitle)}${oopifNotice}`;
    const serialized = serializeBounded(header, candidates, BROWSER_MAX_SNAPSHOT_CHARACTERS);
    const serializedNodeCount = serialized.nodeCount;
    const nodes = candidates.slice(0, serializedNodeCount);
    const truncated = omitted > 0 || serializedNodeCount < candidates.length;
    const suffix = truncated ? '\n… snapshot truncated' : '';
    const text = (serialized.text + suffix).slice(0, BROWSER_MAX_SNAPSHOT_CHARACTERS);

    return semanticPageSnapshotSchema.parse({
      tabId: input.tabId,
      documentEpoch: input.documentEpoch,
      revision,
      url: safeUrl,
      title: safeTitle,
      mode: input.mode,
      nodes,
      serialized: text,
      nodeCount: nodes.length,
      truncated,
    });
  }
}

export function isSecretNode(
  _role: string,
  accessibleName: string,
  attributes: Readonly<Record<string, string>>,
  properties: ReadonlyMap<string, unknown> = new Map(),
): boolean {
  if (properties.get('protected') === true) return true;
  if (attributes.type?.toLowerCase() === 'password') return true;
  if (SECRET_AUTOCOMPLETE.test(attributes.autocomplete ?? '')) return true;
  const identity = `${attributes.name ?? ''} ${attributes.id ?? ''} ${attributes['aria-label'] ?? ''} ${accessibleName}`;
  return SECRET_ATTRIBUTE.test(identity);
}

function indexDom(result: DomSnapshotResult): Map<number, DomDetails> {
  const indexed = new Map<number, DomDetails>();
  for (const document of result.documents ?? []) {
    const nodes = document.nodes;
    if (!nodes) continue;
    const documentUrl = stringAt(result.strings, document.documentURL) || 'about:blank';
    const origin = originOf(documentUrl);
    const frameId = stringAt(result.strings, document.frameId) || 'main';
    const boxes = new Map<number, number[]>();
    const styles = new Map<number, string[]>();
    document.layout?.nodeIndex?.forEach((nodeIndex, index) => {
      const bounds = document.layout?.bounds?.[index];
      if (bounds) boxes.set(nodeIndex, bounds);
      const encodedStyles = document.layout?.styles?.[index];
      if (encodedStyles) styles.set(nodeIndex, encodedStyles.map((value) => stringAt(result.strings, value)));
    });
    nodes.backendNodeId?.forEach((backendNodeId, nodeIndex) => {
      if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) return;
      const rawBox = boxes.get(nodeIndex);
      const computed = styles.get(nodeIndex) ?? [];
      const width = rawBox?.[2] ?? 0;
      const height = rawBox?.[3] ?? 0;
      const visible = width > 0 && height > 0
        && computed[0] !== 'none' && computed[1] !== 'hidden' && computed[1] !== 'collapse'
        && Number(computed[2] ?? '1') > 0;
      indexed.set(backendNodeId, {
        backendNodeId,
        frameId,
        origin,
        tagName: stringAt(result.strings, nodes.nodeName?.[nodeIndex]).toLowerCase(),
        attributes: decodeAttributes(result.strings, nodes.attributes?.[nodeIndex]),
        visible,
        ...(rawBox && rawBox.length >= 4
          ? { box: { x: rawBox[0] ?? 0, y: rawBox[1] ?? 0, width: Math.max(0, rawBox[2] ?? 0), height: Math.max(0, rawBox[3] ?? 0) } }
          : {}),
      });
    });
  }
  return indexed;
}

function decodeAttributes(strings: readonly string[], encoded: readonly number[] | undefined): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (!encoded) return attributes;
  for (let index = 0; index + 1 < encoded.length; index += 2) {
    const name = stringAt(strings, encoded[index]);
    const value = stringAt(strings, encoded[index + 1]);
    if (name) attributes[name.toLowerCase()] = value;
  }
  return attributes;
}

function createFingerprint(
  node: AxNode,
  dom: DomDetails,
  role: string,
  name: string,
  nodes: ReadonlyMap<string, AxNode>,
): BrowserElementFingerprint {
  const stableAttributes: Record<string, string> = {};
  for (const key of ['id', 'name', 'type', 'autocomplete', 'href', 'formaction', 'data-testid', 'data-fate-node']) {
    const value = dom.attributes[key];
    if (value && key !== 'value') stableAttributes[key] = boundedText(value, 500);
  }
  const parent = node.parentId ? nodes.get(node.parentId) : undefined;
  return {
    tagName: dom.tagName,
    role: role || null,
    accessibleName: name || null,
    stableAttributes,
    nearbyTextHash: fingerprintHash(name),
    ancestorHash: fingerprintHash(`${textValue(parent?.role)}\n${textValue(parent?.name)}`),
  };
}

function includeNode(
  mode: BrowserSnapshotMode,
  role: string,
  name: string,
  dom: DomDetails,
  value: string,
  viewport?: LayoutMetricsResult['cssVisualViewport'],
): boolean {
  if (!name && !value && !ACTIONABLE_ROLES.has(role)) return false;
  if (!dom.visible) return false;
  if (mode === 'full') return true;
  if (!intersectsViewport(dom.box, viewport)) return false;
  if (mode === 'content') return !CONTENT_CHROME_ROLES.has(role);
  return ACTIONABLE_ROLES.has(role) || role === 'heading' || role === 'label' || dom.attributes.contenteditable === 'true';
}

function intersectsViewport(box: DomDetails['box'], viewport: LayoutMetricsResult['cssVisualViewport']): boolean {
  if (!box || !viewport) return Boolean(box);
  const left = viewport.pageX ?? 0;
  const top = viewport.pageY ?? 0;
  const right = left + Math.max(0, viewport.clientWidth ?? 0);
  const bottom = top + Math.max(0, viewport.clientHeight ?? 0);
  return box.x < right && box.x + box.width > left && box.y < bottom && box.y + box.height > top;
}

function isAxDescendant(node: AxNode, ancestorId: string, nodes: ReadonlyMap<string, AxNode>): boolean {
  let current: AxNode | undefined = node;
  const visited = new Set<string>();
  while (current && !visited.has(current.nodeId)) {
    if (current.nodeId === ancestorId) return true;
    visited.add(current.nodeId);
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return false;
}

function axDepth(node: AxNode, nodes: ReadonlyMap<string, AxNode>): number {
  let depth = 0;
  let current = node.parentId ? nodes.get(node.parentId) : undefined;
  const visited = new Set<string>();
  while (current && depth < 1_000 && !visited.has(current.nodeId)) {
    visited.add(current.nodeId);
    depth += 1;
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return depth;
}

function serializeBounded(header: string, nodes: readonly SemanticNode[], maxCharacters: number): { text: string; nodeCount: number } {
  let text = header;
  let nodeCount = 0;
  for (const node of nodes) {
    const flags = [node.disabled ? 'disabled' : '', node.filled ? 'filled=true' : ''].filter(Boolean).join(' ');
    const box = node.box ? ` box=(${formatNumber(node.box.x)},${formatNumber(node.box.y)},${formatNumber(node.box.width)},${formatNumber(node.box.height)})` : '';
    const value = node.value ? ` value=${JSON.stringify(node.value)}` : '';
    const line = `\n${'  '.repeat(Math.min(node.depth, 20))}${node.ref ? `[${node.ref}] ` : ''}${node.role} ${JSON.stringify(node.name)}${value}${flags ? ` ${flags}` : ''}${box}`;
    if (text.length + line.length > maxCharacters - 24) break;
    text += line;
    nodeCount += 1;
  }
  return { text, nodeCount };
}

function limitsFor(mode: BrowserSnapshotMode): { maxNodes: number; maxTextPerNode: number } {
  return { maxNodes: mode === 'full' ? 4_000 : 1_200, maxTextPerNode: 1_000 };
}
function inferRole(dom: DomDetails): string {
  if (dom.attributes.role) return dom.attributes.role.toLowerCase();
  if (dom.tagName === 'a' && dom.attributes.href) return 'link';
  if (dom.tagName === 'button') return 'button';
  if (dom.tagName === 'input' || dom.tagName === 'textarea') return 'textbox';
  return dom.tagName || 'node';
}
function textValue(value: CdpValue | undefined): string {
  const raw = value?.value;
  return typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : '';
}
function boundedText(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, max);
}
function safeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 160);
}
function stringAt(strings: readonly string[], index: number | undefined): string {
  return index === undefined || index < 0 ? '' : strings[index] ?? '';
}
function originOf(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'fate-local:' && /^[a-f0-9]{48}$/u.test(url.hostname)) return `fate-local://${url.hostname}`;
    return url.origin === 'null' ? 'opaque' : url.origin;
  } catch { return 'opaque'; }
}
function indexFrameLoaders(root: FrameTreeResult['frameTree']): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (node: NonNullable<FrameTreeResult['frameTree']>) => {
    if (node.frame.loaderId) result.set(node.frame.id, node.frame.loaderId);
    for (const child of node.childFrames ?? []) if (child) visit(child);
  };
  if (root) visit(root);
  return result;
}
export function redactSnapshotUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.href === 'about:blank') return url.href;
    if (url.protocol === 'file:') {
      const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? 'local-preview.html')
        .replace(/[\\/?#\u0000-\u001f\u007f]/gu, '_')
        .slice(0, 240);
      return `file:///${encodeURIComponent(name || 'local-preview.html')}`;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'about:blank';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.split('/').map((segment) => (
      /(?:token|secret|password|passwd|credential|auth|session|reset|verify)/iu.test(segment) ? '[redacted]' : segment
    )).join('/');
    return url.href;
  } catch { return 'about:blank'; }
}
export function redactPotentialSecretText(value: string, max: number): string {
  const redacted = boundedText(value, max)
    .replace(/\b(password|passwd|otp|token|secret|api[_ -]?key|verification[_ -]?code|authorization)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/gu, '[token redacted]')
    .replace(/\b(?:sk|pk|rk)-(?:live|test)-[A-Za-z0-9_-]{12,}\b/gu, '[credential redacted]')
    .replace(/\b(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{16,}\b/gu, '[credential redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, '[credential redacted]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu, '[private key redacted]');
  return redactPaymentCardNumbers(redacted);
}
export function containsPaymentCardNumber(value: string): boolean {
  return paymentCardMatches(value).some(({ digits }) => passesLuhn(digits));
}
function redactPaymentCardNumbers(value: string): string {
  return value.replace(/(^|\D)((?:\d[ -]?){13,19})(?!\d)/gu, (match, prefix: string, candidate: string) => {
    const digits = candidate.replace(/\D/gu, '');
    return passesLuhn(digits) ? `${prefix}[payment card redacted]` : match;
  });
}
function paymentCardMatches(value: string): Array<{ digits: string }> {
  return [...value.matchAll(/(?:^|\D)((?:\d[ -]?){13,19})(?!\d)/gu)]
    .map((match) => ({ digits: (match[1] ?? '').replace(/\D/gu, '') }))
    .filter(({ digits }) => digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/u.test(digits));
}
function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new BrowserError('CDP_UNAVAILABLE', message, true)), milliseconds);
    timeout.unref?.();
    void operation.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); },
    );
  });
}
