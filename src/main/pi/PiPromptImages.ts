import type { RuntimeImage } from '../../shared/contracts/ipc';
import { PiDesktopError } from './errors';

export const MAX_PROMPT_IMAGE_BYTES = 10_000_000;
export const MAX_PROMPT_IMAGE_TOTAL_BYTES = 15_000_000;
export const MAX_PROMPT_IMAGE_DIMENSION = 8_192;
export const MAX_PROMPT_IMAGE_TOTAL_PIXELS = 24_000_000;

interface PromptImageLike extends Pick<RuntimeImage, 'data' | 'mimeType'> {}
interface ImageSize { width: number; height: number }

function jpegSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 9 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

function webpSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b1 = buffer[21]!;
    const b2 = buffer[22]!;
    const b3 = buffer[23]!;
    const b4 = buffer[24]!;
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6)),
    };
  }
  return null;
}

export function encodedImageSize(buffer: Buffer, mimeType: RuntimeImage['mimeType']): ImageSize | null {
  if (mimeType === 'image/png') {
    if (buffer.length < 24 || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/gif') {
    if (buffer.length < 10 || !['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return null;
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mimeType === 'image/jpeg') return jpegSize(buffer);
  return webpSize(buffer);
}

export function validatePromptImages(images: readonly PromptImageLike[] | undefined): void {
  if (!images?.length) return;
  let totalBytes = 0;
  let totalPixels = 0;
  for (const image of images) {
    const buffer = Buffer.from(image.data, 'base64');
    totalBytes += buffer.length;
    const size = encodedImageSize(buffer, image.mimeType);
    if (!size || size.width <= 0 || size.height <= 0) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'An attached image is malformed or unsupported.', retryable: true });
    }
    const pixels = size.width * size.height;
    totalPixels += pixels;
    if (buffer.length > MAX_PROMPT_IMAGE_BYTES || size.width > MAX_PROMPT_IMAGE_DIMENSION || size.height > MAX_PROMPT_IMAGE_DIMENSION) {
      throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'Each attached image must be under 10 MB and 8,192 pixels per side.', retryable: true });
    }
  }
  if (totalBytes > MAX_PROMPT_IMAGE_TOTAL_BYTES || totalPixels > MAX_PROMPT_IMAGE_TOTAL_PIXELS) {
    throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'Image attachments exceed the combined 15 MB or 24 megapixel limit.', retryable: true });
  }
}
