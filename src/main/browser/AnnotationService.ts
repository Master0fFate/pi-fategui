import { randomUUID } from 'node:crypto';
import type { BrowserAnnotation } from '../../shared/contracts/browser';
import type { BrowserCdpEventClient } from './CdpClient';
import { BrowserError } from './BrowserErrors';
import { BrowserPolicy } from './BrowserPolicy';
import { BrowserRefRegistry, fingerprintHash } from './BrowserRefRegistry';
import { BrowserAnnotationRepository } from './BrowserAnnotationRepository';
import { redactPotentialSecretText, redactSnapshotUrl, SNAPSHOT_STYLE_PROPERTIES } from './SemanticSnapshotEngine';

interface AnnotationContext {
  tabId: string;
  documentEpoch: number;
  pageRevision: number;
  url: string;
  origin?: string;
  explicitUserSelection?: boolean;
}

interface RegionAxNode {
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: { value?: unknown };
  name?: { value?: unknown };
}

interface RegionSnapshot {
  strings?: string[];
  documents?: Array<{
    documentURL?: number;
    frameId?: number;
    nodes?: { backendNodeId?: number[]; nodeName?: number[]; attributes?: number[][] };
    layout?: { nodeIndex?: number[]; bounds?: number[][]; styles?: number[][] };
  }>;
}

export class AnnotationService {
  constructor(
    private readonly cdp: BrowserCdpEventClient,
    private readonly policy: BrowserPolicy,
    private readonly repository: BrowserAnnotationRepository,
    private readonly refs: BrowserRefRegistry,
  ) {}

  async selectElement(context: AnnotationContext, comment: string, signal?: AbortSignal): Promise<BrowserAnnotation> {
    this.requireOverlay();
    // Reset the inspector agent between selections. Chromium can otherwise
    // acknowledge the next picker without reactivating hit testing.
    await this.cdp.send('Overlay.disable');
    await this.cdp.send('Overlay.enable');
    // The picker is human-paced: wait for the click without a timeout. Esc,
    // mode changes, and navigation cancel through the abort signal.
    const selection = this.cdp.waitForEvent<{ backendNodeId?: number }>('Overlay.inspectNodeRequested', {
      ...(signal ? { signal } : {}),
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    await this.cdp.send('Overlay.setInspectMode', {
      mode: 'searchForNode',
      highlightConfig: {
        showInfo: true, showStyles: true, showAccessibilityInfo: true,
        contentColor: { r: 79, g: 138, b: 255, a: 0.18 }, borderColor: { r: 79, g: 138, b: 255, a: 0.95 },
      },
    });
    try {
      const selected = await selection;
      if (!selected.backendNodeId) throw new BrowserError('UNSUPPORTED_ACTION', 'Chromium did not return an inspected element.');
      const existing = this.repository.findElement(context.tabId, context.documentEpoch, selected.backendNodeId);
      return existing ?? await this.describeElement(context, selected.backendNodeId, comment);
    } finally {
      // Chromium 142 requires the parameter even when leaving inspect mode.
      await this.cdp.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
    }
  }

  async selectRegion(context: AnnotationContext, comment: string, signal?: AbortSignal): Promise<BrowserAnnotation> {
    this.requireOverlay();
    // Region selection is a human drag: unbounded wait, abortable at any time.
    const selection = this.cdp.waitForEvent<{ viewport?: { x: number; y: number; width: number; height: number } }>('Overlay.screenshotRequested', {
      ...(signal ? { signal } : {}),
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    await this.cdp.send('Overlay.setInspectMode', { mode: 'captureAreaScreenshot', highlightConfig: {} });
    try {
      const selected = await selection;
      const rect = selected.viewport;
      if (!rect || rect.width <= 0 || rect.height <= 0) throw new BrowserError('UNSUPPORTED_ACTION', 'Chromium did not return a valid annotation region.');
      const viewport = await this.viewport();
      const origin = context.origin ?? originOf(context.url);
      if (!context.explicitUserSelection && !this.policy.canRead(origin)) {
        throw new BrowserError('ORIGIN_NOT_GRANTED', 'The annotated origin is not readable.');
      }
      const region = await this.describeRegion({
        x: rect.x + viewport.pageX,
        y: rect.y + viewport.pageY,
        width: rect.width,
        height: rect.height,
      });
      return this.repository.save({
        id: randomUUID(), tabId: context.tabId, url: redactAnnotationUrl(context.url), origin,
        documentEpoch: context.documentEpoch, pageRevision: context.pageRevision, kind: 'region',
        target: {
          frameId: region.frameId, rectCssPx: rect,
          rectNormalized: normalizeRect(rect, viewport), locatorHints: {},
          fingerprint: {
            attributesHash: fingerprintHash(region.domExcerpt),
            nearbyTextHash: fingerprintHash(region.domExcerpt),
            ancestorHash: '',
          },
        },
        comment,
        ...(region.domExcerpt ? { domExcerpt: region.domExcerpt } : {}),
        ...(Object.keys(region.computedStyle).length > 0 ? { computedStyle: region.computedStyle } : {}),
        semanticCoverage: region.coverage,
        reattachConfidence: region.coverage > 0.5 ? 0.6 : 0,
        createdAt: Date.now(),
      });
    } finally {
      await this.cdp.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
    }
  }

  async reattachElement(context: AnnotationContext, annotation: BrowserAnnotation): Promise<BrowserAnnotation> {
    if (annotation.kind !== 'element') return annotation;
    if (annotation.tabId !== context.tabId || annotation.documentEpoch !== context.documentEpoch) {
      return this.markUnattached(annotation);
    }
    if (redactAnnotationUrl(context.url) !== annotation.url || !this.policy.canRead(annotation.origin)) {
      return this.markUnattached(annotation);
    }

    const [snapshot, ax, viewport] = await Promise.all([
      this.cdp.send<RegionSnapshot>('DOMSnapshot.captureSnapshot', {
        computedStyles: ['display', 'visibility', 'opacity'], includeDOMRects: true, includePaintOrder: true,
      }),
      this.cdp.send<{ nodes?: RegionAxNode[] }>('Accessibility.getFullAXTree'),
      this.viewport(),
    ]);
    const strings = snapshot.strings ?? [];
    const axByBackendId = new Map((ax.nodes ?? []).flatMap((node) => (
      node.backendDOMNodeId && !node.ignored ? [[node.backendDOMNodeId, node] as const] : []
    )));
    const candidates: Array<{
      backendNodeId: number;
      frameId: string;
      attributes: Record<string, string>;
      tagName: string;
      role: string;
      name: string;
      rect: { x: number; y: number; width: number; height: number };
      score: number;
    }> = [];
    for (const document of snapshot.documents ?? []) {
      const documentUrl = stringAt(strings, document.documentURL);
      const frameOrigin = originOf(documentUrl);
      if (frameOrigin !== annotation.origin || !this.policy.canRead(frameOrigin)) continue;
      const frameId = stringAt(strings, document.frameId) || 'main';
      const nodes = document.nodes;
      if (!nodes?.backendNodeId) continue;
      const layoutByNode = new Map<number, number>();
      document.layout?.nodeIndex?.forEach((nodeIndex, layoutIndex) => layoutByNode.set(nodeIndex, layoutIndex));
      nodes.backendNodeId.forEach((backendNodeId, nodeIndex) => {
        if (!backendNodeId) return;
        const layoutIndex = layoutByNode.get(nodeIndex);
        const bounds = layoutIndex === undefined ? undefined : document.layout?.bounds?.[layoutIndex];
        if (!bounds || bounds.length < 4 || (bounds[2] ?? 0) <= 0 || (bounds[3] ?? 0) <= 0) return;
        const encodedStyles = layoutIndex === undefined ? [] : document.layout?.styles?.[layoutIndex] ?? [];
        const display = stringAt(strings, encodedStyles[0]);
        const visibility = stringAt(strings, encodedStyles[1]);
        const opacity = stringAt(strings, encodedStyles[2]);
        if (display === 'none' || visibility === 'hidden' || visibility === 'collapse' || Number(opacity || '1') <= 0) return;
        const tagName = stringAt(strings, nodes.nodeName?.[nodeIndex]).toLowerCase();
        const attributes = decodeSnapshotAttributes(strings, nodes.attributes?.[nodeIndex]);
        const axNode = axByBackendId.get(backendNodeId);
        const role = primitive(axNode?.role?.value);
        const name = primitive(axNode?.name?.value);
        const rect = {
          x: (bounds[0] ?? 0) - viewport.pageX,
          y: (bounds[1] ?? 0) - viewport.pageY,
          width: bounds[2] ?? 0,
          height: bounds[3] ?? 0,
        };
        const score = reattachScore(annotation, { tagName, attributes, role, name, rect });
        if (score > 0) candidates.push({ backendNodeId, frameId, attributes, tagName, role, name, rect, score });
      });
    }
    candidates.sort((left, right) => right.score - left.score);
    const best = candidates[0];
    const runnerUp = candidates[1];
    if (!best || best.score < 0.65 || (runnerUp && best.score - runnerUp.score < 0.12)) {
      return this.markUnattached(annotation);
    }

    const description = await this.cdp.send<{ node: { nodeId?: number } }>('DOM.describeNode', {
      backendNodeId: best.backendNodeId, depth: 0,
    });
    const outerHtml = await this.cdp.send<{ outerHTML?: string }>('DOM.getOuterHTML', {
      backendNodeId: best.backendNodeId,
    }).catch(() => ({ outerHTML: '' }));
    const stable = locatorHints(best.attributes);
    const semanticRef = this.refs.refForNode(context.tabId, context.documentEpoch, best.frameId, best.backendNodeId);
    const fallbackExcerpt = `<${best.tagName}${Object.entries(stable).map(([key, value]) => ` ${key}=${JSON.stringify(value)}`).join('')}>`;
    const computedStyle = await this.computedStyle(description.node.nodeId);
    return this.repository.save({
      ...annotation,
      url: redactAnnotationUrl(context.url),
      pageRevision: context.pageRevision,
      target: {
        ...annotation.target,
        frameId: best.frameId,
        backendNodeId: best.backendNodeId,
        ...(semanticRef ? { semanticRef } : { semanticRef: undefined }),
        ...(best.role ? { role: best.role } : { role: undefined }),
        ...(best.name ? { accessibleName: best.name } : { accessibleName: undefined }),
        tagName: best.tagName,
        rectCssPx: best.rect,
        rectNormalized: normalizeRect(best.rect, viewport),
        locatorHints: stable,
        fingerprint: {
          attributesHash: fingerprintHash(JSON.stringify(stable)),
          nearbyTextHash: fingerprintHash(best.name),
          ancestorHash: annotation.target.fingerprint.ancestorHash,
        },
      },
      domExcerpt: sanitizeAnnotationHtml(outerHtml.outerHTML ?? '') || fallbackExcerpt,
      ...(Object.keys(computedStyle).length > 0 ? { computedStyle } : { computedStyle: undefined }),
      reattachConfidence: Math.round(best.score * 1_000) / 1_000,
    });
  }

  markUnattached(annotation: BrowserAnnotation): BrowserAnnotation {
    const target = { ...annotation.target };
    delete target.semanticRef;
    return this.repository.save({ ...annotation, target, reattachConfidence: 0 });
  }

  private async describeElement(context: AnnotationContext, backendNodeId: number, comment: string): Promise<BrowserAnnotation> {
    const [description, ax, box, viewport, location, outerHtml] = await Promise.all([
      this.cdp.send<{ node: { nodeId?: number; nodeName: string; frameId?: string; attributes?: string[] } }>('DOM.describeNode', { backendNodeId, depth: 0 }),
      this.cdp.send<{ nodes?: Array<{ role?: { value?: unknown }; name?: { value?: unknown } }> }>('Accessibility.queryAXTree', { backendNodeId }),
      this.cdp.send<{ model?: { border?: number[] } }>('DOM.getBoxModel', { backendNodeId }),
      this.viewport(),
      this.cdp.send<{ strings?: string[]; documents?: Array<{ documentURL?: number; frameId?: number; nodes?: { backendNodeId?: number[] } }> }>(
        'DOMSnapshot.captureSnapshot', { computedStyles: [], includeDOMRects: false },
      ),
      this.cdp.send<{ outerHTML?: string }>('DOM.getOuterHTML', { backendNodeId }).catch(() => ({ outerHTML: '' })),
    ]);
    const quad = box.model?.border;
    if (!quad || quad.length < 8) throw new BrowserError('STALE_SNAPSHOT', 'The selected element has no visible box.');
    const rect = quadRect(quad);
    const frameLocation = locateBackendNode(location, backendNodeId);
    if (!frameLocation || frameLocation.origin === 'null') {
      throw new BrowserError('ACTION_BLOCKED', 'The selected element frame could not be securely identified.');
    }
    const origin = frameLocation.origin;
    if (!context.explicitUserSelection && !this.policy.canRead(origin)) {
      throw new BrowserError('ORIGIN_NOT_GRANTED', 'The annotated frame origin is not readable.');
    }
    const semanticRef = this.refs.refForNode(context.tabId, context.documentEpoch, frameLocation.frameId, backendNodeId);
    const attributes = flatAttributes(description.node.attributes);
    const role = primitive(ax.nodes?.[0]?.role?.value);
    const name = primitive(ax.nodes?.[0]?.name?.value);
    const stable = locatorHints(attributes);
    const computedStyle: Record<string, string> = {};
    if (description.node.nodeId && this.cdp.supports('CSS')) {
      const computed = await this.cdp.send<{ computedStyle?: Array<{ name?: string; value?: string }> }>(
        'CSS.getComputedStyleForNode',
        { nodeId: description.node.nodeId },
      ).catch(() => ({ computedStyle: [] }));
      const allowed = new Set<string>(SNAPSHOT_STYLE_PROPERTIES);
      for (const property of computed.computedStyle ?? []) {
        if (property.name && property.value && allowed.has(property.name)) computedStyle[property.name] = property.value.slice(0, 2_000);
      }
    }
    const fallbackExcerpt = `<${description.node.nodeName.toLowerCase()}${Object.entries(stable).map(([key, value]) => ` ${key}=${JSON.stringify(value)}`).join('')}>`;
    const domExcerpt = sanitizeAnnotationHtml(outerHtml.outerHTML ?? '') || fallbackExcerpt;
    return this.repository.save({
      id: randomUUID(), tabId: context.tabId, url: redactAnnotationUrl(context.url), origin,
      documentEpoch: context.documentEpoch, pageRevision: context.pageRevision, kind: 'element',
      target: {
        frameId: frameLocation.frameId, backendNodeId,
        ...(semanticRef ? { semanticRef } : {}),
        ...(role ? { role } : {}), ...(name ? { accessibleName: name } : {}),
        tagName: description.node.nodeName.toLowerCase(), rectCssPx: rect,
        rectNormalized: normalizeRect(rect, viewport), locatorHints: stable,
        fingerprint: {
          attributesHash: fingerprintHash(JSON.stringify(stable)), nearbyTextHash: fingerprintHash(name), ancestorHash: '',
        },
      },
      comment,
      domExcerpt,
      ...(Object.keys(computedStyle).length > 0 ? { computedStyle } : {}),
      semanticCoverage: 1,
      reattachConfidence: 0.75,
      createdAt: Date.now(),
    });
  }

  private async describeRegion(rect: { x: number; y: number; width: number; height: number }): Promise<{
    frameId: string;
    domExcerpt: string;
    computedStyle: Record<string, string>;
    coverage: number;
  }> {
    const [snapshot, ax] = await Promise.all([
      this.cdp.send<RegionSnapshot>('DOMSnapshot.captureSnapshot', {
        computedStyles: [...SNAPSHOT_STYLE_PROPERTIES],
        includeDOMRects: true,
        includePaintOrder: true,
      }),
      this.cdp.send<{ nodes?: RegionAxNode[] }>('Accessibility.getFullAXTree'),
    ]);
    const strings = snapshot.strings ?? [];
    const dom = new Map<number, {
      frameId: string;
      origin: string;
      tagName: string;
      box: { x: number; y: number; width: number; height: number };
      styles: Record<string, string>;
    }>();
    for (const document of snapshot.documents ?? []) {
      const documentUrl = stringAt(strings, document.documentURL);
      const frameOrigin = originOf(documentUrl);
      if (!this.policy.canRead(frameOrigin)) continue;
      const frameId = stringAt(strings, document.frameId) || 'main';
      const nodes = document.nodes;
      if (!nodes?.backendNodeId) continue;
      const layoutByNode = new Map<number, number>();
      document.layout?.nodeIndex?.forEach((nodeIndex, layoutIndex) => layoutByNode.set(nodeIndex, layoutIndex));
      nodes.backendNodeId.forEach((backendNodeId, nodeIndex) => {
        const layoutIndex = layoutByNode.get(nodeIndex);
        if (!backendNodeId || layoutIndex === undefined) return;
        const bounds = document.layout?.bounds?.[layoutIndex];
        if (!bounds || bounds.length < 4 || (bounds[2] ?? 0) <= 0 || (bounds[3] ?? 0) <= 0) return;
        const encodedStyles = document.layout?.styles?.[layoutIndex] ?? [];
        const styles = Object.fromEntries(SNAPSHOT_STYLE_PROPERTIES.flatMap((name, index) => {
          const value = stringAt(strings, encodedStyles[index]);
          return value ? [[name, value]] : [];
        }));
        if (styles.display === 'none' || styles.visibility === 'hidden' || Number(styles.opacity ?? '1') <= 0) return;
        dom.set(backendNodeId, {
          frameId,
          origin: frameOrigin,
          tagName: stringAt(strings, nodes.nodeName?.[nodeIndex]).toLowerCase(),
          box: { x: bounds[0] ?? 0, y: bounds[1] ?? 0, width: bounds[2] ?? 0, height: bounds[3] ?? 0 },
          styles,
        });
      });
    }
    const intersecting = (ax.nodes ?? []).flatMap((node) => {
      if (node.ignored || !node.backendDOMNodeId) return [];
      const element = dom.get(node.backendDOMNodeId);
      if (!element) return [];
      const area = intersectionArea(rect, element.box);
      if (area <= 0) return [];
      const role = primitive(node.role?.value) || element.tagName || 'node';
      const name = primitive(node.name?.value);
      return [{ ...element, role, name, area }];
    }).sort((left, right) => right.area - left.area).slice(0, 120);
    const regionArea = Math.max(1, rect.width * rect.height);
    const coverage = Math.min(1, intersecting.reduce((total, item) => total + item.area, 0) / regionArea);
    const inReadingOrder = [...intersecting].sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x);
    const domExcerpt = inReadingOrder.map((item) => {
      const overlap = Math.min(100, Math.round(item.area / Math.max(1, item.box.width * item.box.height) * 100));
      return `- ${item.role}${item.name ? ` ${JSON.stringify(item.name)}` : ''} <${item.tagName}> overlap=${overlap}%`;
    }).join('\n').slice(0, 8_000);
    const dominant = intersecting[0];
    return {
      frameId: dominant?.frameId ?? 'main',
      domExcerpt,
      computedStyle: dominant ? dominant.styles : {},
      coverage: Math.round(coverage * 1_000) / 1_000,
    };
  }

  private async computedStyle(nodeId: number | undefined): Promise<Record<string, string>> {
    if (!nodeId || !this.cdp.supports('CSS')) return {};
    const computed = await this.cdp.send<{ computedStyle?: Array<{ name?: string; value?: string }> }>(
      'CSS.getComputedStyleForNode',
      { nodeId },
    ).catch(() => ({ computedStyle: [] }));
    const allowed = new Set<string>(SNAPSHOT_STYLE_PROPERTIES);
    return Object.fromEntries((computed.computedStyle ?? []).flatMap((property) => (
      property.name && property.value && allowed.has(property.name)
        ? [[property.name, property.value.slice(0, 2_000)] as const]
        : []
    )));
  }

  private async viewport(): Promise<{ pageX: number; pageY: number; width: number; height: number }> {
    const metrics = await this.cdp.send<{
      cssVisualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number };
      cssLayoutViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number };
    }>('Page.getLayoutMetrics');
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    return {
      pageX: viewport?.pageX ?? 0,
      pageY: viewport?.pageY ?? 0,
      width: Math.max(1, viewport?.clientWidth ?? 1),
      height: Math.max(1, viewport?.clientHeight ?? 1),
    };
  }
  private requireOverlay(): void {
    if (!this.cdp.supports('Overlay')) throw new BrowserError('CDP_UNAVAILABLE', 'Chromium inspection overlays are unavailable.', true);
  }
}

function locatorHints(attributes: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries([
    'id', 'class', 'name', 'type', 'role', 'aria-label', 'href', 'data-testid', 'data-fate-node',
  ].flatMap((key) => attributes[key] ? [[key, safeLocatorValue(key, attributes[key])]] : []));
}
function decodeSnapshotAttributes(strings: readonly string[], encoded: readonly number[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; encoded && index + 1 < encoded.length; index += 2) {
    const name = stringAt(strings, encoded[index]);
    if (name) result[name.toLowerCase()] = stringAt(strings, encoded[index + 1]).slice(0, 500);
  }
  return result;
}
function reattachScore(
  annotation: BrowserAnnotation,
  candidate: {
    tagName: string;
    attributes: Readonly<Record<string, string>>;
    role: string;
    name: string;
    rect: { x: number; y: number; width: number; height: number };
  },
): number {
  if (annotation.target.tagName && annotation.target.tagName !== candidate.tagName) return 0;
  let score = 0.15;
  const expected = annotation.target.locatorHints;
  for (const key of ['id', 'data-testid', 'data-fate-node'] as const) {
    if (!expected[key]) continue;
    if (candidate.attributes[key] !== expected[key]) return 0;
    score += 0.42;
  }
  const expectedClasses = new Set((expected.class ?? '').split(/\s+/u).filter(Boolean));
  const candidateClasses = new Set((candidate.attributes.class ?? '').split(/\s+/u).filter(Boolean));
  if (expectedClasses.size > 0) {
    const intersection = [...expectedClasses].filter((value) => candidateClasses.has(value)).length;
    const union = new Set([...expectedClasses, ...candidateClasses]).size;
    score += 0.22 * intersection / Math.max(1, union);
  }
  if (annotation.target.role && annotation.target.role === candidate.role) score += 0.12;
  if (annotation.target.accessibleName && annotation.target.accessibleName === candidate.name) score += 0.22;
  for (const key of ['name', 'type', 'role', 'aria-label'] as const) {
    if (expected[key] && candidate.attributes[key] === expected[key]) score += 0.06;
  }
  const previous = annotation.target.rectCssPx;
  const previousCenter = { x: previous.x + previous.width / 2, y: previous.y + previous.height / 2 };
  const candidateCenter = { x: candidate.rect.x + candidate.rect.width / 2, y: candidate.rect.y + candidate.rect.height / 2 };
  const distance = Math.hypot(previousCenter.x - candidateCenter.x, previousCenter.y - candidateCenter.y);
  if (distance <= 24) score += 0.18;
  else if (distance <= 160) score += 0.09;
  return Math.min(1, score);
}
function safeLocatorValue(name: string, value: string): string {
  const redacted = redactPotentialSecretText(value, 500);
  if (name !== 'href') return redacted;
  try {
    const url = new URL(redacted);
    return redactSnapshotUrl(url.href).slice(0, 500);
  } catch {
    return redacted.split(/[?#]/u, 1)[0] ?? '';
  }
}
function sanitizeAnnotationHtml(value: string): string {
  if (!value) return '';
  const bounded = value.slice(0, 64_000)
    .replace(/<!--[^]*?-->/gu, '')
    .replace(/<(?:script|style)\b[^>]*>[^]*?<\/(?:script|style)\s*>/giu, '')
    .replace(
      /(\s(?:value|srcdoc|nonce|data-(?:token|secret|credential|auth|authorization|password))\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/giu,
      '$1"[redacted]"',
    )
    .replace(/(\s(?:href|src|action|formaction)\s*=\s*)(["'])([^"']*)\2/giu, (_match, prefix: string, quote: string, raw: string) => (
      `${prefix}${quote}${safeLocatorValue('href', raw)}${quote}`
    ));
  return redactPotentialSecretText(bounded, 8_000).trim();
}
function originOf(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'fate-local:' && /^[a-f0-9]{48}$/u.test(url.hostname)) return `fate-local://${url.hostname}`;
    return url.origin;
  } catch { return 'null'; }
}
function redactAnnotationUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:' || url.protocol === 'fate-local:') return redactSnapshotUrl(url.href);
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href;
  } catch { return 'about:blank'; }
}
function primitive(value: unknown): string { return typeof value === 'string' ? value.slice(0, 1_000) : ''; }
function flatAttributes(encoded: readonly string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; encoded && index + 1 < encoded.length; index += 2) {
    const key = encoded[index]; if (key) result[key.toLowerCase()] = (encoded[index + 1] ?? '').slice(0, 500);
  }
  return result;
}
function quadRect(quad: readonly number[]) {
  const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
  const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
function locateBackendNode(
  snapshot: { strings?: string[]; documents?: Array<{ documentURL?: number; frameId?: number; nodes?: { backendNodeId?: number[] } }> },
  backendNodeId: number,
): { origin: string; frameId: string } | null {
  const strings = snapshot.strings ?? [];
  for (const document of snapshot.documents ?? []) {
    if (!document.nodes?.backendNodeId?.includes(backendNodeId)) continue;
    const url = document.documentURL === undefined ? '' : strings[document.documentURL] ?? '';
    const frameId = document.frameId === undefined ? '' : strings[document.frameId] ?? '';
    return { origin: originOf(url), frameId: frameId || 'main' };
  }
  return null;
}
function normalizeRect(rect: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }) {
  return { x: rect.x / viewport.width, y: rect.y / viewport.height, width: rect.width / viewport.width, height: rect.height / viewport.height };
}
function stringAt(strings: readonly string[], index: number | undefined): string {
  return index === undefined || index < 0 ? '' : strings[index] ?? '';
}
function intersectionArea(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}
