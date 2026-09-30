import { describe, expect, it, vi } from 'vitest';
import { ditherMask } from '../../shared/dither';
import { MAX_SKIN_MASK_BYTES } from '../../shared/skins';

const native = vi.hoisted(() => ({ createFromBuffer: vi.fn(), createFromBitmap: vi.fn() }));
vi.mock('electron', () => ({ nativeImage: native }));
import { preparePackBackground } from './DesktopSkinImage';

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('desktop skin image preparation', () => {
  it('keeps native decode, BGRA conversion, dithering, and bounded resize behavior', () => {
    const input = png(2, 1);
    const bitmap = Buffer.from([10, 20, 30, 255, 40, 50, 60, 128]);
    const resize = vi.fn(() => ({ toBitmap: () => bitmap }));
    const prepared = Buffer.from('native encoded mask');
    native.createFromBuffer.mockReturnValue({ isEmpty: () => false, resize });
    native.createFromBitmap.mockReturnValue({ toPNG: () => prepared });

    expect(preparePackBackground(input)).toBe(prepared);
    expect(native.createFromBuffer).toHaveBeenLastCalledWith(input);
    expect(resize).toHaveBeenCalledWith({ width: 2, height: 1, quality: 'good' });
    expect(native.createFromBitmap).toHaveBeenLastCalledWith(
      Buffer.from(ditherMask(new Uint8ClampedArray([30, 20, 10, 255, 60, 50, 40, 128]), 2, 1)),
      { width: 2, height: 1, scaleFactor: 1 },
    );

    resize.mockReturnValue({ toBitmap: () => Buffer.alloc(640 * 4) });
    preparePackBackground(png(1280, 2));
    expect(resize).toHaveBeenLastCalledWith({ width: 640, height: 1, quality: 'good' });
  });

  it('refuses malformed/oversized input, failed decoding, and invalid native output', () => {
    expect(() => preparePackBackground(Buffer.from('<svg/>'))).toThrow('real PNG');
    expect(() => preparePackBackground(png(4000, 4000))).toThrow('pixel budget');
    native.createFromBuffer.mockReturnValue({ isEmpty: () => true });
    expect(() => preparePackBackground(png(1, 1))).toThrow('could not be decoded');
    native.createFromBuffer.mockReturnValue({ isEmpty: () => false, resize: () => ({ toBitmap: () => Buffer.alloc(1) }) });
    expect(() => preparePackBackground(png(1, 1))).toThrow('bitmap format');
    native.createFromBuffer.mockReturnValue({ isEmpty: () => false, resize: () => ({ toBitmap: () => Buffer.alloc(4) }) });
    native.createFromBitmap.mockReturnValue({ toPNG: () => Buffer.alloc(MAX_SKIN_MASK_BYTES + 1) });
    expect(() => preparePackBackground(png(1, 1))).toThrow('processed background is too large');
  });
});
