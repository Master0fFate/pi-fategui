import { builtInSkins, type SkinDefinition } from '../../shared/skins';
import { skinSurfaceNames, type SkinSurfaceStyle } from '../../shared/skinStyles';
import { ensureSurfaceRules } from './surfaces';

const suffixes = { controlRadius: 'control-radius', surfaceRadius: 'surface-radius', padding: 'padding', rowHeight: 'row-height', fontSize: 'font-size', surface: 'background', border: 'border' } as const;
let written = new Set<string>();
export function applySurfaceStyles(skin: SkinDefinition, compact: boolean, compactSessions: boolean): void {
  const root = document.documentElement;
  ensureSurfaceRules();
  const enabled = skin.base === 'dreamcore' || Boolean(skin.styles);
  if (enabled) { if (root.dataset.skinStyled !== 'true') root.dataset.skinStyled = 'true'; }
  else if (root.dataset.skinStyled !== undefined) delete root.dataset.skinStyled;
  const next = new Set<string>();
  const base = builtInSkins.find((entry) => entry.id === skin.base);
  const baseline: SkinSurfaceStyle = { controlRadius: skin.layout?.controlRadius ?? 0, surfaceRadius: 0, padding: compact ? 6 : 10, rowHeight: compact ? 26 : 30, fontSize: compact ? 11 : 12, surface: 'canvas', border: 'border' };
  for (const surface of skinSurfaceNames) {
    const style: SkinSurfaceStyle = enabled ? { ...(surface === 'global' ? baseline : {}), ...base?.styles?.normal?.[surface], ...skin.styles?.normal?.[surface], ...(compact ? base?.styles?.compact?.[surface] : {}), ...(compact ? skin.styles?.compact?.[surface] : {}), ...(compactSessions ? base?.styles?.compactSessions?.[surface] : {}), ...(compactSessions ? skin.styles?.compactSessions?.[surface] : {}) } : {};
    for (const [key, suffix] of Object.entries(suffixes)) {
      const value = style[key as keyof SkinSurfaceStyle];
      if (value === undefined) continue;
      const name = `--skin-${surface}-${suffix}`;
      const css = typeof value === 'number' ? `${value}px` : key === 'surface' ? `var(--theme-${value})` : `var(--theme-${value === 'borderStrong' ? 'border-strong' : value === 'textSoft' ? 'text-soft' : 'border'})`;
      if (root.style.getPropertyValue(name) !== css) root.style.setProperty(name, css);
      next.add(name);
    }
  }
  for (const name of written) if (!next.has(name)) root.style.removeProperty(name);
  written = next;
}
