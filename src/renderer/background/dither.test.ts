import { afterEach, describe, expect, it, vi } from 'vitest';
import { ditherMask, MAX_BACKGROUND_PIXELS, prepareBackground } from './dither';

const pixels = (red: number, alpha = 255) => new Uint8ClampedArray(Array.from({ length: 64 }, () => [red, red, red, alpha]).flat());
afterEach(() => vi.unstubAllGlobals());

describe('source-driven ordered image dithering', () => {
  it('preserves black gaps and white detail instead of adding an unrelated overlay', () => {
    expect(ditherMask(pixels(0), 8, 8).filter((_value, index) => index % 4 === 3).every((value) => value === 0)).toBe(true);
    expect(ditherMask(pixels(255), 8, 8).every((value) => value === 255)).toBe(true);
    expect(ditherMask(pixels(255, 0), 8, 8).filter((_value, index) => index % 4 === 3).every((value) => value === 0)).toBe(true);
  });
  it('turns middle gray into deterministic binary coverage without mutating the source', () => {
    const source = pixels(128);
    const result = ditherMask(source, 8, 8);
    expect(result).toEqual(ditherMask(source, 8, 8));
    expect(new Set(result)).toEqual(new Set([0, 255]));
    expect(result.filter((_value, index) => index % 4 === 3 && result[index] === 255)).toHaveLength(32);
    expect(source).toEqual(pixels(128));
  });
  it('bounds allocation and rejects malformed dimensions', () => {
    expect(() => ditherMask(new Uint8ClampedArray(), 0, 1)).toThrow();
    expect(() => ditherMask(pixels(128), 8, 7)).toThrow();
    expect(() => ditherMask(new Uint8ClampedArray(), MAX_BACKGROUND_PIXELS + 1, 1)).toThrow();
  });
  it('rejects non-raster uploads and releases decoded oversized bitmaps', async () => {
    await expect(prepareBackground(new File(['<svg/>'], 'unsafe.svg', { type: 'image/svg+xml' }))).rejects.toThrow('PNG, JPEG, or WebP');
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10_000, height: 10_000, close })));
    await expect(prepareBackground(new File(['png'], 'large.png', { type: 'image/png' }))).rejects.toThrow('32 megapixels');
    expect(close).toHaveBeenCalledOnce();
  });
});
