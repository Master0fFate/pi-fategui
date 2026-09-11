import type { CodeFont, InterfaceFont } from '../shared/contracts/ipc';
import type { BuiltInCodeFont, BuiltInInterfaceFont, SkinFontDefinition } from '../shared/skinFonts';
import type { SkinDefinition } from '../shared/skins';
import { getSkinDefinitions } from './skin';

const notoSansFallback = '"Noto Sans Variable", "Noto Sans Hebrew Variable", "Noto Sans SC Variable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const notoCodeFallback = '"Noto Sans Mono Variable", "Noto Sans Variable", "Noto Sans Hebrew Variable", "Noto Sans SC Variable", ui-monospace, SFMono-Regular, Consolas, monospace';

const interfaceFamilies: Record<BuiltInInterfaceFont, string> = {
  'noto-sans': notoSansFallback,
  system: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", ${notoSansFallback}`,
  inter: `"Inter Variable", ${notoSansFallback}`,
  poppins: `"Poppins", ${notoSansFallback}`,
  montserrat: `"Montserrat Variable", ${notoSansFallback}`,
  'jetbrains-mono': `"JetBrains Mono Variable", ${notoCodeFallback}`,
};

const codeFamilies: Record<BuiltInCodeFont, string> = {
  'jetbrains-mono': `"JetBrains Mono Variable", ${notoCodeFallback}`,
  'noto-sans-mono': notoCodeFallback,
  'system-mono': `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, ${notoCodeFallback}`,
};

const optionalInterfaceFontLoaders: Partial<Record<BuiltInInterfaceFont, () => Promise<unknown>>> = {
  inter: () => import('@fontsource-variable/inter/wght.css'),
  montserrat: () => import('@fontsource-variable/montserrat/wght.css'),
  poppins: () => import('./styles/poppins.css'),
};
const optionalInterfaceFontLoads = new Map<BuiltInInterfaceFont, Promise<unknown>>();

function loadOptionalInterfaceFont(interfaceFont: BuiltInInterfaceFont): void {
  const loader = optionalInterfaceFontLoaders[interfaceFont];
  if (!loader) return;
  let pending = optionalInterfaceFontLoads.get(interfaceFont);
  if (!pending) {
    pending = loader();
    optionalInterfaceFontLoads.set(interfaceFont, pending);
  }
  void pending.catch(() => {
    // The bundled Noto/system stack remains a complete deterministic fallback.
  });
}

export const interfaceFontOptions: ReadonlyArray<{ value: InterfaceFont; label: string; detail: string }> = [
  { value: 'noto-sans', label: 'Noto Sans', detail: 'Global default · extended Unicode' },
  { value: 'system', label: 'System UI', detail: 'Native platform font · Noto fallback' },
  { value: 'inter', label: 'Inter', detail: 'Neutral and highly legible' },
  { value: 'poppins', label: 'Poppins', detail: 'Geometric and friendly' },
  { value: 'montserrat', label: 'Montserrat', detail: 'Structured and distinctive' },
  { value: 'jetbrains-mono', label: 'JetBrains Mono', detail: 'Technical monospace interface' },
];

export const codeFontOptions: ReadonlyArray<{ value: CodeFont; label: string; detail: string }> = [
  { value: 'jetbrains-mono', label: 'JetBrains Mono', detail: 'Bundled developer default' },
  { value: 'noto-sans-mono', label: 'Noto Sans Mono', detail: 'Unicode-forward monospace' },
  { value: 'system-mono', label: 'System Mono', detail: 'Native console stack · Noto fallback' },
];

type FontRole = 'interface' | 'code';
interface FontStatus { errors: Partial<Record<FontRole, string>>; fallback: Partial<Record<FontRole, string>>; pending: string[] }
let fontStatus: FontStatus = { errors: {}, fallback: {}, pending: [] };
export const getFontStatus = () => fontStatus;
export const subscribeFontStatus = (notify: () => void) => {
  window.addEventListener('fate-font-status', notify);
  return () => window.removeEventListener('fate-font-status', notify);
};
const loadedPackFonts = new Map<string, { data: string; face: FontFace; ready: Promise<void> }>();
const requested: Record<FontRole, string> = { interface: '', code: '' };
const familyName = (font: SkinFontDefinition) => `FateSkin_${font.id.replace(/[^a-z0-9]/gi, '_')}`;
function notifyFontStatus(next: FontStatus) {
  if (JSON.stringify(next) === JSON.stringify(fontStatus)) return;
  fontStatus = next;
  window.dispatchEvent(new Event('fate-font-status'));
}
function loadPackFont(font: SkinFontDefinition): Promise<void> {
  const existing = loadedPackFonts.get(font.id);
  if (existing?.data === font.data) return existing.ready;
  if (existing) document.fonts.delete(existing.face);
  const binary = Uint8Array.from(atob(font.data), (character) => character.charCodeAt(0));
  const face = new FontFace(familyName(font), binary, { weight: '100 900', style: 'normal' });
  const entry = { data: font.data, face, ready: Promise.resolve() };
  entry.ready = face.load().then(() => { if (loadedPackFonts.get(font.id) === entry) document.fonts.add(face); });
  loadedPackFonts.set(font.id, entry);
  return entry.ready;
}
export function getFontOptions(skins: readonly SkinDefinition[], role: FontRole) {
  return [ ...(role === 'interface' ? interfaceFontOptions : codeFontOptions), ...skins.flatMap((skin) => (skin.fonts ?? []).filter((font) => role === 'interface' || font.monospace).map((font) => ({ value: font.id, label: font.name, detail: `${skin.name} · bundled ${font.format.toUpperCase()}` }))) ];
}

export function applyFonts(interfaceFont: InterfaceFont, codeFont: CodeFont): void {
  const root = document.documentElement;
  const catalog = getSkinDefinitions().flatMap((skin) => skin.fonts ?? []);
  for (const [id, entry] of loadedPackFonts) {
    if (!catalog.some((font) => font.id === id && font.data === entry.data)) { document.fonts.delete(entry.face); loadedPackFonts.delete(id); }
  }
  for (const [role, id] of [['interface', interfaceFont], ['code', codeFont]] as const) {
    const previousRequest = requested[role];
    requested[role] = id;
    const custom = catalog.find((font) => font.id === id && (role === 'interface' || font.monospace));
    const fallbackId = role === 'interface' ? 'noto-sans' : 'jetbrains-mono';
    const fallbackFamily = role === 'interface' ? notoSansFallback : codeFamilies['jetbrains-mono'];
    const family = custom ? `"${familyName(custom)}", ${role === 'interface' ? notoSansFallback : notoCodeFallback}`
      : role === 'interface' ? interfaceFamilies[id as BuiltInInterfaceFont] ?? fallbackFamily : codeFamilies[id as BuiltInCodeFont] ?? fallbackFamily;
    const apply = (activeId: string, activeFamily: string) => {
      const key = role === 'interface' ? 'interfaceFont' : 'codeFont';
      const changed = root.dataset[key] !== activeId || root.style.getPropertyValue(`--font-${role}`) !== activeFamily;
      if (root.dataset[key] !== activeId) root.dataset[key] = activeId;
      if (root.style.getPropertyValue(`--font-${role}`) !== activeFamily) root.style.setProperty(`--font-${role}`, activeFamily);
      if (changed && role === 'code') window.dispatchEvent(new CustomEvent('fate-font-change', { detail: { interfaceFont: root.dataset.interfaceFont, codeFont: activeId } }));
    };
    const failed = Boolean(fontStatus.errors[role] && previousRequest === id && custom && loadedPackFonts.get(id)?.data === custom.data);
    apply(failed ? fallbackId : custom || !id.startsWith('skin-font:') ? id : fallbackId, failed ? fallbackFamily : family);
    if (previousRequest !== id) {
      const errors = { ...fontStatus.errors }; const fallback = { ...fontStatus.fallback };
      delete errors[role]; delete fallback[role];
      notifyFontStatus({ ...fontStatus, errors, fallback, pending: fontStatus.pending.filter((item) => item !== previousRequest) });
    }
    if (custom && (previousRequest !== id || loadedPackFonts.get(id)?.data !== custom.data)) {
      notifyFontStatus({ ...fontStatus, pending: [...new Set([...fontStatus.pending, id])] });
      const current = () => requested[role] === id && getSkinDefinitions().some((skin) => skin.fonts?.some((font) => font.id === id && font.data === custom.data));
      void Promise.resolve().then(() => loadPackFont(custom)).then(() => {
        if (!current()) return;
        const errors = { ...fontStatus.errors }; const fallback = { ...fontStatus.fallback };
        delete errors[role]; delete fallback[role];
        notifyFontStatus({ ...fontStatus, errors, fallback, pending: fontStatus.pending.filter((item) => item !== id) });
        window.dispatchEvent(new CustomEvent('fate-font-change', { detail: { interfaceFont: root.dataset.interfaceFont, codeFont: root.dataset.codeFont } }));
      }).catch(() => {
        if (!current()) return;
        apply(fallbackId, fallbackFamily);
        notifyFontStatus({ errors: { ...fontStatus.errors, [role]: `${custom.name} could not load; using ${fallbackId}.` }, fallback: { ...fontStatus.fallback, [role]: fallbackId }, pending: fontStatus.pending.filter((item) => item !== id) });
      });
    } else if (!custom && role === 'interface') loadOptionalInterfaceFont(id as BuiltInInterfaceFont);
  }
}
