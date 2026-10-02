export interface ResizeBounds {
  minimum: number;
  maximum: number;
}

export function resizeBounds(minimum: number, maximum: number): ResizeBounds {
  const lower = Number.isFinite(minimum) ? Math.max(0, minimum) : 0;
  return { minimum: lower, maximum: Number.isFinite(maximum) ? Math.max(lower, maximum) : lower };
}

export function clampResizeValue(value: number, bounds: ResizeBounds): number {
  return Number.isNaN(value) ? bounds.minimum : Math.min(bounds.maximum, Math.max(bounds.minimum, value));
}
