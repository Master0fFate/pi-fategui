import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './m3-expressive.css'), 'utf8');

describe('M3 Expressive image viewer styles', () => {
  it('keeps the image viewer transparent instead of painting the generic dialog card', () => {
    const dialogCardRule = stylesheet.indexOf(':root[data-skin="m3-expressive"] :is(.settings-dialog, [role="dialog"]');
    const viewerRule = /:root\[data-skin="m3-expressive"\]\s+\.cinematic-image-viewer\s*\{([^}]*)\}/u.exec(stylesheet);

    expect(dialogCardRule).toBeGreaterThanOrEqual(0);
    expect(viewerRule?.[1]).toMatch(/(?:^|;)\s*background:\s*transparent\s*;?/u);
    expect(viewerRule?.[1]).toMatch(/(?:^|;)\s*border-radius:\s*0\s*;?/u);
    expect(viewerRule?.index).toBeGreaterThan(dialogCardRule);
  });

  it('preserves an unmistakable, clickable close target above the viewer', () => {
    const closeRule = /:root\[data-skin="m3-expressive"\]\s+\.cinematic-image-viewer\s+\.cinematic-image-close\s*\{([^}]*)\}/u.exec(stylesheet);

    expect(closeRule?.[1]).toMatch(/(?:^|;)\s*z-index:\s*1\s*;?/u);
    expect(closeRule?.[1]).toMatch(/(?:^|;)\s*border-radius:\s*50%\s*;?/u);
  });
});

describe('M3 narrow inspector tabs', () => {
  it('restores icons after the label-only breakpoint before global labels disappear', () => {
    const hideAt340 = stylesheet.indexOf('@container (max-width: 340px)');
    const iconsAt259 = /@container\s*\(max-width:\s*259px\)\s*\{\s*:root\[data-skin="m3-expressive"\]\s+\.inspector-secondary-trigger\s*>\s*svg\s*\{([^}]*)\}/u.exec(stylesheet);
    expect(hideAt340).toBeGreaterThanOrEqual(0);
    expect(iconsAt259?.index).toBeGreaterThan(hideAt340);
    expect(iconsAt259?.[1]).toMatch(/(?:^|;)\s*display:\s*block\s*;?/u);
  });
});
