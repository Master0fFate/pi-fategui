import { beforeEach, describe, expect, it } from 'vitest';
import type { BrowserAnnotation, BrowserEvent } from '../../shared/contracts/browser';
import { browserOrigin, useBrowserStore } from './browserStore';

const annotation = (id: string): BrowserAnnotation => ({
  id, tabId: 'browser-main', url: 'https://example.test/', origin: 'https://example.test',
  documentEpoch: 1, pageRevision: 1, kind: 'element',
  target: {
    frameId: 'frame-main', semanticRef: 'e1', role: 'button', accessibleName: 'Save', tagName: 'button',
    rectCssPx: { x: 1, y: 2, width: 30, height: 20 }, rectNormalized: { x: 0, y: 0, width: 0.1, height: 0.1 },
    locatorHints: {}, fingerprint: { attributesHash: 'a', nearbyTextHash: 'b', ancestorHash: 'c' },
  },
  comment: 'Use this control', semanticCoverage: 1, reattachConfidence: 0.9, createdAt: 1,
});

describe('browserStore', () => {
  beforeEach(() => useBrowserStore.getState().reset());

  it('adds typed annotations from browser events, deduplicates them, and reports picker errors', () => {
    useBrowserStore.getState().applyEvents([
      { type: 'annotation-created', projectPath: '/project', sessionId: 'session-1', annotation: annotation('a1') },
      { type: 'annotation-created', projectPath: '/project', sessionId: 'session-1', annotation: { ...annotation('a1'), comment: 'Updated note' } },
      { type: 'annotation-created', projectPath: '/project', sessionId: 'session-1', annotation: annotation('a2') },
      { type: 'annotation-error', message: 'The selected element disappeared.' },
    ]);

    expect(useBrowserStore.getState().annotations.map((item) => item.id)).toEqual(['a2', 'a1']);
    expect(useBrowserStore.getState().annotations.find((item) => item.id === 'a1')?.comment).toBe('Updated note');
    expect(useBrowserStore.getState().error).toBe('The selected element disappeared.');

    useBrowserStore.getState().removeAnnotation('a1');
    expect(useBrowserStore.getState().annotations.map((item) => item.id)).toEqual(['a2']);
  });

  it('returns grantable origins only for HTTP and HTTPS pages', () => {
    expect(browserOrigin('https://example.test/path')).toBe('https://example.test');
    expect(browserOrigin('file:///C:/project/index.html')).toBeNull();
    expect(browserOrigin('about:blank')).toBeNull();
  });

  it('applies confirmations and retains only the latest 300 redacted work-log events', () => {
    const confirmation = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tabId: 'browser-main', documentEpoch: 1,
      action: { kind: 'click' as const, origin: 'https://example.test', frameOrigin: 'https://example.test', consequence: 'financial' as const },
      reason: 'Payment action', expiresAt: Date.now() + 1_000,
    };
    useBrowserStore.getState().applyEvents([{ type: 'confirmation-requested', confirmation }]);
    expect(useBrowserStore.getState().confirmation?.id).toBe(confirmation.id);

    const events: BrowserEvent[] = Array.from({ length: 305 }, (_, index) => ({
      type: 'work-log' as const, tabId: 'browser-main', action: 'snapshot' as const,
      target: `snapshot ${index}`, timestamp: index,
    }));
    useBrowserStore.getState().applyEvents(events);
    expect(useBrowserStore.getState().workLog).toHaveLength(300);
    expect(useBrowserStore.getState().workLog[0]?.target).toBe('snapshot 5');

    useBrowserStore.getState().applyEvents([{ type: 'confirmation-cleared', id: confirmation.id, approved: false }]);
    expect(useBrowserStore.getState().confirmation).toBeNull();
  });
});
