import { describe, expect, it } from 'vitest';
import {
  browserAnnotationDismissInputSchema,
  browserAnnotationSchema,
  browserLinkContextMenuInputSchema,
  browserOriginGrantSchema,
  normalizeBrowserWebUrl,
  browserSnapshotInputSchema,
  browserTypeInputSchema,
} from './browser';

describe('browser contracts', () => {
  it('normalizes only credential-free HTTP(S) links, including localhost', () => {
    expect(normalizeBrowserWebUrl('localhost:4173/preview')).toBe('http://localhost:4173/preview');
    expect(browserLinkContextMenuInputSchema.parse({ url: 'https://example.test/docs' })).toEqual({ url: 'https://example.test/docs' });
    expect(() => browserLinkContextMenuInputSchema.parse({ url: 'javascript:alert(1)' })).toThrow();
    expect(() => browserLinkContextMenuInputSchema.parse({ url: 'https://user:pass@example.test' })).toThrow();
  });

  it('keeps grants and snapshot inputs strict and bounded', () => {
    expect(browserOriginGrantSchema.parse({
      origin: 'https://example.test', read: true, interact: true, scope: 'task',
    }).allowPrivateNetwork).toBe(false);
    expect(() => browserOriginGrantSchema.parse({ origin: 'https://example.test', read: false, interact: true, scope: 'task' })).toThrow();
    expect(() => browserSnapshotInputSchema.parse({ tabId: 't1', mode: 'interactive', extra: true })).toThrow();
    expect(() => browserTypeInputSchema.parse({ tabId: 't1', ref: 'e1', text: 'x'.repeat(100_001) })).toThrow();
    expect(browserAnnotationDismissInputSchema.parse({ ids: ['a1', 'a2'] })).toEqual({ ids: ['a1', 'a2'] });
    expect(() => browserAnnotationDismissInputSchema.parse({ ids: [] })).toThrow();
  });

  it('rejects secret-bearing or unbounded annotation extensions at the boundary', () => {
    const annotation = {
      id: 'a1', tabId: 't1', url: 'https://example.test', origin: 'https://example.test', documentEpoch: 1,
      pageRevision: 1, kind: 'element',
      target: {
        frameId: 'main', rectCssPx: { x: 0, y: 0, width: 10, height: 10 }, rectNormalized: { x: 0, y: 0, width: 0.1, height: 0.1 },
        locatorHints: {}, fingerprint: { attributesHash: '', nearbyTextHash: '', ancestorHash: '' },
      },
      comment: 'Fix this', semanticCoverage: 1, reattachConfidence: 1, createdAt: 1,
    };
    expect(browserAnnotationSchema.parse(annotation).comment).toBe('Fix this');
    expect(() => browserAnnotationSchema.parse({ ...annotation, cookies: ['secret'] })).toThrow();
  });
});
