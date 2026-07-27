import { pathToFileURL } from 'node:url';

export interface TrustedRendererPolicy {
  documentUrl: string;
  developmentOrigin: string | null;
}

export function createTrustedRendererPolicy(rendererPath: string, developmentUrl?: string): TrustedRendererPolicy {
  const documentUrl = pathToFileURL(rendererPath).href;
  if (!developmentUrl) return { documentUrl, developmentOrigin: null };
  const parsed = new URL(developmentUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('The renderer development URL must use HTTP or HTTPS.');
  return { documentUrl, developmentOrigin: parsed.origin };
}

export function isTrustedRendererUrl(value: string, policy: TrustedRendererPolicy): boolean {
  try {
    const parsed = new URL(value);
    if (policy.developmentOrigin) return parsed.origin === policy.developmentOrigin;
    parsed.hash = '';
    return parsed.href === policy.documentUrl;
  } catch {
    return false;
  }
}

export function isTrustedAudioPermissionRequest(
  policy: TrustedRendererPolicy,
  context: {
    documentUrl?: string | undefined;
    requestingOrigin?: string | undefined;
    mediaTypes?: readonly string[] | undefined;
  },
): boolean {
  const rendererUrl = context.documentUrl || context.requestingOrigin || '';
  return isTrustedRendererUrl(rendererUrl, policy)
    && Boolean(context.mediaTypes?.length)
    && context.mediaTypes?.every((type) => type === 'audio') === true;
}

export function isExternalHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
