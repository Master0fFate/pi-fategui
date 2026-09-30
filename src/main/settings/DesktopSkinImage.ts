import { nativeImage } from 'electron';
import { ditherMask } from '../../shared/dither';
import { MAX_SKIN_MASK_BYTES } from '../../shared/skins';
import { packPngDimensions } from './SkinPackService';

/** Real desktop PNG decoding and mask preparation; never loaded by the Node core. */
export function preparePackBackground(bytes: Buffer): Buffer {
  const size = packPngDimensions(bytes, 8_000_000);
  const source = nativeImage.createFromBuffer(bytes);
  if (source.isEmpty()) throw new Error('The pack PNG could not be decoded.');
  const scale = Math.min(1, 640 / Math.max(size.width, size.height));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const bitmap = source.resize({ width, height, quality: 'good' }).toBitmap();
  if (bitmap.length !== width * height * 4) throw new Error('The pack PNG has an unsupported bitmap format.');
  const rgba = new Uint8ClampedArray(bitmap.length);
  for (let index = 0; index < bitmap.length; index += 4) {
    rgba[index] = bitmap[index + 2]!;
    rgba[index + 1] = bitmap[index + 1]!;
    rgba[index + 2] = bitmap[index]!;
    rgba[index + 3] = bitmap[index + 3]!;
  }
  const mask = nativeImage.createFromBitmap(Buffer.from(ditherMask(rgba, width, height)), { width, height, scaleFactor: 1 }).toPNG();
  if (mask.length > MAX_SKIN_MASK_BYTES) throw new Error('The processed background is too large. Use a simpler or smaller image.');
  return mask;
}
