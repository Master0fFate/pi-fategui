import { describe, expect, it } from 'vitest';
import { hostPermissionMaximum, resolvePermission } from '../../src/core/security/PermissionPolicy';
import type { PermissionLevel } from '../../src/shared/contracts/ipc';
import { FakePiRuntimeService } from '../e2e/FakePiRuntimeService';

const levels: PermissionLevel[] = ['read-only', 'edit', 'full-access'];

describe('permission policy', () => {
  it('starts missing grants at edit and preserves explicit healthy local grants', () => {
    expect(resolvePermission({ trusted: true, store: { health: 'healthy' } })).toEqual({ allowed: true, level: 'edit' });
    for (const saved of levels) expect(resolvePermission({ trusted: true, store: { health: 'healthy', saved } })).toEqual({ allowed: true, level: saved });
  });

  it.each(['unavailable', 'corrupt'] as const)('refuses %s storage even for an explicit full-access request', (health) => {
    expect(resolvePermission({ trusted: true, store: { health }, requested: 'full-access' })).toEqual({ allowed: false, level: 'read-only', reason: 'permission-storage' });
  });

  it('never lets project trust or a client request raise host authority', () => {
    expect(resolvePermission({ trusted: false, store: { health: 'healthy', saved: 'full-access' }, requested: 'full-access' })).toEqual({ allowed: false, level: 'read-only', reason: 'untrusted-project' });
    expect(hostPermissionMaximum()).toBe('full-access');
    expect(hostPermissionMaximum({ mode: 'network' })).toBe('edit');
    expect(resolvePermission({ trusted: true, store: { health: 'healthy', saved: 'full-access' }, host: { mode: 'network' } })).toEqual({ allowed: true, level: 'edit' });
    expect(resolvePermission({ trusted: true, store: { health: 'healthy', saved: 'full-access' }, host: { mode: 'network', maximumLevel: 'full-access' } })).toEqual({ allowed: true, level: 'full-access' });
  });

  it.each([null, '', 'owner', 0])('refuses malformed configured authority rather than defaulting it: %s', (invalid) => {
    expect(() => Reflect.apply(hostPermissionMaximum, undefined, [{ maximumLevel: invalid }])).toThrow(/Invalid permission level/);
    expect(() => Reflect.apply(resolvePermission, undefined, [{ trusted: true, store: { health: 'healthy', saved: invalid } }])).toThrow(/Invalid permission level/);
    expect(() => Reflect.apply(resolvePermission, undefined, [{ trusted: true, store: { health: 'healthy' }, parent: invalid }])).toThrow(/Invalid permission level/);
  });

  it('intersects every requested, saved, parent and host level', () => {
    for (const requested of levels) for (const saved of levels) for (const parent of levels) for (const maximumLevel of levels) {
      const level = levels[Math.min(levels.indexOf(requested), levels.indexOf(parent), levels.indexOf(maximumLevel))];
      expect(resolvePermission({ trusted: true, requested, store: { health: 'healthy', saved }, parent, host: { maximumLevel } })).toEqual({ allowed: true, level });
    }
  });

  it('keeps E2E fake new and unseen sessions at edit, but preserves explicit grants', async () => {
    const fake = new FakePiRuntimeService();
    expect((await fake.openProject({ path: '/fake', name: 'fake', trusted: true })).permissionLevel).toBe('edit');
    expect((await fake.newSession()).permissionLevel).toBe('edit');
    expect((await fake.switchSession('unseen')).permissionLevel).toBe('edit');
    await fake.setPermissionLevel('full-access');
    await fake.switchSession('another');
    expect((await fake.switchSession('unseen')).permissionLevel).toBe('full-access');
    const fresh = await fake.newSession();
    expect(fresh.sessionId).not.toBe('unseen');
    expect(fresh.permissionLevel).toBe('edit');
    expect((await fake.switchSession('unseen')).permissionLevel).toBe('full-access');
    expect((await fake.openProject({ path: '/another-project', name: 'another', trusted: true })).permissionLevel).toBe('edit');
    expect((await fake.openProject({ path: '/fake', name: 'fake', trusted: true })).permissionLevel).toBe('full-access');
    const freshAgain = await fake.newSession();
    expect(freshAgain.sessionId).not.toBe(fresh.sessionId);
    expect(freshAgain.permissionLevel).toBe('edit');
    await fake.dispose();
  });
});
