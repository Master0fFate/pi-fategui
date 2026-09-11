import { afterEach, describe, expect, it } from 'vitest';
import { builtInSkins, type SkinDefinition } from '../../shared/skins';
import { skinSurfaceNames } from '../../shared/skinStyles';
import { applySurfaceStyles } from './surfaceStyles';
import { skinSurfaceSelectors, surfaceRules } from './surfaces';

afterEach(() => { document.documentElement.style.cssText = ''; delete document.documentElement.dataset.skinStyled; });
describe('whole-UI surface style contract', () => {
  it('maps every creator surface, including tooltips, model picker, tasks, queue and music', () => {
    expect(Object.keys(skinSurfaceSelectors).sort()).toEqual(skinSurfaceNames.filter((name) => name !== 'global').sort());
    const rules = surfaceRules();
    for (const name of skinSurfaceNames) expect(rules).toContain(`--skin-${name}-control-radius`);
  });
  it('layers normal, compact and compact-session styles and clears them for Default', () => {
    const skin: SkinDefinition = { ...builtInSkins[1]!, styles: { normal: { music: { controlRadius: 3 } }, compact: { music: { controlRadius: 1 } }, compactSessions: { sidebar: { rowHeight: 28 } } } };
    applySurfaceStyles(skin, false, false);
    expect(document.documentElement.style.getPropertyValue('--skin-music-control-radius')).toBe('3px');
    applySurfaceStyles(skin, true, true);
    expect(document.documentElement.style.getPropertyValue('--skin-music-control-radius')).toBe('1px');
    expect(document.documentElement.style.getPropertyValue('--skin-sidebar-row-height')).toBe('28px');
    applySurfaceStyles(builtInSkins[0]!, false, false);
    expect(document.documentElement.dataset.skinStyled).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--skin-music-control-radius')).toBe('');
  });
});
