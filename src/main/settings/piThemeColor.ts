/**
 * Pi 1.0 theme colours can be written as `oklch(...)` or `okhsl(...)`, and Pi's own bundled themes
 * are. Fate's theme contract is six-digit hex, so these values are converted here with the same
 * grammar and arithmetic as Pi (`@earendil-works/pi-tui`, colors.ts and oklab.ts). The Pi module is
 * not imported: it is not a direct dependency of the desktop or the server package.
 *
 * Oklab and OKHSL are Björn Ottosson's color spaces; OKHSL's saturation is relative to the sRGB gamut at
 * each hue and lightness. This is a port of his reference implementation (https://bottosson.github.io/posts/colorpicker/),
 * Copyright (c) 2021 Björn Ottosson, used under the MIT license:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
 * following conditions: The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED.
 */

type Vector = readonly [number, number, number];
type Matrix = readonly [Vector, Vector, Vector];

/** A theme file is bounded, but one value is never this long. This also bounds the patterns below. */
const MAX_FUNCTION_COLOR_LENGTH = 96;

const NUMBER_PATTERN = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
const OKLCH_PATTERN = new RegExp(`^oklch\\(\\s*(${NUMBER_PATTERN})(%)?\\s+(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})(?:deg)?\\s*\\)$`, 'i');
const OKHSL_PATTERN = new RegExp(`^okhsl\\(\\s*(${NUMBER_PATTERN})(?:deg)?\\s+(${NUMBER_PATTERN})(%)?\\s+(${NUMBER_PATTERN})(%)?\\s*\\)$`, 'i');

const LAB_TO_LMS: Matrix = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
];
const LMS_TO_LINEAR_SRGB: Matrix = [
  [4.0767416360759583, -3.3077115392580629, 0.2309699031821043],
  [-1.2684379732850315, 2.6097573492876882, -0.341319376002657],
  [-0.0041960761386756, -0.7034186179359362, 1.7076146940746117],
];
/**
 * Per sRGB channel (red, green, blue): the (a, b) half-plane where that channel clips
 * first, and the polynomial approximating the maximum saturation there.
 */
type SaturationFit = readonly [readonly [number, number], readonly [number, number, number, number, number]];
const SATURATION_FIT: readonly [SaturationFit, SaturationFit, SaturationFit] = [
  [[-1.8817031, -0.80936501], [1.19086277, 1.76576728, 0.59662641, 0.75515197, 0.56771245]],
  [[1.8144408, -1.19445267], [0.73956515, -0.45954404, 0.08285427, 0.12541073, -0.14503204]],
  [[0.13110758, 1.81333971], [1.35733652, -0.00915799, -1.1513021, -0.50559606, 0.00692167]],
];
const K1 = 0.206;
const K2 = 0.03;
const K3 = (1 + K1) / (1 + K2);

const multiply = (matrix: Matrix, [x, y, z]: Vector): Vector => [
  matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z,
  matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z,
  matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z,
];
const dot = (first: Vector, second: Vector): number => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
const each = (vector: Vector, change: (value: number, index: 0 | 1 | 2) => number): Vector => [
  change(vector[0], 0), change(vector[1], 1), change(vector[2], 2),
];

/** OKHSL lightness to Oklab lightness. */
const okhslToOklabLightness = (value: number): number => (value * value + K1 * value) / (K3 * (value + K2));
/** sRGB transfer function: linear to encoded channel, both 0-1. */
const linearToSrgb = (value: number): number => value > 0.0031308 ? 1.055 * value ** (1 / 2.4) - 0.055 : 12.92 * value;

/** Oklab [L, a, b] to linear sRGB [r, g, b] (0-1, may leave the gamut). */
function oklabToLinearSrgb(lab: Vector): Vector {
  return multiply(LMS_TO_LINEAR_SRGB, each(multiply(LAB_TO_LMS, lab), (value) => value ** 3));
}

/** Linear sRGB to six-digit hex, clipping out-of-gamut channels and rounding as Pi does. */
function linearSrgbToHex(linear: Vector): string {
  const channel = (value: number): string => Math.round(Math.min(1, Math.max(0, linearToSrgb(value))) * 255).toString(16).padStart(2, '0');
  return `#${channel(linear[0])}${channel(linear[1])}${channel(linear[2])}`;
}

/** Rate of change of each cube-root LMS component along a chroma direction (a, b). */
function lmsSlopes(a: number, b: number): Vector {
  return [LAB_TO_LMS[0][1] * a + LAB_TO_LMS[0][2] * b, LAB_TO_LMS[1][1] * a + LAB_TO_LMS[1][2] * b, LAB_TO_LMS[2][1] * a + LAB_TO_LMS[2][2] * b];
}

/** Largest saturation (C/L) inside sRGB for hue (a, b): polynomial fit plus one Halley step. */
function maxSaturation(a: number, b: number): number {
  const clips = (fit: SaturationFit): boolean => fit[0][0] * a + fit[0][1] * b > 1;
  const channel: 0 | 1 | 2 = clips(SATURATION_FIT[0]) ? 0 : clips(SATURATION_FIT[1]) ? 1 : 2;
  const [k0, k1, k2, k3, k4] = SATURATION_FIT[channel][1];
  const weights = LMS_TO_LINEAR_SRGB[channel];
  const saturation = k0 + k1 * a + k2 * b + k3 * a * a + k4 * a * b;
  const slopes = lmsSlopes(a, b);
  const base = each(slopes, (slope) => 1 + saturation * slope);
  const f = dot(weights, each(base, (value) => value ** 3));
  const f1 = dot(weights, each(base, (value, index) => 3 * slopes[index] * value ** 2));
  const f2 = dot(weights, each(base, (value, index) => 6 * slopes[index] ** 2 * value));
  return saturation - (f * f1) / (f1 * f1 - 0.5 * f * f2);
}

/** Oklab lightness and chroma of the most saturated sRGB color of hue (a, b). */
function cusp(a: number, b: number): readonly [number, number] {
  const saturation = maxSaturation(a, b);
  const lightness = Math.cbrt(1 / Math.max(...oklabToLinearSrgb([1, saturation * a, saturation * b])));
  return [lightness, lightness * saturation];
}

/** Chroma where the constant-lightness line at `lightness` leaves the sRGB gamut. */
function maxChroma(a: number, b: number, lightness: number, [cuspL, cuspC]: readonly [number, number]): number {
  if (lightness <= cuspL) return (cuspC * lightness) / cuspL;
  // Upper half: triangle edge, then one Halley step against each channel reaching 1.
  const t = (cuspC * (lightness - 1)) / (cuspL - 1);
  const slopes = lmsSlopes(a, b);
  const lms = each(slopes, (slope) => lightness + t * slope);
  const cubes = each(lms, (value) => value ** 3);
  const first = each(lms, (value, index) => 3 * slopes[index] * value ** 2);
  const second = each(lms, (value, index) => 6 * slopes[index] ** 2 * value);
  const steps = LMS_TO_LINEAR_SRGB.map((row) => {
    const f = dot(row, cubes) - 1;
    const f1 = dot(row, first);
    const f2 = dot(row, second);
    const u = f1 / (f1 * f1 - 0.5 * f * f2);
    return u >= 0 ? -f * u : Number.MAX_VALUE;
  });
  return t + Math.min(...steps);
}

/** OKHSL's chroma reference points at lightness L and hue (a, b): [c0, cMid, cMax]. */
function chromaStops(L: number, a: number, b: number): Vector {
  const peak = cusp(a, b);
  const cMax = maxChroma(a, b, L, peak);
  const k = cMax / Math.min(L * (peak[1] / peak[0]), (1 - L) * (peak[1] / (1 - peak[0])));
  const midS = 0.11516993 + 1 / (7.4477897 + 4.1590124 * b
    + a * (-2.19557347 + 1.75198401 * b + a * (-2.13704948 - 10.02301043 * b + a * (-4.24894561 + 5.38770819 * b + 4.69891013 * a))));
  const midT = 0.11239642 + 1 / (1.6132032 - 0.68124379 * b
    + a * (0.40370612 + 0.90148123 * b + a * (-0.27087943 + 0.6122399 * b + a * (0.00299215 - 0.45399568 * b - 0.14661872 * a))));
  const cMid = 0.9 * k * Math.sqrt(Math.sqrt(1 / (1 / (L * midS) ** 4 + 1 / ((1 - L) * midT) ** 4)));
  const c0 = Math.sqrt(1 / (1 / (L * 0.4) ** 2 + 1 / ((1 - L) * 0.8) ** 2));
  return [c0, cMid, cMax];
}

/** OKHSL (hue in degrees, saturation and lightness 0-1) to hex. */
function okhslToHex(hue: number, saturation: number, lightness: number): string {
  const L = okhslToOklabLightness(lightness);
  let lab: Vector = [L, 0, 0];
  if (L > 0 && L < 1 && saturation > 0) {
    const angle = (2 * Math.PI * (((hue % 360) + 360) % 360)) / 360;
    const a = Math.cos(angle);
    const b = Math.sin(angle);
    const [c0, cMid, cMax] = chromaStops(L, a, b);
    // Chroma rises from 0 through cMid at s = 0.8 to cMax at s = 1.
    let chroma: number;
    if (saturation < 0.8) {
      const t = 1.25 * saturation;
      const k1 = 0.8 * c0;
      chroma = (t * k1) / (1 - (1 - k1 / cMid) * t);
    } else {
      const t = 5 * (saturation - 0.8);
      const k1 = (0.2 * cMid ** 2 * 1.25 ** 2) / c0;
      chroma = cMid + (t * k1) / (1 - (1 - k1 / (cMax - cMid)) * t);
    }
    lab = [L, chroma * a, chroma * b];
  }
  return linearSrgbToHex(oklabToLinearSrgb(lab));
}

function isInSrgbGamut(linear: Vector): boolean {
  const epsilon = 1e-7;
  return linear.every((channel) => channel >= -epsilon && channel <= 1 + epsilon);
}

/** OKLCH (lightness 0-1, chroma, hue in degrees) to hex, reducing chroma until the color fits sRGB. */
function oklchToHex(lightness: number, chroma: number, hue: number): string {
  // Gamut mapping keeps the hue fixed, so its direction is computed once and scaled by chroma.
  const radians = ((((hue % 360) + 360) % 360) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const atChroma = (value: number): Vector => oklabToLinearSrgb([lightness, value * cos, value * sin]);
  const direct = atChroma(chroma);
  if (isInSrgbGamut(direct)) return linearSrgbToHex(direct);
  // The achromatic color is always in gamut, so it is the fallback when no bisection step fits.
  let linear = atChroma(0);
  let low = 0;
  let high = chroma;
  for (let index = 0; index < 20; index += 1) {
    const candidate = (low + high) / 2;
    const mapped = atChroma(candidate);
    if (isInSrgbGamut(mapped)) {
      low = candidate;
      linear = mapped;
    } else {
      high = candidate;
    }
  }
  return linearSrgbToHex(linear);
}

function finite(value: string, name: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`Pi theme color ${name} must be finite.`);
  return parsed;
}

/** True when Pi reads the value as a function color and never as a variable name. */
export function isPiFunctionColor(value: string): boolean {
  return /^ok(?:lch|hsl)\(/i.test(value);
}

/** Convert a Pi `oklch(L C H)` or `okhsl(H S L)` value to a six-digit hex color. */
export function piFunctionColorToHex(value: string): string {
  if (value.length > MAX_FUNCTION_COLOR_LENGTH) throw new Error('Pi theme color value is too long.');
  const oklch = OKLCH_PATTERN.exec(value);
  if (oklch) {
    const lightness = finite(oklch[1]!, 'lightness') / (oklch[2] ? 100 : 1);
    const chroma = finite(oklch[3]!, 'chroma');
    if (lightness < 0 || lightness > 1) throw new Error('Pi theme color lightness must be between 0 and 1.');
    if (chroma < 0) throw new Error('Pi theme color chroma must not be negative.');
    return oklchToHex(lightness, chroma, finite(oklch[4]!, 'hue'));
  }
  const okhsl = OKHSL_PATTERN.exec(value);
  if (okhsl) {
    const saturation = finite(okhsl[2]!, 'saturation') / (okhsl[3] ? 100 : 1);
    const lightness = finite(okhsl[4]!, 'lightness') / (okhsl[5] ? 100 : 1);
    if (saturation < 0 || saturation > 1) throw new Error('Pi theme color saturation must be between 0 and 1.');
    if (lightness < 0 || lightness > 1) throw new Error('Pi theme color lightness must be between 0 and 1.');
    return okhslToHex(finite(okhsl[1]!, 'hue'), saturation, lightness);
  }
  throw new Error(`Invalid Pi theme color value: ${value.slice(0, 64)}`);
}
