import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { BrowserBounds } from '../../../shared/contracts/ipc';
import { observeBrowserViewportBounds } from './browserViewportBounds';

class ResizeObserverMock {
  static current: ResizeObserverMock;
  readonly elements = new Set<Element>();
  readonly disconnect = vi.fn(() => this.elements.clear());
  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.current = this;
  }
  observe(element: Element) { this.elements.add(element); }
  unobserve(element: Element) { this.elements.delete(element); }
  notify() { this.callback([], this as unknown as ResizeObserver); }
}

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function animationOn(element: Element, property: string, playState: AnimationPlayState = 'running') {
  const animation = {
    pending: false,
    playState,
    effect: { getKeyframes: () => [
      { offset: 0, computedOffset: 0, easing: 'linear', composite: 'replace', [property]: 'initial' },
      { offset: 1, computedOffset: 1, easing: 'linear', composite: 'replace', [property]: 'final' },
    ] },
  };
  Object.defineProperty(element, 'getAnimations', { configurable: true, value: () => [animation] });
  return animation;
}

describe('observeBrowserViewportBounds', () => {
  let host: HTMLDivElement;
  let sibling: HTMLElement;
  let stage: HTMLElement;
  let device: HTMLElement;
  let node: HTMLElement;
  let bounds: BrowserBounds;
  let readBounds: MockInstance<() => DOMRect>;
  let setBounds: ReturnType<typeof vi.fn<(bounds: BrowserBounds) => Promise<unknown>>>;
  let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;
  let viewport: EventTarget & { scale: number };
  let dispose: (() => void) | undefined;
  let frames: Map<number, FrameRequestCallback>;

  function start() { dispose = observeBrowserViewportBounds(node, setBounds, onError); }

  async function settle() {
    await Promise.resolve();
    await Promise.resolve();
  }

  async function nextFrame() {
    await settle(); // Deliver native MutationObserver records before the frame.
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
    await settle();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    frames = new Map();
    let nextId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = ++nextId;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal('devicePixelRatio', 1);
    viewport = Object.assign(new EventTarget(), { scale: 1 });
    vi.stubGlobal('visualViewport', viewport);
    host = document.createElement('div');
    host.innerHTML = '<header><span>Toolbar</span></header><section><div><div aria-label="Viewport"></div></div></section>';
    document.body.append(host);
    sibling = host.querySelector('header')!;
    stage = host.querySelector('section')!;
    device = stage.firstElementChild as HTMLElement;
    node = device.firstElementChild as HTMLElement;
    bounds = { x: 300, y: 100, width: 500, height: 700 };
    readBounds = vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => ({
      ...bounds, left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height,
      toJSON: () => bounds,
    }));
    setBounds = vi.fn<(bounds: BrowserBounds) => Promise<unknown>>().mockResolvedValue(undefined);
    onError = vi.fn();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the initial bounds and does no polling or IPC while idle', async () => {
    start();
    await nextFrame();
    expect(setBounds).toHaveBeenCalledExactlyOnceWith(bounds);
    expect(frames.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await nextFrame();
    expect(readBounds).toHaveBeenCalledTimes(1);
    expect(setBounds).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(readBounds).toHaveBeenCalledTimes(2);
    expect(setBounds).toHaveBeenCalledTimes(1); // unchanged bounds are deduplicated
    expect(frames.size).toBe(0);
  });

  it('coalesces resize and ancestor scroll bursts into one latest measurement', async () => {
    start();
    await nextFrame();
    bounds = { ...bounds, x: 260, y: 85, width: 540 };
    ResizeObserverMock.current.notify();
    ResizeObserverMock.current.notify();
    stage.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
    expect(frames.size).toBe(1);
    await nextFrame();
    expect(readBounds).toHaveBeenCalledTimes(2);
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    expect(frames.size).toBe(0);
  });

  it('tracks position-only ancestor style changes and sibling layout changes', async () => {
    start();
    await nextFrame();
    for (const element of [node, device, stage, host, sibling]) expect(ResizeObserverMock.current.elements.has(element)).toBe(true);
    bounds = { ...bounds, x: 320 };
    stage.style.transform = 'translateX(20px)';
    await nextFrame();
    expect(setBounds).toHaveBeenLastCalledWith(bounds);

    bounds = { ...bounds, y: 120 }; // a toolbar grew, while every ancestor stayed the same size
    ResizeObserverMock.current.notify();
    await nextFrame();
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    expect(setBounds).toHaveBeenCalledTimes(3);
    expect(frames.size).toBe(0);
  });

  it('refreshes shallow layout observations when a toolbar is added or removed', async () => {
    start();
    await nextFrame();
    const toolbar = document.createElement('nav');
    host.insertBefore(toolbar, stage);
    bounds = { ...bounds, y: 135 };
    await nextFrame();
    expect(ResizeObserverMock.current.elements.has(toolbar)).toBe(true);
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    toolbar.remove();
    bounds = { ...bounds, y: 100 };
    await nextFrame();
    expect(ResizeObserverMock.current.elements.has(toolbar)).toBe(false);
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
  });

  it('tracks device frame dimensions and stage centering without a window resize', async () => {
    start();
    await nextFrame();
    stage.className = 'browser-device-stage--active';
    device.style.width = '390px';
    device.style.height = '844px';
    bounds = { x: 355, y: 112, width: 376, height: 650 };
    await nextFrame();
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    device.style.width = '844px';
    device.style.height = '390px';
    bounds = { x: 310, y: 260, width: 480, height: 376 };
    await nextFrame();
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    expect(frames.size).toBe(0);
  });

  it('resends unchanged CSS bounds after renderer zoom changes', async () => {
    start();
    await nextFrame();
    vi.stubGlobal('devicePixelRatio', 1.25);
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(2);
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    viewport.scale = 1.5;
    viewport.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(3);
    expect(frames.size).toBe(0);
  });

  it('ignores unrelated streaming descendants, scrolling and spinner transitions', async () => {
    start();
    await nextFrame();
    sibling.firstElementChild!.textContent = 'Streaming update';
    sibling.firstElementChild!.setAttribute('style', 'transform: rotate(1deg)');
    sibling.dispatchEvent(new Event('scroll'));
    sibling.firstElementChild!.dispatchEvent(new Event('transitionrun', { bubbles: true }));
    await nextFrame();
    expect(readBounds).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it('follows an ancestor transform transition, including its final position, then sleeps', async () => {
    start();
    await nextFrame();
    const animation = animationOn(stage, 'transform');
    stage.dispatchEvent(new Event('transitionrun', { bubbles: true }));
    bounds = { ...bounds, x: 330 };
    await nextFrame();
    expect(frames.size).toBe(1);
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    bounds = { ...bounds, x: 350 };
    await nextFrame();
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    animation.playState = 'finished';
    bounds = { ...bounds, x: 360 };
    stage.dispatchEvent(new Event('transitionend', { bubbles: true }));
    await nextFrame();
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    expect(frames.size).toBe(0);
  });

  it('joins in-progress grid motion on mount and stops even without an end event', async () => {
    const animation = animationOn(host, 'gridTemplateColumns');
    start();
    await nextFrame();
    expect(frames.size).toBe(1);
    animation.playState = 'idle'; // canceled / detached animation, no DOM event
    bounds = { ...bounds, x: 280 };
    await nextFrame();
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    expect(frames.size).toBe(0);
  });

  it('does not poll for paint-only ancestor animations or sibling transforms', async () => {
    animationOn(host, 'opacity');
    animationOn(sibling, 'transform');
    start();
    await nextFrame();
    expect(frames.size).toBe(0);
    expect(readBounds).toHaveBeenCalledTimes(1);
  });

  it('serializes IPC and flushes only the latest pending bounds after it settles', async () => {
    const first = deferred();
    const second = deferred();
    setBounds.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    start();
    await nextFrame();
    bounds = { ...bounds, width: 520 };
    ResizeObserverMock.current.notify();
    await nextFrame();
    bounds = { ...bounds, width: 550 };
    ResizeObserverMock.current.notify();
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0); // IPC latency itself cannot start polling
    first.resolve();
    await settle();
    expect(setBounds).toHaveBeenCalledTimes(2);
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    bounds = { ...bounds, x: 310 };
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    second.resolve();
    await settle();
    expect(setBounds).toHaveBeenCalledTimes(3);
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    expect(frames.size).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('restores the prior position when a pending move reverses before IPC %s', async (result) => {
    start();
    await nextFrame();
    const original = bounds;
    const pending = deferred();
    setBounds.mockReturnValueOnce(pending.promise);
    bounds = { ...bounds, x: 320 };
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    bounds = original;
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(2);
    if (result === 'reject') pending.reject(new Error('Reply failed after applying bounds'));
    else pending.resolve();
    await settle();
    expect(setBounds).toHaveBeenCalledTimes(3);
    expect(setBounds).toHaveBeenLastCalledWith(original);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off failed bounds a bounded number of times, then recovers on new geometry', async () => {
    const failure = new Error('Alignment unavailable');
    setBounds.mockRejectedValue(failure);
    start();
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(frames.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenLastCalledWith(failure);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(3);
    setBounds.mockResolvedValue(undefined);
    bounds = { ...bounds, x: 320 };
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(4);
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
  });

  it('retries a transient failure successfully and supersedes a retry with newer bounds', async () => {
    setBounds.mockRejectedValueOnce(new Error('Transient'));
    start();
    await nextFrame();
    await vi.advanceTimersByTimeAsync(100);
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    setBounds.mockRejectedValueOnce(new Error('Transient again'));
    bounds = { ...bounds, x: 320 };
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(vi.getTimerCount()).toBe(1);
    bounds = { ...bounds, x: 340 };
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(4);
    expect(setBounds).toHaveBeenLastCalledWith(bounds);
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('cleans observers, listeners and frames, ignoring late IPC %s and queued work', async (result) => {
    const pending = deferred();
    setBounds.mockReturnValueOnce(pending.promise);
    start();
    await nextFrame();
    bounds = { ...bounds, x: 320 };
    ResizeObserverMock.current.notify();
    expect(frames.size).toBe(1);
    dispose!();
    dispose = undefined;
    expect(frames.size).toBe(0);
    expect(ResizeObserverMock.current.disconnect).toHaveBeenCalledOnce();
    expect(ResizeObserverMock.current.elements.size).toBe(0);
    stage.style.transform = 'translateX(20px)';
    stage.dispatchEvent(new Event('scroll'));
    stage.dispatchEvent(new Event('transitionrun', { bubbles: true }));
    window.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new Event('visibilitychange'));
    ResizeObserverMock.current.notify(); // already queued callback after disconnect
    if (result === 'reject') pending.reject(new Error('Late failure'));
    else pending.resolve();
    await nextFrame();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    expect(readBounds).toHaveBeenCalledTimes(1);
    expect(setBounds).toHaveBeenCalledTimes(1);
  });

  it('cancels scheduled retry timers on teardown', async () => {
    setBounds.mockRejectedValue(new Error('Unavailable'));
    start();
    await nextFrame();
    expect(vi.getTimerCount()).toBe(1);
    dispose!();
    dispose = undefined;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await nextFrame();
    expect(setBounds).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });
});
