import type {
  BrowserActionResult,
  BrowserConsequence,
  ProposedBrowserAction,
} from '../../shared/contracts/browser';
import type { BrowserCdpClient } from './CdpClient';
import { BrowserError } from './BrowserErrors';
import { BrowserActionGate } from './BrowserPolicy';
import { BrowserRefRegistry, fingerprintHash, type BrowserElementHandle } from './BrowserRefRegistry';
import type { BrowserPointerOverlay } from './BrowserPointerOverlay';
import { containsPaymentCardNumber, redactPotentialSecretText } from './SemanticSnapshotEngine';

interface LiveDomNode {
  backendNodeId: number;
  nodeId?: number;
  parentId?: number;
  nodeName: string;
  attributes?: string[];
  frameId?: string;
}
interface DescribeNodeResult { node: LiveDomNode }
interface QueryAxResult {
  nodes?: Array<{
    nodeId?: string;
    parentId?: string;
    backendDOMNodeId?: number;
    role?: { value?: unknown };
    name?: { value?: unknown };
    properties?: Array<{ name: string; value?: { value?: unknown } }>;
  }>;
}
interface BoxModelResult { model?: { content?: number[]; border?: number[] } }
interface ContentQuadsResult { quads?: number[][] }
interface LocationResult { backendNodeId?: number; nodeId?: number }
interface DocumentResult { root: LiveDomNode }
interface BrowserKeyStroke { key: string; code?: string; modifiers: number; printable: boolean; label: string }
interface VerifiedBrowserElement {
  handle: BrowserElementHandle;
  node: LiveDomNode;
  attributes: Record<string, string>;
  frameUrl: string;
}
interface LiveFormDetails {
  attributes: Record<string, string>;
  documentNodeId: number;
  formNodeId: number;
}

export interface BrowserConfirmationBinding {
  tabId: string;
  documentEpoch: number;
  ref?: string;
}

export type BrowserConfirmationHandler = (
  action: ProposedBrowserAction,
  reason: string,
  binding: BrowserConfirmationBinding,
) => Promise<boolean>;
export type BrowserDispatchGuard = (action: ProposedBrowserAction) => () => void;

const NOOP_POINTER: Pick<BrowserPointerOverlay, 'move' | 'click'> = {
  move: async () => undefined,
  click: async () => undefined,
};

export interface BrowserActionContext {
  tabId: string;
  documentEpoch: number;
  url: string;
  origin: string;
  targetId: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}

export class BrowserActionExecutor {
  constructor(
    private readonly cdp: BrowserCdpClient,
    private readonly refs: BrowserRefRegistry,
    private readonly gate: BrowserActionGate,
    private readonly confirm: BrowserConfirmationHandler = async () => false,
    private readonly onPolicyChanged: () => void = () => undefined,
    private readonly beginDispatchGuard: BrowserDispatchGuard = () => () => undefined,
    private readonly pointer: Pick<BrowserPointerOverlay, 'move' | 'click'> = NOOP_POINTER,
  ) {}

  async click(
    context: BrowserActionContext,
    input: { ref: string },
  ): Promise<BrowserActionResult> {
    assertActionCurrent(context);
    let target = await this.resolveVerified(context, input.ref);
    const action = await this.actionForElement(target, 'click', context.origin);
    const confirmed = await this.authorize(action, { tabId: context.tabId, documentEpoch: context.documentEpoch, ref: input.ref });
    assertNotAborted(context.signal);
    target = await this.resolveVerified(context, input.ref);
    const currentAction = await this.actionForElement(target, 'click', context.origin);
    if (JSON.stringify(currentAction) !== JSON.stringify(action)) {
      throw new BrowserError('STALE_SNAPSHOT', 'The browser target changed before input was dispatched.', true);
    }
    this.assertStillAuthorized(action, confirmed);
    assertActionCurrent(context);

    await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.handle.backendNodeId });
    const initialDispatchPoint = await this.findActionPoint(target);
    if (!initialDispatchPoint) throw new BrowserError('STALE_SNAPSHOT', 'No unobscured point on the element could be clicked.', true);
    let dispatchPoint = initialDispatchPoint;
    assertNotAborted(context.signal);
    const finalTarget = await this.resolveVerified(context, input.ref);
    const finalAction = await this.actionForElement(finalTarget, 'click', context.origin);
    if (finalTarget.handle.backendNodeId !== target.handle.backendNodeId || JSON.stringify(finalAction) !== JSON.stringify(action)) {
      throw new BrowserError('STALE_SNAPSHOT', 'The browser target changed during hit testing.', true);
    }
    this.assertStillAuthorized(action, confirmed);

    await this.withDispatchGuard(action, async () => {
      await this.pointer.move(dispatchPoint!, targetSummary(target.handle));
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dispatchPoint!.x, y: dispatchPoint!.y });
      assertNotAborted(context.signal);
      this.assertStillAuthorized(action, confirmed);

      let dispatchTarget = await this.resolveVerified(context, input.ref);
      let dispatchAction = await this.actionForElement(dispatchTarget, 'click', context.origin);
      if (dispatchTarget.handle.backendNodeId !== target.handle.backendNodeId || JSON.stringify(dispatchAction) !== JSON.stringify(action)) {
        throw new BrowserError('STALE_SNAPSHOT', 'The browser target changed after hover and was not clicked.', true);
      }

      // Hover styles often move or expose a control. Re-hit-test and follow the
      // same verified element once instead of making the model recover manually.
      const correctedPoint = await this.findActionPoint(dispatchTarget, dispatchPoint);
      if (!correctedPoint) throw new BrowserError('STALE_SNAPSHOT', 'The element became obscured after hover and was not clicked.', true);
      if (pointDistance(dispatchPoint!, correctedPoint) > 1) {
        dispatchPoint = correctedPoint;
        await this.pointer.move(dispatchPoint, targetSummary(target.handle));
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dispatchPoint.x, y: dispatchPoint.y });
        dispatchTarget = await this.resolveVerified(context, input.ref);
        dispatchAction = await this.actionForElement(dispatchTarget, 'click', context.origin);
        if (dispatchTarget.handle.backendNodeId !== target.handle.backendNodeId || JSON.stringify(dispatchAction) !== JSON.stringify(action)) {
          throw new BrowserError('STALE_SNAPSHOT', 'The browser target changed while correcting its hover position.', true);
        }
      }

      assertActionCurrent(context);
      this.assertStillAuthorized(action, confirmed);
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dispatchPoint.x, y: dispatchPoint.y, button: 'left', clickCount: 1 });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dispatchPoint.x, y: dispatchPoint.y, button: 'left', clickCount: 1 });
      await this.pointer.click(dispatchPoint);
    });
    if (this.gate.consume(action)) this.onPolicyChanged();
    return { tabId: context.tabId, kind: 'click', target: targetSummary(target.handle), confirmed };
  }

  async type(
    context: BrowserActionContext,
    input: {
      ref: string;
      text: string;
    },
  ): Promise<BrowserActionResult> {
    assertActionCurrent(context);
    let target = await this.resolveVerified(context, input.ref);
    const action: ProposedBrowserAction = {
      ...actionFor(target.handle, 'type', derivedConsequence(target.handle), context.origin),
      textClassification: classifyTypedText(input.text, target.handle, target.attributes),
    };
    const confirmed = await this.authorize(action, { tabId: context.tabId, documentEpoch: context.documentEpoch, ref: input.ref });
    assertNotAborted(context.signal);
    target = await this.resolveVerified(context, input.ref);
    const currentAction: ProposedBrowserAction = {
      ...actionFor(target.handle, 'type', derivedConsequence(target.handle), context.origin),
      textClassification: classifyTypedText(input.text, target.handle, target.attributes),
    };
    if (JSON.stringify(currentAction) !== JSON.stringify(action)) {
      throw new BrowserError('STALE_SNAPSHOT', 'The browser field changed before input was dispatched.', true);
    }
    this.assertStillAuthorized(action, confirmed);
    assertActionCurrent(context);
    await this.actionPoints(target.handle.backendNodeId);
    await this.withDispatchGuard(action, async () => {
      await this.cdp.send('DOM.focus', { backendNodeId: target.handle.backendNodeId });
      const modifier = process.platform === 'darwin' ? 4 : 2;
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: modifier });
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: modifier });
      assertNotAborted(context.signal);
      const finalTarget = await this.resolveVerified(context, input.ref);
      const finalAction: ProposedBrowserAction = {
        ...actionFor(finalTarget.handle, 'type', derivedConsequence(finalTarget.handle), context.origin),
        textClassification: classifyTypedText(input.text, finalTarget.handle, finalTarget.attributes),
      };
      if (finalTarget.handle.backendNodeId !== target.handle.backendNodeId || JSON.stringify(finalAction) !== JSON.stringify(action)) {
        throw new BrowserError('STALE_SNAPSHOT', 'The browser field changed before text was inserted.', true);
      }
      this.assertStillAuthorized(action, confirmed);
      await this.cdp.send('DOM.focus', { backendNodeId: finalTarget.handle.backendNodeId });
      assertActionCurrent(context);
      this.assertStillAuthorized(action, confirmed);
      await this.cdp.send('Input.insertText', { text: input.text });
    });
    if (this.gate.consume(action)) this.onPolicyChanged();
    return { tabId: context.tabId, kind: 'type', target: targetSummary(target.handle), confirmed };
  }

  async press(context: BrowserActionContext, key: string): Promise<BrowserActionResult> {
    assertActionCurrent(context);
    const stroke = normalizeKey(key);
    const initial = await this.actionForFocusedKey(context, stroke);
    const confirmed = await this.authorize(initial.action, { tabId: context.tabId, documentEpoch: context.documentEpoch });
    assertNotAborted(context.signal);
    const current = await this.actionForFocusedKey(context, stroke);
    if (current.backendNodeId !== initial.backendNodeId || JSON.stringify(current.action) !== JSON.stringify(initial.action)) {
      throw new BrowserError('STALE_SNAPSHOT', 'The focused browser target changed before the key was dispatched.', true);
    }
    this.assertStillAuthorized(initial.action, confirmed);
    assertActionCurrent(context);
    const event = {
      key: stroke.key,
      ...(stroke.code ? { code: stroke.code } : {}),
      ...(stroke.modifiers ? { modifiers: stroke.modifiers } : {}),
    };
    await this.withDispatchGuard(initial.action, async () => {
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...event,
        ...(stroke.printable && (stroke.modifiers & 7) === 0 ? { text: stroke.key } : {}),
      });
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
    });
    if (this.gate.consume(initial.action)) this.onPolicyChanged();
    return { tabId: context.tabId, kind: 'press', target: `key ${stroke.label}`, confirmed };
  }

  async scroll(context: BrowserActionContext, deltaX: number, deltaY: number): Promise<BrowserActionResult> {
    assertActionCurrent(context);
    const action: ProposedBrowserAction = {
      kind: 'scroll', origin: context.origin, frameOrigin: context.origin, consequence: 'none',
    };
    const confirmed = await this.authorize(action, { tabId: context.tabId, documentEpoch: context.documentEpoch });
    assertActionCurrent(context);
    this.assertStillAuthorized(action, confirmed);
    await this.withDispatchGuard(action, () => this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 1, y: 1, deltaX, deltaY,
    }));
    if (this.gate.consume(action)) this.onPolicyChanged();
    return { tabId: context.tabId, kind: 'scroll', target: 'active viewport', confirmed };
  }

  private async withDispatchGuard<T>(action: ProposedBrowserAction, operation: () => Promise<T>): Promise<T> {
    const release = this.beginDispatchGuard(action);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async resolveVerified(context: BrowserActionContext, ref: string): Promise<VerifiedBrowserElement> {
    const initial = this.refs.resolve(ref, {
      tabId: context.tabId, documentEpoch: context.documentEpoch, expectedTargetId: context.targetId,
    });
    const frameTree = await this.cdp.send<{ frameTree?: FrameTreeNode }>('Page.getFrameTree');
    const currentFrame = findFrame(frameTree.frameTree, initial.frameId);
    if (!currentFrame?.frame.loaderId) throw new BrowserError('STALE_SNAPSHOT', 'The target frame document is no longer attached.', true);
    const handle = this.refs.resolve(ref, {
      tabId: context.tabId,
      documentEpoch: context.documentEpoch,
      expectedTargetId: context.targetId,
      currentLoaderId: currentFrame.frame.loaderId,
    });
    const [description, ax] = await Promise.all([
      this.cdp.send<DescribeNodeResult>('DOM.describeNode', { backendNodeId: handle.backendNodeId, depth: 0 }),
      this.cdp.send<QueryAxResult>('Accessibility.getPartialAXTree', { backendNodeId: handle.backendNodeId, fetchRelatives: true }),
    ]);
    const attributes = flatAttributes(description.node.attributes);
    const axNode = ax.nodes?.find((node) => node.backendDOMNodeId === handle.backendNodeId) ?? ax.nodes?.[0];
    const role = primitiveText(axNode?.role?.value) || null;
    const name = primitiveText(axNode?.name?.value) || null;
    const parentAxNode = axNode?.parentId ? ax.nodes?.find((node) => node.nodeId === axNode.parentId) : undefined;
    const liveAncestorHash = parentAxNode
      ? fingerprintHash(`${primitiveText(parentAxNode.role?.value)}\n${primitiveText(parentAxNode.name?.value)}`)
      : null;
    const expected = handle.fingerprint;
    if (description.node.backendNodeId !== handle.backendNodeId
      || description.node.nodeName.toLowerCase() !== expected.tagName
      || role !== expected.role
      || name !== expected.accessibleName
      || !stableAttributesMatch(expected.stableAttributes, attributes)
      || fingerprintHash(name ?? '') !== expected.nearbyTextHash
      || liveAncestorHash !== expected.ancestorHash) {
      throw new BrowserError('STALE_SNAPSHOT', `Element ref ${ref} no longer matches the captured element.`, true);
    }
    const disabled = axNode?.properties?.some((property) => property.name === 'disabled' && property.value?.value === true);
    if (disabled) throw new BrowserError('ACTION_BLOCKED', 'The target element is disabled.');
    if (description.node.nodeId && this.cdp.supports('CSS')) {
      const computed = await this.cdp.send<{ computedStyle?: Array<{ name?: string; value?: string }> }>(
        'CSS.getComputedStyleForNode',
        { nodeId: description.node.nodeId },
      ).catch(() => ({ computedStyle: [] }));
      const style = new Map((computed.computedStyle ?? []).flatMap((property) => property.name && property.value ? [[property.name, property.value] as const] : []));
      if (style.get('display') === 'none' || style.get('visibility') === 'hidden' || style.get('visibility') === 'collapse' || Number(style.get('opacity') ?? '1') <= 0) {
        throw new BrowserError('STALE_SNAPSHOT', 'The target element is no longer visible.', true);
      }
    }
    if (attributes.type?.toLowerCase() === 'file') {
      throw new BrowserError('UNSUPPORTED_ACTION', 'File uploads require human takeover in this browser release.');
    }
    return {
      handle,
      node: description.node,
      attributes,
      frameUrl: safeFrameUrl(currentFrame.frame.url, handle.frameOrigin, context.url),
    };
  }

  private async actionForElement(
    target: VerifiedBrowserElement,
    kind: 'click',
    pageOrigin: string,
  ): Promise<ProposedBrowserAction> {
    const consequence = derivedConsequence(target.handle);
    const action = actionFor(target.handle, kind, consequence, pageOrigin);
    // Destination-bearing attributes are derived from the live DOM, not only
    // from the snapshot fingerprint. An attribute added after capture must not
    // bypass destination or download policy.
    delete action.destinationUrl;
    const tagName = target.node.nodeName.toLowerCase();
    if ((tagName === 'a' || tagName === 'area') && Object.prototype.hasOwnProperty.call(target.attributes, 'href')) {
      const rawHref = target.attributes.href ?? '';
      if (rawHref.length > 8_192) throw new BrowserError('ACTION_BLOCKED', 'The link destination is too large to verify safely.');
      const path = await this.pathToDocument(target.node);
      const documentNodeId = path.at(-1)?.nodeId;
      if (!documentNodeId) throw new BrowserError('ACTION_BLOCKED', 'The link document could not be verified.');
      action.destinationUrl = await this.documentRelativeUrl(rawHref, documentNodeId, target.frameUrl);
      if (Object.prototype.hasOwnProperty.call(target.attributes, 'download')) {
        action.kind = 'download';
        action.consequence = 'external-data-transfer';
      }
    }
    if (!isSubmitControl(target.node.nodeName, target.attributes)) return action;

    const form = await this.associatedForm(target.node, target.attributes);
    if (!form) return action;
    return {
      ...action,
      kind: 'submit',
      destinationUrl: await this.formDestination(form, target.attributes, target.frameUrl),
      ...(await this.formContainsSensitiveControl(form) ? { textClassification: 'secret' as const } : {}),
      consequence: consequence === 'none' ? 'account' : consequence,
    };
  }

  private async actionForFocusedKey(
    context: BrowserActionContext,
    stroke: BrowserKeyStroke,
  ): Promise<{ action: ProposedBrowserAction; backendNodeId?: number }> {
    const key = stroke.key;
    const action: ProposedBrowserAction = {
      kind: 'press',
      origin: context.origin,
      frameOrigin: context.origin,
      consequence: key === 'Enter' ? 'account' : 'none',
    };
    const document = await this.cdp.send<DocumentResult>('DOM.getDocument', { depth: 0, pierce: false });
    const documentNodeId = document.root.nodeId;
    if (!documentNodeId) throw new BrowserError('ACTION_BLOCKED', 'The focused browser document could not be verified.');
    const focused = await this.cdp.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: documentNodeId,
      selector: ':focus',
    });
    if (!focused.nodeId) return { action };

    const description = await this.cdp.send<DescribeNodeResult>('DOM.describeNode', { nodeId: focused.nodeId, depth: 0 });
    const tagName = description.node.nodeName.toLowerCase();
    if (tagName === 'iframe') {
      throw new BrowserError('ACTION_BLOCKED', 'Keyboard actions require a verified focused frame; take over or focus a semantic element first.');
    }
    const attributes = flatAttributes(description.node.attributes);
    const editsFocusedValue = stroke.printable || key === 'Enter' || key === 'Backspace' || key === 'Delete';
    if (editsFocusedValue && isSensitiveLiveNode(attributes)) action.textClassification = 'secret';
    if (key === 'Enter' && (tagName === 'a' || tagName === 'area') && Object.prototype.hasOwnProperty.call(attributes, 'href')) {
      const rawHref = attributes.href ?? '';
      if (rawHref.length > 8_192) throw new BrowserError('ACTION_BLOCKED', 'The link destination is too large to verify safely.');
      action.destinationUrl = await this.documentRelativeUrl(rawHref, documentNodeId, context.url);
      if (Object.prototype.hasOwnProperty.call(attributes, 'download')) {
        action.kind = 'download';
        action.consequence = 'external-data-transfer';
      }
    }
    const activatesSubmit = (key === 'Enter' || key === ' ') && isSubmitControl(description.node.nodeName, attributes);
    const implicitlySubmits = key === 'Enter' && isImplicitSubmitInput(description.node.nodeName, attributes);
    if (activatesSubmit || implicitlySubmits) {
      const form = await this.associatedForm(description.node, attributes);
      if (form) {
        action.kind = 'submit';
        action.destinationUrl = await this.formDestination(form, attributes, context.url);
        if (await this.formContainsSensitiveControl(form)) action.textClassification = 'secret';
        if (action.consequence === 'none') action.consequence = 'account';
      }
    }
    return { action, backendNodeId: description.node.backendNodeId };
  }

  private async associatedForm(node: LiveDomNode, attributes: Readonly<Record<string, string>>): Promise<LiveFormDetails | null> {
    const path = await this.pathToDocument(node);
    const documentNode = path.at(-1);
    if (!documentNode?.nodeId || !isDocumentNode(documentNode)) {
      throw new BrowserError('ACTION_BLOCKED', 'The browser could not verify the form document.');
    }

    if (Object.prototype.hasOwnProperty.call(attributes, 'form')) {
      const formId = attributes.form ?? '';
      if (!formId) return null;
      if (formId.length > 500) throw new BrowserError('ACTION_BLOCKED', 'The form association is too large to verify safely.');
      const match = await this.cdp.send<{ nodeId: number }>('DOM.querySelector', {
        nodeId: documentNode.nodeId,
        selector: `[id=${cssString(formId)}]`,
      }).catch(() => {
        throw new BrowserError('ACTION_BLOCKED', 'The browser could not verify the form association.');
      });
      if (!match.nodeId) return null;
      const form = await this.cdp.send<DescribeNodeResult>('DOM.describeNode', { nodeId: match.nodeId, depth: 0 });
      if (form.node.nodeName.toLowerCase() !== 'form') return null;
      return { attributes: flatAttributes(form.node.attributes), documentNodeId: documentNode.nodeId, formNodeId: match.nodeId };
    }

    const form = path.slice(1, -1).find((candidate) => candidate.nodeName.toLowerCase() === 'form');
    if (!form) return null;
    if (!form.nodeId) throw new BrowserError('ACTION_BLOCKED', 'The browser could not bind the target form.');
    return { attributes: flatAttributes(form.attributes), documentNodeId: documentNode.nodeId, formNodeId: form.nodeId };
  }

  private async pathToDocument(initial: LiveDomNode): Promise<LiveDomNode[]> {
    let current = initial;
    if (!current.parentId && !isDocumentNode(current)) {
      await this.cdp.send<DocumentResult>('DOM.getDocument', { depth: 0, pierce: true });
      const pushed = await this.cdp.send<{ nodeIds?: number[] }>('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: [current.backendNodeId],
      });
      const nodeId = pushed.nodeIds?.[0];
      if (!nodeId) throw new BrowserError('ACTION_BLOCKED', 'The browser could not bind the target to its live document.');
      current = (await this.cdp.send<DescribeNodeResult>('DOM.describeNode', { nodeId, depth: 0 })).node;
    }

    const path: LiveDomNode[] = [];
    const visited = new Set<number>();
    for (let depth = 0; depth < 64; depth += 1) {
      path.push(current);
      if (isDocumentNode(current)) return path;
      if (!current.parentId || visited.has(current.parentId)) {
        throw new BrowserError('ACTION_BLOCKED', 'The browser could not verify the target form ancestry.');
      }
      visited.add(current.parentId);
      current = (await this.cdp.send<DescribeNodeResult>('DOM.describeNode', { nodeId: current.parentId, depth: 0 })).node;
    }
    throw new BrowserError('ACTION_BLOCKED', 'The target form ancestry exceeded the verification limit.');
  }

  private async formContainsSensitiveControl(form: LiveFormDetails): Promise<boolean> {
    const controls = [
      'input[type="password" i]',
      'input[type="file" i]',
      'input[autocomplete~="current-password" i]',
      'input[autocomplete~="new-password" i]',
      'input[autocomplete~="one-time-code" i]',
      'input[autocomplete~="cc-number" i]',
      'input[autocomplete~="cc-csc" i]',
      'input[autocomplete^="cc-exp" i]',
    ];
    const query = async (nodeId: number, selector: string) => this.cdp.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId,
      selector,
    }).catch(() => {
      throw new BrowserError('ACTION_BLOCKED', 'The browser could not verify whether the form contains protected data.');
    });
    if ((await query(form.formNodeId, controls.join(','))).nodeId) return true;
    const formId = form.attributes.id;
    if (!formId || formId.length > 500) return false;
    const external = controls.map((selector) => selector.replace(/^input/u, `input[form=${cssString(formId)}]`));
    return Boolean((await query(form.documentNodeId, external.join(','))).nodeId);
  }

  private async formDestination(
    form: LiveFormDetails,
    submitterAttributes: Readonly<Record<string, string>>,
    documentUrl: string,
  ): Promise<string> {
    const hasSubmitterOverride = Object.prototype.hasOwnProperty.call(submitterAttributes, 'formaction');
    const rawDestination = hasSubmitterOverride
      ? submitterAttributes.formaction ?? ''
      : form.attributes.action ?? '';
    if (rawDestination.length > 8_192) throw new BrowserError('ACTION_BLOCKED', 'The form destination is too large to verify safely.');
    if (!rawDestination.trim()) return requireDocumentUrl(documentUrl);
    return this.documentRelativeUrl(rawDestination, form.documentNodeId, documentUrl);
  }

  private async documentRelativeUrl(raw: string, documentNodeId: number, documentUrl: string): Promise<string> {
    let baseUrl = requireDocumentUrl(documentUrl);
    const baseMatch = await this.cdp.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: documentNodeId,
      selector: 'base[href]',
    });
    if (baseMatch.nodeId) {
      const base = await this.cdp.send<DescribeNodeResult>('DOM.describeNode', { nodeId: baseMatch.nodeId, depth: 0 });
      const href = flatAttributes(base.node.attributes).href ?? '';
      if (href.length > 8_192) throw new BrowserError('ACTION_BLOCKED', 'The document base URL is too large to verify safely.');
      try {
        baseUrl = new URL(href, baseUrl).href;
      } catch {
        throw new BrowserError('ACTION_BLOCKED', 'The document base URL could not be verified.');
      }
    }
    try {
      return new URL(raw, baseUrl).href;
    } catch {
      throw new BrowserError('ACTION_BLOCKED', 'The action destination could not be verified.');
    }
  }

  private async findActionPoint(
    target: VerifiedBrowserElement,
    preferred?: { x: number; y: number } | null,
  ): Promise<{ x: number; y: number } | null> {
    const attempt = async () => {
      const points = await this.actionPoints(target.handle.backendNodeId);
      const candidates = preferred ? [preferred, ...points.filter((point) => pointDistance(point, preferred) > 1)] : points;
      for (const candidate of candidates) {
        const hit = await this.cdp.send<LocationResult>('DOM.getNodeForLocation', {
          x: Math.round(candidate.x),
          y: Math.round(candidate.y),
          includeUserAgentShadowDOM: true,
          ignorePointerEventsNone: false,
        });
        if (await this.isAcceptableHit(hit, target)) return candidate;
      }
      return null;
    };

    const initial = await attempt();
    if (initial) return initial;
    await this.waitForLayout();
    await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.handle.backendNodeId });
    return attempt();
  }

  private async actionPoints(backendNodeId: number): Promise<Array<{ x: number; y: number }>> {
    const content = await this.cdp.send<ContentQuadsResult>('DOM.getContentQuads', { backendNodeId })
      .catch(() => ({ quads: [] }));
    let quads = (content.quads ?? []).filter((quad) => quad.length >= 8 && quadArea(quad) > 1);
    if (quads.length === 0) {
      const result = await this.cdp.send<BoxModelResult>('DOM.getBoxModel', { backendNodeId });
      const quad = result.model?.content ?? result.model?.border;
      if (quad && quad.length >= 8 && quadArea(quad) > 1) quads = [quad];
    }
    if (quads.length === 0) throw new BrowserError('STALE_SNAPSHOT', 'The target has no visible box.', true);

    const metrics: {
      visualViewport?: { clientWidth?: number; clientHeight?: number };
      layoutViewport?: { clientWidth?: number; clientHeight?: number };
    } = await this.cdp.send<{
      visualViewport?: { clientWidth?: number; clientHeight?: number };
      layoutViewport?: { clientWidth?: number; clientHeight?: number };
    }>('Page.getLayoutMetrics').catch(() => ({}));
    const viewport = metrics.visualViewport ?? metrics.layoutViewport;
    const width = viewport?.clientWidth;
    const height = viewport?.clientHeight;
    const fractions = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8], [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5]];
    const seen = new Set<string>();
    const points: Array<{ x: number; y: number }> = [];
    for (const quad of quads) {
      for (const [u, v] of fractions) {
        const point = pointInQuad(quad, u!, v!);
        if (point.x < 0 || point.y < 0 || (width !== undefined && point.x >= width) || (height !== undefined && point.y >= height)) continue;
        const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        points.push(point);
      }
    }
    if (points.length === 0) throw new BrowserError('STALE_SNAPSHOT', 'The target is outside the visible viewport.', true);
    return points;
  }

  private async isAcceptableHit(hit: LocationResult, target: VerifiedBrowserElement): Promise<boolean> {
    const expectedBackendNodeId = target.handle.backendNodeId;
    if (hit.backendNodeId === expectedBackendNodeId) return true;
    const hitNode = await this.describeHit(hit);
    if (!hitNode) return false;

    // A child (icon, text, pseudo-host, or shadow descendant) receives the
    // pointer event and bubbles it to the verified semantic target.
    let current: LiveDomNode | undefined = hitNode;
    const descendants = new Set<number>();
    for (let depth = 0; current && depth < 64; depth += 1) {
      if (current.backendNodeId === expectedBackendNodeId) return true;
      if (!current.parentId || descendants.has(current.parentId)) break;
      descendants.add(current.parentId);
      current = (await this.cdp.send<DescribeNodeResult>('DOM.describeNode', { nodeId: current.parentId, depth: 0 })).node;
    }

    // Labels and composite controls can expose a semantic child while a nearby
    // clickable ancestor owns hit testing. Accept only a bounded, interactive
    // ancestor—not an unrelated page-wide overlay.
    current = await this.bindFrontEndNode(target.node);
    const ancestors = new Set<number>();
    for (let depth = 0; current && depth <= 6; depth += 1) {
      if (current.backendNodeId === hitNode.backendNodeId) return depth > 0 && await this.isVerifiedClickOwner(current, target);
      if (!current.parentId || ancestors.has(current.parentId)) break;
      ancestors.add(current.parentId);
      current = (await this.cdp.send<DescribeNodeResult>('DOM.describeNode', { nodeId: current.parentId, depth: 0 })).node;
    }
    return false;
  }

  private async isVerifiedClickOwner(owner: LiveDomNode, target: VerifiedBrowserElement): Promise<boolean> {
    if (!isClickableOwner(owner)) return false;
    const ownerTag = owner.nodeName.toLocaleLowerCase('en-US');
    const targetTag = target.node.nodeName.toLocaleLowerCase('en-US');
    if (ownerTag === 'label' && new Set(['input', 'select', 'textarea']).has(targetTag)) return true;
    const ax = await this.cdp.send<QueryAxResult>('Accessibility.getPartialAXTree', {
      backendNodeId: owner.backendNodeId,
      fetchRelatives: false,
    }).catch(() => ({ nodes: [] }));
    const ownerAx = ax.nodes?.find((node) => node.backendDOMNodeId === owner.backendNodeId);
    return primitiveText(ownerAx?.role?.value) === target.handle.fingerprint.role
      && primitiveText(ownerAx?.name?.value) === target.handle.fingerprint.accessibleName;
  }

  private async describeHit(hit: LocationResult): Promise<LiveDomNode | null> {
    if (hit.nodeId) return (await this.cdp.send<DescribeNodeResult>('DOM.describeNode', { nodeId: hit.nodeId, depth: 0 })).node;
    if (hit.backendNodeId) return (await this.cdp.send<DescribeNodeResult>('DOM.describeNode', { backendNodeId: hit.backendNodeId, depth: 0 })).node;
    return null;
  }

  private async bindFrontEndNode(node: LiveDomNode): Promise<LiveDomNode> {
    if (node.nodeId) return node;
    const pushed = await this.cdp.send<{ nodeIds?: number[] }>('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [node.backendNodeId],
    });
    const nodeId = pushed.nodeIds?.[0];
    if (!nodeId) return node;
    return (await this.cdp.send<DescribeNodeResult>('DOM.describeNode', { nodeId, depth: 0 })).node;
  }

  private async waitForLayout(): Promise<void> {
    if (!this.cdp.supports('Runtime')) return;
    await this.cdp.send('Runtime.evaluate', {
      expression: 'new Promise((resolve) => requestAnimationFrame(() => resolve()))',
      awaitPromise: true,
      returnByValue: true,
      silent: true,
    }).catch(() => undefined);
  }

  private assertStillAuthorized(action: ProposedBrowserAction, confirmed: boolean): void {
    const decision = this.gate.evaluate(action);
    if (decision.outcome === 'block' || (decision.outcome === 'confirm' && !confirmed)) {
      throw new BrowserError('ACTION_BLOCKED', `The browser action is no longer allowed: ${decision.reason}`);
    }
  }

  private async authorize(action: ProposedBrowserAction, binding: BrowserConfirmationBinding): Promise<boolean> {
    const decision = this.gate.evaluate(action);
    if (decision.outcome === 'block') throw new BrowserError('ACTION_BLOCKED', decision.reason);
    if (decision.outcome === 'allow') return false;
    if (!await this.confirm(action, decision.reason, binding)) throw new BrowserError('ACTION_BLOCKED', 'The browser action was not confirmed.');
    const currentDecision = this.gate.evaluate(action);
    if (currentDecision.outcome === 'block') throw new BrowserError('ACTION_BLOCKED', `The browser action is no longer allowed: ${currentDecision.reason}`);
    return true;
  }
}

function actionFor(handle: BrowserElementHandle, kind: 'click' | 'type', consequence: BrowserConsequence, pageOrigin: string): ProposedBrowserAction {
  const action: ProposedBrowserAction = {
    kind,
    origin: pageOrigin,
    frameOrigin: handle.frameOrigin,
    consequence,
  };
  if (handle.fingerprint.role) action.targetRole = handle.fingerprint.role;
  if (handle.fingerprint.accessibleName) action.targetName = handle.fingerprint.accessibleName;
  const destination = handle.fingerprint.stableAttributes.formaction ?? handle.fingerprint.stableAttributes.href;
  if (destination) {
    try { action.destinationUrl = new URL(destination, pageOrigin).href; } catch { /* malformed targets are rejected by live hit validation instead of followed by Fate. */ }
  }
  return action;
}
function isSensitiveHandle(
  handle: BrowserElementHandle,
  liveAttributes: Readonly<Record<string, string>> = {},
): boolean {
  const attributes = { ...handle.fingerprint.stableAttributes, ...liveAttributes };
  const identity = `${attributes.type ?? ''} ${attributes.autocomplete ?? ''} ${attributes.name ?? ''} ${attributes.id ?? ''} ${handle.fingerprint.accessibleName ?? ''}`;
  return attributes.type?.toLowerCase() === 'password'
    || /(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|password|passwd|otp|secret|token|credit.?card|card.?number|\bcvv\b|\bcvc\b|security.?code|card.?expir|\bpin\b)/iu.test(identity);
}
function classifyTypedText(
  text: string,
  handle: BrowserElementHandle,
  liveAttributes: Readonly<Record<string, string>> = {},
): 'public' | 'secret' {
  if (isSensitiveHandle(handle, liveAttributes)) return 'secret';
  const bounded = text.slice(0, 100_000);
  if (containsPaymentCardNumber(bounded)) return 'secret';
  return /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b|\b(?:sk|pk|rk)-(?:live|test)-[A-Za-z0-9_-]{12,}\b|\b(?:gh[opusr]|github_pat)_[A-Za-z0-9_]{16,}\b|\bAKIA[A-Z0-9]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u.test(bounded)
    ? 'secret'
    : 'public';
}
function derivedConsequence(handle: BrowserElementHandle): BrowserConsequence {
  const identity = `${handle.fingerprint.role ?? ''} ${handle.fingerprint.accessibleName ?? ''} ${handle.fingerprint.stableAttributes.type ?? ''}`.toLowerCase();
  if (/\b(pay|purchase|buy|checkout|order)\b/u.test(identity)) return 'financial';
  if (/\b(delete|remove|destroy|erase|cancel account)\b/u.test(identity)) return 'destructive';
  if (/\b(send|message|publish|post|comment|email)\b/u.test(identity)) return 'communication';
  if (/\b(upload|download|export|share)\b/u.test(identity)) return 'external-data-transfer';
  if (handle.fingerprint.stableAttributes.type === 'submit' || /\b(submit|sign in|log in|create account|confirm|continue)\b/u.test(identity)) return 'account';
  return 'none';
}
function targetSummary(handle: BrowserElementHandle): string {
  const role = handle.fingerprint.role ?? handle.fingerprint.tagName;
  const name = handle.fingerprint.accessibleName
    ? redactPotentialSecretText(handle.fingerprint.accessibleName, 1_000)
    : null;
  return name ? `${role} ${JSON.stringify(name)}` : role;
}
function flatAttributes(encoded: readonly string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!encoded) return result;
  for (let index = 0; index + 1 < encoded.length; index += 2) {
    const name = encoded[index];
    if (name) result[name.toLowerCase()] = encoded[index + 1] ?? '';
  }
  return result;
}
function stableAttributesMatch(expected: Readonly<Record<string, string>>, actual: Readonly<Record<string, string>>): boolean {
  return Object.entries(expected).every(([name, value]) => actual[name] === value);
}
function primitiveText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}
function quadArea(quad: readonly number[]): number {
  const points = [0, 2, 4, 6].map((index) => ({ x: quad[index] ?? 0, y: quad[index + 1] ?? 0 }));
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}
function pointInQuad(quad: readonly number[], u: number, v: number): { x: number; y: number } {
  const point = (index: number) => ({ x: quad[index] ?? 0, y: quad[index + 1] ?? 0 });
  const topLeft = point(0); const topRight = point(2); const bottomRight = point(4); const bottomLeft = point(6);
  const top = { x: topLeft.x + (topRight.x - topLeft.x) * u, y: topLeft.y + (topRight.y - topLeft.y) * u };
  const bottom = { x: bottomLeft.x + (bottomRight.x - bottomLeft.x) * u, y: bottomLeft.y + (bottomRight.y - bottomLeft.y) * u };
  return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
}
function pointDistance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
function isClickableOwner(node: LiveDomNode): boolean {
  const tag = node.nodeName.toLocaleLowerCase('en-US');
  const attributes = flatAttributes(node.attributes);
  const role = attributes.role?.toLocaleLowerCase('en-US');
  return new Set(['button', 'a', 'area', 'label', 'input', 'select', 'option', 'summary']).has(tag)
    || new Set(['button', 'link', 'checkbox', 'radio', 'menuitem', 'option', 'switch', 'tab', 'treeitem']).has(role ?? '')
    || Object.prototype.hasOwnProperty.call(attributes, 'onclick')
    || Object.prototype.hasOwnProperty.call(attributes, 'tabindex');
}
function normalizeKey(input: string): BrowserKeyStroke {
  const raw = input === ' ' ? input : input.trim();
  if (!raw) throw new BrowserError('UNSUPPORTED_ACTION', 'A browser key is required.');
  const pieces = raw === ' ' ? ['space'] : raw === '+' ? [raw] : raw.split('+').map((piece) => piece.trim()).filter(Boolean);
  const modifiersByName: Record<string, { bit: number; label: string }> = {
    alt: { bit: 1, label: 'Alt' }, option: { bit: 1, label: 'Alt' },
    control: { bit: 2, label: 'Control' }, ctrl: { bit: 2, label: 'Control' },
    meta: { bit: 4, label: 'Meta' }, cmd: { bit: 4, label: 'Meta' }, command: { bit: 4, label: 'Meta' },
    shift: { bit: 8, label: 'Shift' },
  };
  let modifiers = 0;
  const modifierLabels: string[] = [];
  const base: string[] = [];
  for (const piece of pieces) {
    const modifier = modifiersByName[piece.toLocaleLowerCase('en-US')];
    if (!modifier) {
      base.push(piece);
      continue;
    }
    modifiers |= modifier.bit;
    if (!modifierLabels.includes(modifier.label)) modifierLabels.push(modifier.label);
  }
  if (base.length !== 1) throw new BrowserError('UNSUPPORTED_ACTION', `The browser key chord ${JSON.stringify(input)} is invalid.`);

  const aliases: Record<string, string> = {
    return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab',
    space: ' ', spacebar: ' ', backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
    arrowup: 'ArrowUp', up: 'ArrowUp', arrowdown: 'ArrowDown', down: 'ArrowDown',
    arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight', right: 'ArrowRight',
  };
  const requested = base[0]!;
  const lower = requested.toLocaleLowerCase('en-US');
  let key = aliases[lower] ?? requested;
  if (/^f(?:[1-9]|1\d|2[0-4])$/u.test(lower)) key = lower.toUpperCase();
  const named = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ']);
  const characters = [...key];
  const printable = characters.length === 1 && !/[\u0000-\u001f\u007f]/u.test(key);
  if (!named.has(key) && !/^F(?:[1-9]|1\d|2[0-4])$/u.test(key) && !printable) {
    throw new BrowserError('UNSUPPORTED_ACTION', `The browser key ${JSON.stringify(input)} is not supported.`);
  }
  if (printable && (modifiers & 8) !== 0 && /^\p{Ll}$/u.test(key)) key = key.toLocaleUpperCase('en-US');
  const code = keyCode(key);
  const displayKey = key === ' ' ? 'Space' : key;
  return {
    key,
    ...(code ? { code } : {}),
    modifiers,
    printable,
    label: [...modifierLabels, displayKey].join('+'),
  };
}

function keyCode(key: string): string | undefined {
  if (/^[A-Za-z]$/u.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/u.test(key)) return `Digit${key}`;
  if (key === ' ') return 'Space';
  if (new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']).has(key)) return key;
  if (/^F(?:[1-9]|1\d|2[0-4])$/u.test(key)) return key;
  return undefined;
}
function isSubmitControl(nodeName: string, attributes: Readonly<Record<string, string>>): boolean {
  const tagName = nodeName.toLowerCase();
  const type = (attributes.type ?? '').trim().toLowerCase();
  if (tagName === 'input') return type === 'submit' || type === 'image';
  if (tagName !== 'button') return false;
  return type !== 'button' && type !== 'reset';
}
function isImplicitSubmitInput(nodeName: string, attributes: Readonly<Record<string, string>>): boolean {
  if (nodeName.toLowerCase() !== 'input') return false;
  const type = (attributes.type ?? 'text').trim().toLowerCase();
  return !new Set(['button', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'hidden', 'submit', 'image']).has(type);
}
function isSensitiveLiveNode(attributes: Readonly<Record<string, string>>): boolean {
  const identity = `${attributes.type ?? ''} ${attributes.autocomplete ?? ''} ${attributes.name ?? ''} ${attributes.id ?? ''}`;
  return attributes.type?.toLowerCase() === 'password'
    || /(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|password|passwd|otp|secret|token|credit.?card|card.?number|\bcvv\b|\bcvc\b|security.?code|card.?expir|\bpin\b)/iu.test(identity);
}
function isDocumentNode(node: LiveDomNode): boolean {
  const name = node.nodeName.toLowerCase();
  return name === '#document' || name === 'document';
}
function cssString(value: string): string {
  let result = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === '"' || character === '\\') result += `\\${character}`;
    else if (codePoint === 0) result += '\uFFFD';
    else if (codePoint <= 0x1f || codePoint === 0x7f) result += `\\${codePoint.toString(16)} `;
    else result += character;
  }
  return `${result}"`;
}
function safeFrameUrl(rawFrameUrl: string | undefined, frameOrigin: string, contextUrl: string): string {
  for (const candidate of [rawFrameUrl, contextUrl]) {
    if (!candidate) continue;
    try {
      const url = verifiedDocumentUrl(candidate);
      if (verifiedDocumentOrigin(url) === frameOrigin) return url.href;
    } catch { /* Try the next trusted source. */ }
  }
  return requireDocumentUrl(`${frameOrigin}/`);
}
function requireDocumentUrl(value: string): string {
  try {
    return verifiedDocumentUrl(value).href;
  } catch { /* Report the bounded browser error below. */ }
  throw new BrowserError('ACTION_BLOCKED', 'The browser document URL could not be verified.');
}
function verifiedDocumentUrl(value: string): URL {
  const url = new URL(value);
  const networkDocument = (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  const localDocument = url.protocol === 'fate-local:'
    && !url.username
    && !url.password
    && !url.port
    && /^[a-f0-9]{48}$/u.test(url.hostname);
  if (!networkDocument && !localDocument) throw new Error('Unsupported browser document URL.');
  return url;
}
function verifiedDocumentOrigin(url: URL): string {
  return url.protocol === 'fate-local:' ? `fate-local://${url.hostname}` : url.origin;
}
interface FrameTreeNode { frame: { id: string; loaderId?: string; url?: string }; childFrames?: FrameTreeNode[] }
function findFrame(node: FrameTreeNode | undefined, frameId: string): FrameTreeNode | undefined {
  if (!node) return undefined;
  if (node.frame.id === frameId) return node;
  for (const child of node.childFrames ?? []) {
    const found = findFrame(child, frameId);
    if (found) return found;
  }
  return undefined;
}
function assertActionCurrent(context: BrowserActionContext): void {
  assertNotAborted(context.signal);
  context.assertCurrent?.();
}
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Browser action aborted.', 'AbortError');
}
