const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function normalizeAgentSegment(value: string): string {
  const normalized = value.normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-')
    .slice(0, 48)
    .replace(/-+$/gu, '');
  if (!normalized || !SEGMENT.test(normalized) || normalized === 'root') return 'agent';
  return normalized;
}

export function childAgentPath(parentPath: string, segment: string): string {
  assertAgentPath(parentPath);
  const child = normalizeAgentSegment(segment);
  const path = `${parentPath}/${child}`;
  assertAgentPath(path);
  return path;
}

export function assertAgentPath(value: string): void {
  if (value === '/root') return;
  if (!value.startsWith('/root/')) throw new Error(`Invalid agent path ${value}.`);
  const segments = value.slice('/root/'.length).split('/');
  if (!segments.length || segments.some((segment) => !SEGMENT.test(segment) || segment === 'root')) {
    throw new Error(`Invalid agent path ${value}.`);
  }
}

export function agentPathDepth(value: string): number {
  assertAgentPath(value);
  return value === '/root' ? 0 : value.split('/').length - 2;
}

export function reserveAgentPath(
  parentPath: string,
  preferred: string,
  usedPaths: ReadonlySet<string>,
  usedHandles: ReadonlySet<string> = new Set(),
): { path: string; handle: string } {
  const base = normalizeAgentSegment(preferred);
  for (let index = 1; index <= 10_000; index += 1) {
    const handle = index === 1 ? base : `${base}-${index}`;
    const path = childAgentPath(parentPath, handle);
    if (!usedPaths.has(path) && !usedHandles.has(handle)) return { path, handle };
  }
  throw new Error(`Unable to reserve a unique child path below ${parentPath}.`);
}
