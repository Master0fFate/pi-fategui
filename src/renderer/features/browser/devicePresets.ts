import type { BrowserDeviceEmulation } from '../../../shared/contracts/browser';

export interface DevicePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const MIN_DEVICE_WIDTH = 220;
export const MIN_DEVICE_HEIGHT = 320;
export const MAX_DEVICE_WIDTH = 4000;
export const MAX_DEVICE_HEIGHT = 8000;

/** Chrome-style device toolbar presets. Sizes are CSS pixels, portrait. */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: 'responsive', label: 'Responsive', width: 390, height: 844 },
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667 },
  { id: 'iphone-14', label: 'iPhone 14', width: 390, height: 844 },
  { id: 'iphone-14-pro-max', label: 'iPhone 14 Pro Max', width: 430, height: 932 },
  { id: 'pixel-7', label: 'Pixel 7', width: 412, height: 915 },
  { id: 'galaxy-s23', label: 'Galaxy S23', width: 360, height: 780 },
  { id: 'ipad-mini', label: 'iPad Mini', width: 768, height: 1024 },
  { id: 'ipad-pro-11', label: 'iPad Pro 11\u2033', width: 834, height: 1194 },
];

export const DEFAULT_DEVICE_EMULATION: BrowserDeviceEmulation = {
  width: DEVICE_PRESETS[0]!.width,
  height: DEVICE_PRESETS[0]!.height,
  mobile: true,
  touch: true,
};

export function clampDeviceWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DEVICE_EMULATION.width;
  return Math.min(MAX_DEVICE_WIDTH, Math.max(MIN_DEVICE_WIDTH, Math.round(value)));
}

export function clampDeviceHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DEVICE_EMULATION.height;
  return Math.min(MAX_DEVICE_HEIGHT, Math.max(MIN_DEVICE_HEIGHT, Math.round(value)));
}

export function matchPreset(emulation: BrowserDeviceEmulation): DevicePreset {
  const rotated = emulation.width > emulation.height;
  return DEVICE_PRESETS.find((preset) => (
    (preset.width === emulation.width && preset.height === emulation.height)
    || (rotated && preset.width === emulation.height && preset.height === emulation.width)
  )) ?? DEVICE_PRESETS[0]!;
}
