import { builtInSkins, resolveSkinId, skinDefinitionSchema, type SkinDefinition, type SkinId } from '../shared/skins';

export const SKIN_STORAGE_KEY = 'fate:skin:last-applied';
export const SKIN_SNAPSHOT_STORAGE_KEY = 'fate:skin:pack-snapshot';
let catalog: readonly SkinDefinition[] = builtInSkins;
let appliedSkin = builtInSkins[0]!;
export const getSkinDefinitions = () => catalog;
export const getAppliedSkin = () => appliedSkin;
export const subscribeSkinChanges = (notify: () => void) => {
  window.addEventListener('fate-skin-change', notify);
  return () => window.removeEventListener('fate-skin-change', notify);
};

export function setSkinDefinitions(skins: readonly SkinDefinition[]): void {
  catalog = skins.map((skin) => skinDefinitionSchema.parse(skin));
}

function resolveSkin(value: unknown): SkinDefinition {
  const id = resolveSkinId(value);
  return catalog.find((skin) => skin.id === id) ?? builtInSkins[0]!;
}

export function persistAppliedSkin(skinId: SkinId): void {
  const skin = resolveSkin(skinId);
  try {
    if (localStorage.getItem(SKIN_STORAGE_KEY) !== skin.id) localStorage.setItem(SKIN_STORAGE_KEY, skin.id);
    if (skin.origin === 'pack') {
      const snapshot = JSON.stringify(skin);
      if (localStorage.getItem(SKIN_SNAPSHOT_STORAGE_KEY) !== snapshot) localStorage.setItem(SKIN_SNAPSHOT_STORAGE_KEY, snapshot);
    } else if (localStorage.getItem(SKIN_SNAPSHOT_STORAGE_KEY) !== null) localStorage.removeItem(SKIN_SNAPSHOT_STORAGE_KEY);
  } catch {
    // The live skin remains usable if the bounded boot snapshot cannot be saved.
  }
}

export function readStoredSkin(): SkinId | null {
  try {
    const value = localStorage.getItem(SKIN_STORAGE_KEY);
    return value === null ? null : resolveSkinId(value);
  } catch { return null; }
}

export function readStoredSkinDefinition(): SkinDefinition | null {
  const id = readStoredSkin();
  if (id === null) return null;
  if (!id.startsWith('pack:')) return builtInSkins.find((skin) => skin.id === id) ?? builtInSkins[0]!;
  try {
    const raw = localStorage.getItem(SKIN_SNAPSHOT_STORAGE_KEY);
    if (!raw || raw.length > 1536 * 1024) return null;
    const skin = skinDefinitionSchema.parse(JSON.parse(raw));
    return skin.id === id ? skin : null;
  } catch { return null; }
}

export function applySkinDefinition(skin: SkinDefinition, options: { persist?: boolean | undefined } = {}): SkinId {
  const root = document.documentElement;
  const changed = root.dataset.skin !== skin.base || root.dataset.skinId !== skin.id
    || (appliedSkin !== skin && JSON.stringify(appliedSkin) !== JSON.stringify(skin));
  if (root.dataset.skin !== skin.base) root.dataset.skin = skin.base;
  if (root.dataset.skinId !== skin.id) root.dataset.skinId = skin.id;
  if (skin.origin === 'pack') {
    if (root.dataset.skinPack !== skin.id.slice(5)) root.dataset.skinPack = skin.id.slice(5);
  } else if (root.dataset.skinPack !== undefined) delete root.dataset.skinPack;
  const layout = skin.layout;
  const variables = {
    '--skin-content-width': layout?.contentWidth === undefined ? '' : `${layout.contentWidth}px`,
    '--skin-content-padding': layout?.contentPadding === undefined ? '' : `${layout.contentPadding}px`,
    '--skin-control-radius': layout?.controlRadius === undefined ? '' : `${layout.controlRadius}px`,
    '--skin-rule-color': layout?.ruleContrast === undefined ? '' : layout.ruleContrast === 'strong' ? 'var(--theme-border-strong)' : 'var(--theme-border)',
  };
  for (const [name, value] of Object.entries(variables)) {
    if (root.style.getPropertyValue(name) !== value) {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
  }
  if (changed) {
    appliedSkin = skin;
    window.dispatchEvent(new CustomEvent('fate-skin-change', { detail: { skinId: skin.id } }));
  }
  if (options.persist !== false) persistAppliedSkin(skin.id);
  return skin.id;
}

export function applySkin(value: unknown, options: { persist?: boolean | undefined } = {}): SkinId {
  return applySkinDefinition(resolveSkin(value), options);
}
