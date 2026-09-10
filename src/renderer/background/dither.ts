import { ditherMask } from '../../shared/dither';
export { ditherMask, MAX_BACKGROUND_PIXELS } from '../../shared/dither';
export const MAX_BACKGROUND_FILE_BYTES = 12 * 1024 * 1024;

export async function prepareBackground(file: File): Promise<Blob> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size === 0 || file.size > MAX_BACKGROUND_FILE_BYTES) {
    throw new Error('Choose a PNG, JPEG, or WebP image up to 12 MB.');
  }
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('This image could not be decoded. Try a PNG, JPEG, or WebP file.'); });
  try {
    if (bitmap.width * bitmap.height > 32_000_000) throw new Error('Choose an image smaller than 32 megapixels.');
    const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Image processing is unavailable in this environment.');
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    pixels.data.set(ditherMask(pixels.data, width, height));
    context.putImageData(pixels, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The background could not be encoded.')), 'image/png'));
  } finally {
    bitmap.close();
  }
}
