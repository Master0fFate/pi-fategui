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
