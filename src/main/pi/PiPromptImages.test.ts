import { describe, expect, it } from 'vitest';
import { encodedImageSize, validatePromptImages } from './PiPromptImages';

function png(width: number, height: number, bytes = 24): Buffer {
  const buffer = Buffer.alloc(bytes);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('prompt image budgets', () => {
  it('reads dimensions from bounded image headers and accepts a small valid image', () => {
    const image = png(640, 480);
    expect(encodedImageSize(image, 'image/png')).toEqual({ width: 640, height: 480 });
    expect(() => validatePromptImages([{ data: image.toString('base64'), mimeType: 'image/png' }])).not.toThrow();
  });

  it('rejects malformed, oversized-dimension, and aggregate-heavy attachments', () => {
    expect(() => validatePromptImages([{ data: Buffer.from('not an image').toString('base64'), mimeType: 'image/png' }])).toThrow(/malformed/i);
    expect(() => validatePromptImages([{ data: png(9_000, 1).toString('base64'), mimeType: 'image/png' }])).toThrow(/8,192/);

    const first = png(1, 1, 7_600_000).toString('base64');
    const second = png(1, 1, 7_600_000).toString('base64');
    expect(() => validatePromptImages([
      { data: first, mimeType: 'image/png' },
      { data: second, mimeType: 'image/png' },
    ])).toThrow(/combined 15 MB/i);
  });
});

function bmpFixture(options: { width?: number; height?: number; dibSize?: number } = {}): Buffer {
  const { width = 16, height = 12, dibSize = 40 } = options;
  const buffer = Buffer.alloc(14 + Math.max(dibSize, 40) + 16);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(14 + dibSize, 10);
  buffer.writeUInt32LE(dibSize, 14);
  if (dibSize === 12) {
    buffer.writeUInt16LE(width, 18);
    buffer.writeUInt16LE(height, 20);
  } else {
    buffer.writeInt32LE(width, 18);
    buffer.writeInt32LE(height, 22);
  }
  return buffer;
}

describe('bitmap dimension parsing', () => {
  it('reads BITMAPINFOHEADER dimensions including top-down bitmaps', () => {
    expect(encodedImageSize(bmpFixture({ width: 640, height: 480 }), 'image/bmp')).toEqual({ width: 640, height: 480 });

    const topDown = bmpFixture({ width: 640, height: -480 });
    expect(encodedImageSize(topDown, 'image/bmp')).toEqual({ width: 640, height: 480 });
  });

  it('reads BITMAPCOREHEADER dimensions and rejects unknown DIB sizes', () => {
    expect(encodedImageSize(bmpFixture({ dibSize: 12, width: 320, height: 200 }), 'image/bmp')).toEqual({ width: 320, height: 200 });
    expect(encodedImageSize(bmpFixture({ dibSize: 13 }), 'image/bmp')).toBeNull();
  });

  it('accepts a small valid BMP through prompt validation', () => {
    expect(() => validatePromptImages([{ data: bmpFixture().toString('base64'), mimeType: 'image/bmp' }])).not.toThrow();
  });
});
