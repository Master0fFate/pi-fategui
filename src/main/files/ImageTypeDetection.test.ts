// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { previewImageMimeType, rasterImageMimeType } from './FilesystemService';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

function pngWithChunks(extra: Array<{ type: string; data: Buffer }>): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(640, 0);
  ihdr.writeUInt32BE(480, 4);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...extra.map(({ type, data }) => pngChunk(type, data)),
  ]);
}

function staticPng(): Buffer {
  return pngWithChunks([{ type: 'IDAT', data: Buffer.alloc(4) }]);
}

function animatedPng(): Buffer {
  return pngWithChunks([{ type: 'acTL', data: Buffer.alloc(8) }]);
}

function bmp(options: { width?: number; height?: number; dibSize?: number; planes?: number; bitsPerPixel?: number } = {}): Buffer {
  const { width = 16, height = 12, dibSize = 40, planes = 1, bitsPerPixel = 24 } = options;
  const buffer = Buffer.alloc(14 + Math.max(dibSize, 40) + 16);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(14 + dibSize, 10);
  buffer.writeUInt32LE(dibSize, 14);
  if (dibSize === 12) {
    buffer.writeUInt16LE(width, 18);
    buffer.writeUInt16LE(height, 20);
    buffer.writeUInt16LE(planes, 22);
    buffer.writeUInt16LE(bitsPerPixel, 24);
  } else {
    buffer.writeInt32LE(width, 18);
    buffer.writeInt32LE(height, 22);
    buffer.writeUInt16LE(planes, 26);
    buffer.writeUInt16LE(bitsPerPixel, 28);
  }
  return buffer;
}

describe('raster image type detection (Pi SDK 0.84.4 parity)', () => {
  it('accepts a structurally valid static PNG in both modes', () => {
    expect(rasterImageMimeType(staticPng())).toBe('image/png');
    expect(previewImageMimeType(staticPng())).toBe('image/png');
  });

  it('rejects animated PNGs for providers but keeps them previewable', () => {
    expect(rasterImageMimeType(animatedPng())).toBeNull();
    expect(previewImageMimeType(animatedPng())).toBe('image/png');
  });

  it('rejects PNGs whose first chunk is not a valid IHDR header', () => {
    const broken = Buffer.concat([PNG_SIGNATURE, pngChunk('IDAT', Buffer.alloc(13))]);
    expect(rasterImageMimeType(broken)).toBeNull();
    expect(previewImageMimeType(broken)).toBeNull();

    const shortIhdr = pngWithChunks([]);
    shortIhdr.writeUInt32BE(12, 8);
    expect(rasterImageMimeType(shortIhdr)).toBeNull();
  });

  it('accepts plain JPEG and rejects JPEG-XR payloads', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(rasterImageMimeType(jpeg)).toBe('image/jpeg');
    expect(previewImageMimeType(jpeg)).toBe('image/jpeg');

    const jpegXr = Buffer.from([0xff, 0xd8, 0xff, 0xf7, 0x00, 0x10]);
    expect(rasterImageMimeType(jpegXr)).toBeNull();
    expect(previewImageMimeType(jpegXr)).toBeNull();
  });

  it('accepts GIF headers with the SDK prefix rule', () => {
    expect(rasterImageMimeType(Buffer.from('GIF89a....', 'ascii'))).toBe('image/gif');
    expect(rasterImageMimeType(Buffer.from('GIF87a....', 'ascii'))).toBe('image/gif');
    expect(rasterImageMimeType(Buffer.from('GIF', 'ascii'))).toBe('image/gif');
    expect(previewImageMimeType(Buffer.from('GIF89a', 'ascii'))).toBe('image/gif');
  });

  it('accepts only RIFF containers that carry WEBP', () => {
    const webp = Buffer.alloc(16);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    expect(rasterImageMimeType(webp)).toBe('image/webp');
    expect(previewImageMimeType(webp)).toBe('image/webp');

    const wave = Buffer.alloc(16);
    wave.write('RIFF', 0, 'ascii');
    wave.write('WAVE', 8, 'ascii');
    expect(rasterImageMimeType(wave)).toBeNull();
  });

  it('accepts structurally valid BMPs and rejects malformed DIB headers', () => {
    expect(rasterImageMimeType(bmp())).toBe('image/bmp');
    expect(previewImageMimeType(bmp())).toBe('image/bmp');

    expect(rasterImageMimeType(bmp({ dibSize: 12 }))).toBe('image/bmp');
    expect(rasterImageMimeType(bmp({ planes: 2 }))).toBeNull();
    expect(rasterImageMimeType(bmp({ bitsPerPixel: 7 }))).toBeNull();
    expect(rasterImageMimeType(bmp({ dibSize: 13 }))).toBeNull();
  });

  it('rejects truncated and non-image buffers in both modes', () => {
    expect(rasterImageMimeType(Buffer.alloc(0))).toBeNull();
    expect(rasterImageMimeType(PNG_SIGNATURE.subarray(0, 4))).toBeNull();
    expect(rasterImageMimeType(Buffer.from('plain text file', 'utf8'))).toBeNull();
    expect(previewImageMimeType(Buffer.from('plain text file', 'utf8'))).toBeNull();
  });

  it('detects from bounded samples the way preview call sites use them', () => {
    const padded = Buffer.concat([staticPng(), Buffer.alloc(64)]);
    const sample = padded.subarray(0, 8_192);
    expect(previewImageMimeType(sample)).toBe('image/png');
    expect(rasterImageMimeType(sample)).toBe('image/png');
  });
});
