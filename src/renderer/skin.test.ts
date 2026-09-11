import { afterEach, describe, expect, it, vi } from 'vitest';
import { applySkin, applySkinDefinition, persistAppliedSkin, readStoredSkin, readStoredSkinDefinition, setSkinDefinitions, SKIN_STORAGE_KEY, SKIN_SNAPSHOT_STORAGE_KEY } from './skin';
import { builtInSkins, type SkinDefinition } from '../shared/skins';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.skin;
  delete document.documentElement.dataset.skinId;
  setSkinDefinitions(builtInSkins);
});

describe('skin application and boot persistence', () => {
  const pack: SkinDefinition = { id: 'pack:test-pack', base: 'dreamcore', origin: 'pack', name: 'Test pack', description: 'A declarative fixture.', version: '1.0.0', layout: { contentWidth: 840, contentPadding: 32, ruleContrast: 'strong' } };

  it('previews and restores a pack without conflating its identity with its component base', () => {
    setSkinDefinitions([...builtInSkins, pack]);
    applySkin(pack.id, { persist: false });
    expect(document.documentElement.dataset.skin).toBe('dreamcore');
    expect(document.documentElement.dataset.skinId).toBe(pack.id);
    expect(document.documentElement.style.getPropertyValue('--skin-content-width')).toBe('840px');
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBeNull();
    persistAppliedSkin(pack.id);
    const stored = readStoredSkinDefinition()!;
    expect(stored).toEqual(pack);
    setSkinDefinitions(builtInSkins);
    applySkinDefinition(stored, { persist: false });
    expect(document.documentElement.dataset.skinId).toBe(pack.id);
    applySkin(pack.id);
    expect(document.documentElement.dataset.skin).toBe('default');
    expect(document.documentElement.style.getPropertyValue('--skin-content-width')).toBe('');
    expect(localStorage.getItem(SKIN_SNAPSHOT_STORAGE_KEY)).toBeNull();
  });

  it('refuses malformed snapshots and repaints same-id pack updates', () => {
    setSkinDefinitions([...builtInSkins, pack]);
    applySkin(pack.id);
    localStorage.setItem(SKIN_SNAPSHOT_STORAGE_KEY, JSON.stringify({ ...pack, layout: { display: 'none' } }));
    expect(readStoredSkinDefinition()).toBeNull();
    setSkinDefinitions([...builtInSkins, { ...pack, layout: { contentWidth: 920 } }]);
    applySkin(pack.id);
    expect(document.documentElement.style.getPropertyValue('--skin-content-width')).toBe('920px');
  });
  it('applies and restores a built-in skin independently', () => {
    applySkin('dreamcore');

    expect(document.documentElement.dataset.skin).toBe('dreamcore');
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBe('dreamcore');
    expect(readStoredSkin()).toBe('dreamcore');
  });

  it('falls back safely for an unknown stored or requested skin', () => {
    localStorage.setItem(SKIN_STORAGE_KEY, 'external-script');
    expect(readStoredSkin()).toBe('default');
    expect(applySkin('missing')).toBe('default');
    expect(document.documentElement.dataset.skin).toBe('default');
  });

  it('does not persist previews and avoids repeat events or storage writes', () => {
    const listener = vi.fn();
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    window.addEventListener('fate-skin-change', listener);

    applySkin('dreamcore', { persist: false });
    applySkin('dreamcore', { persist: false });

    expect(listener).toHaveBeenCalledOnce();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(localStorage.getItem(SKIN_STORAGE_KEY)).toBeNull();
    window.removeEventListener('fate-skin-change', listener);
  });

  it('persists a saved preview without repeating the visual event', () => {
    const listener = vi.fn();
    window.addEventListener('fate-skin-change', listener);

    applySkin('dreamcore', { persist: false });
    persistAppliedSkin('dreamcore');

    expect(listener).toHaveBeenCalledOnce();
    expect(readStoredSkin()).toBe('dreamcore');
    window.removeEventListener('fate-skin-change', listener);
  });
});
