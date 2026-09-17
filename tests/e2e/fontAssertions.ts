import { expect, type Page } from '@playwright/test';

/** A CSS fallback stack or fonts.check() for an unknown family is not load evidence. */
export async function expectLoadedFontFace(page: Page, family: string): Promise<void> {
  await expect.poll(() => page.evaluate(async (expected) => {
    await document.fonts.ready;
    return [...document.fonts].some((face) => face.family.replace(/["']/gu, '') === expected && face.status === 'loaded');
  }, family)).toBe(true);
}
