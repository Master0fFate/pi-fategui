import type { PermissionLevel } from '../../shared/contracts/ipc';

/** Host-owned configuration, never a project/session/client-supplied grant. */
export interface PermissionHostPolicy {
  mode?: 'local' | 'network';
  maximumLevel?: PermissionLevel;
}

export type PermissionStoreState =
  | { health: 'healthy'; saved?: PermissionLevel }
  | { health: 'unavailable' | 'corrupt' };

export type PermissionDecision =
  | { allowed: true; level: PermissionLevel }
  | { allowed: false; level: 'read-only'; reason: 'untrusted-project' | 'permission-storage' };

export const permissionRank: Readonly<Record<PermissionLevel, number>> = {
  'read-only': 0,
  edit: 1,
  'full-access': 2,
};

function validLevel(level: PermissionLevel): PermissionLevel {
  if (level !== 'read-only' && level !== 'edit' && level !== 'full-access') throw new Error('Invalid permission level.');
  return level;
}

export function hostPermissionMaximum(host: PermissionHostPolicy = {}): PermissionLevel {
  if (host.mode !== undefined && host.mode !== 'local' && host.mode !== 'network') throw new Error('Invalid permission host mode.');
  return validLevel(host.maximumLevel === undefined ? (host.mode === 'network' ? 'edit' : 'full-access') : host.maximumLevel);
}

/** Pure intersection of an explicit grant (or Edit default) and every authority ceiling. */
export function resolvePermission(input: {
  trusted: boolean;
  store: PermissionStoreState;
  /** Only a host-authorized, explicitly confirmed request may supply this field. */
  requested?: PermissionLevel;
  parent?: PermissionLevel;
  host?: PermissionHostPolicy;
}): PermissionDecision {
  if (!input.trusted) return { allowed: false, level: 'read-only', reason: 'untrusted-project' };
  if (input.store.health !== 'healthy') return { allowed: false, level: 'read-only', reason: 'permission-storage' };
  const requested = validLevel(input.requested !== undefined ? input.requested : input.store.saved !== undefined ? input.store.saved : 'edit');
  const maximum = hostPermissionMaximum(input.host);
  const parent = validLevel(input.parent === undefined ? maximum : input.parent);
  const level = [requested, maximum, parent].reduce((left, right) => permissionRank[left] <= permissionRank[right] ? left : right);
  return { allowed: true, level };
}
