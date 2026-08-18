import { useEffect, useState } from 'react';

/**
 * Provider logos are loaded live from models.dev and never cached on disk.
 *
 * models.dev SVGs are monochrome and reference `currentColor`. Rendered in an
 * <img>, that resolves to plain black — invisible on dark themes. Instead the
 * logo is painted as a CSS mask over a `currentColor` background, so it always
 * matches the surrounding text color on every theme. The SVG's alpha channel
 * carries the shape, which works for black-on-transparent and
 * white-on-transparent artwork alike.
 *
 * The box only paints once `data-loaded` is set: an in-flight or failed logo
 * renders nothing at all — never a solid placeholder rectangle.
 *
 * Probe results are memoized per URL for the window session (the logo bytes
 * are never stored; this only remembers whether the URL loads). Dialogs use
 * `prefetchProviderLogos` to wait out the first round-trip before they appear,
 * so the window opens fully formed instead of visibly downloading logos.
 */

/** Pi provider ids whose models.dev logo id differs. */
const LOGO_ID_OVERRIDES: Record<string, string> = {
  'openai-codex': 'openai',
  bedrock: 'amazon-bedrock',
};

export function modelsDevLogoUrl(providerId: string): string {
  const normalized = providerId.toLowerCase();
  return `https://models.dev/logos/${LOGO_ID_OVERRIDES[normalized] ?? normalized}.svg`;
}

const probeCache = new Map<string, Promise<boolean>>();

function probeLogoUrl(url: string): Promise<boolean> {
  const cached = probeCache.get(url);
  if (cached) return cached;
  const pending = new Promise<boolean>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = url;
  });
  probeCache.set(url, pending);
  return pending;
}

/** Test seam plus cache probe: does this logo URL load? */
export function probeLogo(url: string): Promise<boolean> {
  return probeLogoUrl(url);
}

/** Clear the in-session probe memo. Tests only. */
export function resetLogoProbeCacheForTests(): void {
  probeCache.clear();
}

/**
 * Warm the logo probes for a set of provider ids. Resolves once every probe
 * settles, or after `budgetMs` (default 200ms) — whichever comes first — so a
 * slow network never stalls the dialog past the grace period.
 */
export function prefetchProviderLogos(ids: readonly string[], budgetMs = 200): Promise<void> {
  const urls = [...new Set(ids.map((id) => modelsDevLogoUrl(id)))];
  const all = Promise.allSettled(urls.map((url) => probeLogoUrl(url))).then(() => undefined);
  return Promise.race([all, new Promise<void>((resolve) => { setTimeout(resolve, budgetMs); })]);
}

export function ProviderLogo({ providerId, size = 16, className }: { providerId: string; size?: number; className?: string }) {
  const [loaded, setLoaded] = useState<boolean | null>(null);
  const [currentId, setCurrentId] = useState(providerId);
  if (currentId !== providerId) {
    setCurrentId(providerId);
    setLoaded(null);
  }
  useEffect(() => {
    let active = true;
    probeLogoUrl(modelsDevLogoUrl(providerId)).then((ok) => { if (active) setLoaded(ok); });
    return () => { active = false; };
  }, [providerId]);
  const mask = loaded === true ? `url(${modelsDevLogoUrl(providerId)})` : 'none';
  return (
    <span
      className={className ? `provider-logo ${className}` : 'provider-logo'}
      data-loaded={loaded === true ? 'true' : undefined}
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        WebkitMaskImage: mask,
        maskImage: mask,
      }}
      aria-hidden="true"
    />
  );
}
