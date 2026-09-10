export const MAX_BACKGROUND_PIXELS = 960 * 960;
const bayer = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];

export function ditherMask(source: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_BACKGROUND_PIXELS || source.length !== width * height * 4) {
    throw new Error('Background dimensions are outside the supported pixel budget.');
  }
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const luminance = (54 * source[offset]! + 183 * source[offset + 1]! + 19 * source[offset + 2]!) / (256 * 255);
      const coverage = luminance * source[offset + 3]! / 255;
      const threshold = (bayer[(y % 8) * 8 + x % 8]! + 0.5) / 64;
      output[offset] = 255;
      output[offset + 1] = 255;
      output[offset + 2] = 255;
      output[offset + 3] = coverage > threshold ? 255 : 0;
    }
  }
  return output;
}
