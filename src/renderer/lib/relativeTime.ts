const relativeUnits = [
  { seconds: 365 * 24 * 60 * 60, suffix: 'y' },
  { seconds: 30 * 24 * 60 * 60, suffix: 'mo' },
  { seconds: 7 * 24 * 60 * 60, suffix: 'w' },
  { seconds: 24 * 60 * 60, suffix: 'd' },
  { seconds: 60 * 60, suffix: 'h' },
  { seconds: 60, suffix: 'm' },
] as const;

/** Compact, deterministic relative time for dense application chrome. */
export function formatRelativeTime(value: string | number | Date, now = Date.now()): string {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'unknown';
  const differenceSeconds = Math.round((timestamp - now) / 1_000);
  const absoluteSeconds = Math.abs(differenceSeconds);
  if (absoluteSeconds < 60) return 'now';
  const unit = relativeUnits.find((candidate) => absoluteSeconds >= candidate.seconds) ?? relativeUnits.at(-1)!;
  const amount = Math.max(1, Math.floor(absoluteSeconds / unit.seconds));
  return differenceSeconds > 0 ? `in ${amount}${unit.suffix}` : `${amount}${unit.suffix} ago`;
}
