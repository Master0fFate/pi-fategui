import type { BrowserBounds } from '../../../shared/contracts/ipc';

const MAX_BOUNDS_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;

// Transforms matter on the ancestor path, but not on adjacent layout boxes.
// Ignore paint-only effects (spinners, opacity, shadows) when following motion.
function movesLayout(property: string, ancestor: boolean): boolean {
  const name = property.replaceAll('-', '').toLowerCase();
  return /^(width|height|minwidth|minheight|maxwidth|maxheight|top|right|bottom|left|inset.*|margin.*|padding.*|border.*width|gap|rowgap|columngap|grid.*|flex.*|align.*|justify.*|place.*|font.*|lineheight|letterspacing|wordspacing|zoom)$/.test(name)
    // `offset` alone is keyframe timing metadata, not the CSS motion path.
    || (ancestor && /^(transform.*|translate|rotate|scale|perspective.*|offset(anchor|distance|path|position|rotate))$/.test(name));
}

/** Align a native WebContentsView without doing renderer layout work at rest. */
export function observeBrowserViewportBounds(
  node: HTMLElement,
  setBounds: (bounds: BrowserBounds) => Promise<unknown>,
  onError: (error: unknown) => void,
): () => void {
  let disposed = false;
  let frame: number | null = null;
  let retryTimer: number | null = null;
  let inFlight = false;
  let appliedKey = '';
  let latest: { bounds: BrowserBounds; key: string; attempts: number } | null = null;
  let ancestors = new Set<Element>();
  let layoutElements = new Set<Element>();
  const motion = new Map<Animation, Element>();
  const motionCandidates = new Set<Element>();
  const viewport = window.visualViewport;
  const fonts = document.fonts;

  function schedule() {
    if (!disposed && frame === null) frame = window.requestAnimationFrame(measure);
  }

  function clearRetry() {
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    retryTimer = null;
  }

  async function flush() {
    if (disposed || inFlight || retryTimer !== null || !latest || latest.key === appliedKey || latest.attempts >= MAX_BOUNDS_ATTEMPTS) return;
    const sent = latest;
    sent.attempts += 1;
    inFlight = true;
    let failed = false;
    try {
      await setBounds(sent.bounds);
      appliedKey = sent.key;
    } catch (error) {
      // A rejected reply does not prove the native side never applied it.
      appliedKey = '';
      failed = true;
      if (!disposed) onError(error);
    } finally {
      inFlight = false;
      if (!disposed) {
        // A resize can finish while IPC is pending. Send its final bounds even
        // if there will be no further DOM event to wake the tracker.
        if (latest !== sent) void flush();
        else if (failed && sent.attempts < MAX_BOUNDS_ATTEMPTS) {
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            schedule();
          }, RETRY_DELAY_MS * 2 ** (sent.attempts - 1));
        }
      }
    }
  }

  function measure() {
    frame = null;
    if (disposed) return;
    for (const element of motionCandidates) if (layoutElements.has(element)) collectMotion(element);
    motionCandidates.clear();
    const rect = node.getBoundingClientRect();
    const bounds = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    // Main converts CSS pixels using the renderer zoom. A zoom/monitor change
    // must resend even if a fixed-size device frame has the same CSS bounds.
    const key = `${bounds.x.toFixed(2)}:${bounds.y.toFixed(2)}:${bounds.width.toFixed(2)}:${bounds.height.toFixed(2)}:${window.devicePixelRatio}:${viewport?.scale ?? 1}`;
    if (key !== latest?.key) {
      latest = { bounds, key, attempts: 0 };
      clearRetry();
    }
    void flush();
    for (const [animation, element] of motion) {
      if (!element.isConnected || !layoutElements.has(element) || (!animation.pending && animation.playState !== 'running')) motion.delete(animation);
    }
    // Only real, currently running geometry animations get per-frame reads.
    // Cancellation/finish removes them, including transitions already in
    // progress when this viewport mounts; no settle/idle polling is needed.
    if (motion.size > 0) schedule();
  }

  function collectMotion(element: Element) {
    for (const animation of element.getAnimations?.() ?? []) {
      const effect = animation.effect as KeyframeEffect | null;
      if (effect?.getKeyframes().some((keyframe) => Object.keys(keyframe).some((property) => movesLayout(property, ancestors.has(element))))) {
        motion.set(animation, element);
      }
    }
  }

  const resizeObserver = new ResizeObserver(schedule);
  const mutationObserver = new MutationObserver((records) => {
    if (disposed) return;
    if (records.some((record) => record.type === 'childList')) observeLayout();
    for (const record of records) {
      if (record.target instanceof Element && layoutElements.has(record.target)) motionCandidates.add(record.target);
    }
    schedule();
  });

  function observeLayout() {
    const nextAncestors = new Set<Element>();
    const nextElements = new Set<Element>();
    for (let element: Element | null = node; element; element = element.parentElement) {
      nextAncestors.add(element);
      nextElements.add(element);
      // A toolbar, header, or flex/grid sibling can move a fixed-size device
      // frame without resizing the reservation or any of its ancestors.
      if (element !== node) for (const child of element.children) nextElements.add(child);
    }
    for (const element of layoutElements) if (!nextElements.has(element)) resizeObserver.unobserve(element);
    for (const element of nextElements) if (!layoutElements.has(element)) resizeObserver.observe(element, { box: 'border-box' });
    ancestors = nextAncestors;
    layoutElements = nextElements;
    mutationObserver.disconnect();
    for (const element of layoutElements) {
      // Deliberately shallow: streaming chat descendants cannot invalidate the
      // browser unless their containing layout box actually changes size.
      mutationObserver.observe(element, { attributes: true, childList: element !== node && ancestors.has(element) });
      motionCandidates.add(element);
    }
  }

  function onScroll(event: Event) {
    if (event.target === window || event.target === document || (event.target instanceof Element && ancestors.has(event.target))) schedule();
  }

  function onMotion(event: Event) {
    if (event.target instanceof Element && layoutElements.has(event.target)) {
      motionCandidates.add(event.target);
      schedule();
    }
  }

  const motionEvents = ['transitionrun', 'transitionstart', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel'] as const;
  observeLayout();
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', onScroll, true);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  document.addEventListener('visibilitychange', schedule);
  fonts?.addEventListener('loadingdone', schedule);
  for (const event of motionEvents) document.addEventListener(event, onMotion, true);
  schedule();

  return () => {
    disposed = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    clearRetry();
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', onScroll, true);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    document.removeEventListener('visibilitychange', schedule);
    fonts?.removeEventListener('loadingdone', schedule);
    for (const event of motionEvents) document.removeEventListener(event, onMotion, true);
    motion.clear();
    motionCandidates.clear();
  };
}
