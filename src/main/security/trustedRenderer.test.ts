import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTrustedRendererPolicy, isExternalHttpsUrl, isTrustedAudioPermissionRequest, isTrustedRendererUrl } from './trustedRenderer';

describe('trusted renderer policy', () => {
  const rendererPath = path.resolve('dist/renderer/index.html');

  it('accepts only the exact packaged renderer document', () => {
    const policy = createTrustedRendererPolicy(rendererPath);
    expect(isTrustedRendererUrl(policy.documentUrl, policy)).toBe(true);
    expect(isTrustedRendererUrl(`${policy.documentUrl}#view`, policy)).toBe(true);
    expect(isTrustedRendererUrl(new URL('other.html', policy.documentUrl).href, policy)).toBe(false);
    expect(isTrustedRendererUrl('file:///tmp/attacker.html', policy)).toBe(false);
  });

  it('accepts only documents from the configured development origin', () => {
    const policy = createTrustedRendererPolicy(rendererPath, 'http://127.0.0.1:5173/app');
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', policy)).toBe(true);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/another', policy)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5173/', policy)).toBe(false);
    expect(isTrustedRendererUrl('http://127.0.0.1:51730/', policy)).toBe(false);
  });

  it('allows audio permission for the trusted packaged document rather than its generic file origin', () => {
    const policy = createTrustedRendererPolicy(rendererPath);
    expect(isTrustedAudioPermissionRequest(policy, {
      documentUrl: policy.documentUrl,
      requestingOrigin: 'file://',
      mediaTypes: ['audio'],
    })).toBe(true);
    expect(isTrustedAudioPermissionRequest(policy, { requestingOrigin: 'file://', mediaTypes: ['audio'] })).toBe(false);
    expect(isTrustedAudioPermissionRequest(policy, { documentUrl: policy.documentUrl, mediaTypes: ['audio', 'video'] })).toBe(false);
  });

  it('opens only valid HTTPS URLs externally', () => {
    expect(isExternalHttpsUrl('https://example.com/docs')).toBe(true);
    expect(isExternalHttpsUrl('http://example.com')).toBe(false);
    expect(isExternalHttpsUrl('file:///tmp/page.html')).toBe(false);
    expect(isExternalHttpsUrl('not a url')).toBe(false);
  });
});
